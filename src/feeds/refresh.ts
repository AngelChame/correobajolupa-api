import { setTimeout as wait } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { parseFeed, type FeedName } from './parse.js';

const OPENPHISH = 'https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt';
const URLHAUS = 'https://urlhaus-api.abuse.ch/v2/files/exports/';
const MAX_BYTES = 5 * 1024 * 1024;
const LOCK_KEY = 4_215_002;

export type FeedOptions = {
  openPhishEnabled: boolean;
  urlhausAuthKey?: string;
  intervalMs: number;
  signal: AbortSignal;
  /** Solo para pruebas: nunca se consulta una fuente real. */
  fetchFn?: typeof fetch;
};

async function readBounded(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error('feed_http_error');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('feed_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/**
 * La descarga y el reemplazo comparten candado transaccional: si hay dos workers, solo uno
 * actualiza una fuente. Si falla la red o el parser, los hashes anteriores siguen intactos.
 * No se registra URL, respuesta, cabecera, clave ni mensaje de excepción.
 */
export async function refreshFeed(db: Db, logger: Logger, source: FeedName, fetchFn: typeof fetch = fetch, key?: string): Promise<boolean> {
  if (source === 'URLhaus' && !key) throw new Error('feed_auth_not_configured');
  return db.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS ok`;
    if (!lock?.ok) return false;
    let entries;
    try {
      const endpoint = source === 'OpenPhish' ? OPENPHISH : `${URLHAUS}${encodeURIComponent(key!)}/urls_recent.txt`;
      const response = await fetchFn(endpoint, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      entries = parseFeed(await readBounded(response), source);
    } catch (error) {
      // Error de descarga/validación: no se toca el snapshot anterior.
      await tx.feedSource.upsert({
        where: { source },
        create: { source, lastErrorAt: new Date() },
        update: { lastErrorAt: new Date() },
      });
      logger.warn({ source, errorCode: 'feed_unavailable', errName: (error as Error)?.name }, 'feed no disponible');
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
    if (options.openPhishEnabled) {
      try { await refreshFeed(db, logger, 'OpenPhish', options.fetchFn); }
      catch { logger.warn({ source: 'OpenPhish', errorCode: 'feed_unavailable' }, 'feed no disponible'); }
    }
    if (options.urlhausAuthKey) {
      try { await refreshFeed(db, logger, 'URLhaus', options.fetchFn, options.urlhausAuthKey); }
      catch { logger.warn({ source: 'URLhaus', errorCode: 'feed_unavailable' }, 'feed no disponible'); }
    }
    await wait(options.intervalMs, undefined, { signal: options.signal }).catch(() => undefined);
  }
}
