import { setTimeout as wait } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { parseFeed, type FeedName } from './parse.js';

const OPENPHISH = 'https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt';
const URLHAUS = 'https://urlhaus-api.abuse.ch/v2/files/exports/';
// `urls_recent.txt` de URLhaus ronda los 5,3 MB; 5 MiB exactos lo descartarían.
export const MAX_BYTES = 10 * 1024 * 1024;
const LOCK_KEY = 4_215_002;

/** Solo categorías seguras para registro: nunca mensajes, claves ni direcciones. */
export type FeedFailureReason =
  | 'http_error'
  | 'no_body'
  | 'too_large'
  | 'decode_error'
  | 'invalid_format'
  | 'empty_feed'
  | 'too_many_entries'
  | 'network_error'
  | 'auth_not_configured'
  | 'unknown';

class FeedFetchError extends Error {
  constructor(readonly code: FeedFailureReason) {
    super(code);
    this.name = 'FeedFetchError';
  }
}

type Diagnosis = { httpStatus?: number; bytes?: number; phase?: 'fetch' | 'parse' };

/** Convierte errores conocidos en categorías; cualquier otro texto queda fuera de los logs. */
export function feedFailureReason(error: unknown): FeedFailureReason {
  if (error instanceof FeedFetchError) return error.code;
  switch ((error as Error)?.message) {
    case 'feed_auth_not_configured': return 'auth_not_configured';
    case 'feed_invalid_format': return 'invalid_format';
    case 'feed_empty': return 'empty_feed';
    case 'feed_too_many_entries': return 'too_many_entries';
    default: return 'unknown';
  }
}

/** Los errores de red se identifican por su tipo, no por su mensaje (puede contener la URL). */
function errorName(error: unknown): string | undefined {
  const name = (error as Error)?.name;
  return typeof name === 'string' && name.length <= 64 ? name : undefined;
}

export type FeedOptions = {
  openPhishEnabled: boolean;
  urlhausAuthKey?: string;
  intervalMs: number;
  signal: AbortSignal;
  /** Solo para pruebas: nunca se consulta una fuente real. */
  fetchFn?: typeof fetch;
};

async function readBounded(response: Response, diag: Diagnosis): Promise<string> {
  diag.httpStatus = response.status;
  if (!response.ok) throw new FeedFetchError('http_error');
  if (!response.body) throw new FeedFetchError('no_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        diag.bytes = length;
        throw new FeedFetchError('too_large');
      }
      chunks.push(value);
    }
    diag.bytes = length;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new FeedFetchError('decode_error');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * La descarga y el reemplazo comparten candado transaccional: si hay dos workers, solo uno
 * actualiza una fuente. Si falla la red o el parser, los hashes anteriores siguen intactos.
 * El registro incluye categoría, código HTTP y bytes, pero nunca URL, clave, contenido
 * ni mensaje de excepción (puede contener la dirección completa).
 */
export async function refreshFeed(db: Db, logger: Logger, source: FeedName, fetchFn: typeof fetch = fetch, key?: string): Promise<boolean> {
  if (source === 'URLhaus' && !key) throw new Error('feed_auth_not_configured');
  return db.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS ok`;
    if (!lock?.ok) return false;
    let entries;
    const diag: Diagnosis = { phase: 'fetch' };
    try {
      const endpoint = source === 'OpenPhish' ? OPENPHISH : `${URLHAUS}${encodeURIComponent(key!)}/urls_recent.txt`;
      const response = await fetchFn(endpoint, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      const text = await readBounded(response, diag);
      diag.phase = 'parse';
      entries = parseFeed(text, source);
    } catch (error) {
      // Error de descarga/validación: no se toca el snapshot anterior.
      await tx.feedSource.upsert({
        where: { source },
        create: { source, lastErrorAt: new Date() },
        update: { lastErrorAt: new Date() },
      });
      const known = feedFailureReason(error);
      const reason = known !== 'unknown' ? known : diag.phase === 'fetch' ? 'network_error' : 'unknown';
      logger.warn({
        source,
        errorCode: 'feed_unavailable',
        reason,
        httpStatus: diag.httpStatus,
        bytes: diag.bytes,
        errName: known === 'unknown' ? errorName(error) : undefined,
      }, 'feed no disponible');
      return false;
    }
    // Un error de escritura sale de la transacción y revierte todo, incluida la eliminación.
    const now = new Date();
    await tx.feedSource.upsert({
      where: { source },
      create: { source, lastGoodAt: now, lastErrorAt: null },
      update: { lastGoodAt: now, lastErrorAt: null },
    });
    await tx.feedEntry.deleteMany({ where: { source } });
    for (let i = 0; i < entries.length; i += 1000) {
      await tx.feedEntry.createMany({ data: entries.slice(i, i + 1000).map((entry) => ({ source, ...entry })) });
    }
    logger.info({ source, count: entries.length }, 'feed de reputación actualizado');
    return true;
  }, { maxWait: 10_000, timeout: 180_000 });
}

/** Sin clave o sin permiso explícito no se solicitan feeds externos. */
export async function runFeedSchedule(db: Db, logger: Logger, options: FeedOptions): Promise<void> {
  while (!options.signal.aborted) {
    for (const [source, enabled] of [
      ['OpenPhish', options.openPhishEnabled],
      ['URLhaus', Boolean(options.urlhausAuthKey)],
    ] as const) {
      if (!enabled) continue;
      try {
        await refreshFeed(db, logger, source, options.fetchFn, options.urlhausAuthKey);
      } catch (error) {
        logger.warn({
          source,
          errorCode: 'feed_unavailable',
          reason: feedFailureReason(error),
          errName: errorName(error),
        }, 'feed no disponible');
      }
    }
    await wait(options.intervalMs, undefined, { signal: options.signal }).catch(() => undefined);
  }
}
