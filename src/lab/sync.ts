import type { Logger } from 'pino';
import type { analyze } from '../analysis/index.js';
import { AuditAction, recordAudit } from '../audit.js';
import type { ImapLabConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { openImapProvider } from '../mail/imap.js';
import { MAIL_LOCATIONS, MailUnavailableError, type FolderListing, type FolderMessage, type MailLocation, type MailProvider } from '../mail/provider.js';
import { dedupeKey, indexMessage } from './index-message.js';

export { MailUnavailableError } from '../mail/provider.js';

/**
 * Sincronización de un buzón del laboratorio (M4; RF-05, RF-07, D-007, D-008): lee INBOX y
 * Cuarentena, indexa los mensajes nuevos con el analizador y deja el índice igual al servidor.
 *
 * - Un solo proceso por buzón a la vez: arriendo en mailboxes.sync_started_at (como la cola, D-054).
 * - UIDVALIDITY distinto en una carpeta: sus filas viejas se borran y se reindexa (D-008).
 * - Topes: maxMessages por buzón y budgetMs en total. Cada mensaje es su propia transacción, así
 *   que si se agota el tiempo lo ya indexado se conserva.
 * - Registros y auditoría: solo mailboxId, conteos y tiempos. Nunca asuntos, remitentes,
 *   direcciones, Message-ID ni contenido (P-18).
 */

/** Ya hay una sincronización de este buzón en curso (el paso 4 responde 409). */
export class SyncInProgressError extends Error {
  constructor() {
    super('ya hay una sincronización de este buzón en curso');
    this.name = 'SyncInProgressError';
  }
}

/** Se agotó el tiempo de la sincronización (el paso 4 responde 503). Lo ya indexado se conserva. */
export class SyncTimeoutError extends Error {
  constructor() {
    super('se agotó el tiempo de la sincronización');
    this.name = 'SyncTimeoutError';
  }
}

/** El buzón no existe (el paso 4 responde 404). */
export class MailboxNotFoundError extends Error {
  constructor() {
    super('el buzón no existe');
    this.name = 'MailboxNotFoundError';
  }
}

/** El arriendo vence a los 60 s: más que el presupuesto máximo (55 s), así nunca se pisa a sí mismo. */
const LEASE_SECONDS = 60;

export type SyncDeps = {
  db: Db;
  logger: Logger;
  institutionalDomains: readonly string[];
  /** Tope de un mensaje crudo (MAX_EML_BYTES): los más grandes no se indexan. */
  maxEmlBytes: number;
  /** SYNC_MAX_MESSAGES: mensajes por buzón (lo demás se ignora y se cuenta). */
  maxMessages: number;
  /** SYNC_BUDGET_MS: tiempo máximo de toda la sincronización. */
  budgetMs: number;
  /** Abre el proveedor de correo del buzón (IMAP en producción, uno en memoria en las pruebas). */
  openProvider: (address: string) => Promise<MailProvider>;
  /** Solo para pruebas: reemplaza al analizador. */
  analyzeFn?: typeof analyze;
};

export type SyncContext = { actorId?: string | null; requestId?: string };

export type SyncResult = {
  mailboxId: string;
  /** Mensajes que se bajaron del servidor (no los que ya se conocían). */
  fetched: number;
  added: number;
  updated: number;
  uidValidityChanged: boolean;
  finishedAt: Date;
};

type Counts = { fetched: number; added: number; updated: number; deleted: number; ignored: number; tooLarge: number };

/** Proveedor IMAP real a partir de la configuración del laboratorio. */
export function labProviderFactory(config: ImapLabConfig): (address: string) => Promise<MailProvider> {
  return async (address) => {
    if (!config.IMAP_LAB_PASSWORD) throw new MailUnavailableError('falta IMAP_LAB_PASSWORD');
    return openImapProvider({ host: config.IMAP_LAB_HOST, port: config.IMAP_LAB_PORT, user: address, password: config.IMAP_LAB_PASSWORD });
  };
}

export async function syncMailbox(deps: SyncDeps, mailboxId: string, context: SyncContext = {}): Promise<SyncResult> {
  const { db } = deps;
  const startedMs = Date.now();
  const log = deps.logger.child({ mailboxId });

  const mailbox = await db.mailbox.findUnique({ where: { id: mailboxId }, select: { id: true, address: true } });
  if (!mailbox) throw new MailboxNotFoundError();

  // Arriendo atómico: solo una sincronización por buzón. Uno vencido (proceso muerto) se retoma.
  const lease = await db.$queryRaw<{ sync_started_at: Date }[]>`
    UPDATE mailboxes SET sync_started_at = now()
    WHERE id = ${mailboxId}::uuid
      AND (sync_started_at IS NULL OR sync_started_at < now() - make_interval(secs => ${LEASE_SECONDS}::int))
    RETURNING sync_started_at`;
  const token = lease[0]?.sync_started_at;
  if (!token) throw new SyncInProgressError();

  const counts: Counts = { fetched: 0, added: 0, updated: 0, deleted: 0, ignored: 0, tooLarge: 0 };
  let uidValidityChanged = false;
  let ok = false;
  let reason: 'timeout' | 'mail_unavailable' | 'unexpected' | null = null;
  let provider: MailProvider | undefined;
  let finishedAt = new Date();

  const deadline = startedMs + deps.budgetMs;
  const remaining = () => deadline - Date.now();
  const checkTime = () => {
    if (remaining() <= 0) throw new SyncTimeoutError();
  };
  /** Una llamada al proveedor no puede pasar del presupuesto (si se cuelga, se abandona y se cierra). */
  const withDeadline = <T>(promise: Promise<T>): Promise<T> => {
    checkTime();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SyncTimeoutError()), remaining());
    });
    promise.catch(() => {}); // si pierde la carrera, su error no queda sin manejar
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  };

  try {
    provider = await withDeadline(deps.openProvider(mailbox.address));
    const listings = {} as Record<MailLocation, FolderListing>;
    for (const location of MAIL_LOCATIONS) listings[location] = await withDeadline(provider.listFolder(location));

    // D-008: si cambió el UIDVALIDITY de una carpeta, sus UID guardados ya no significan nada.
    for (const location of MAIL_LOCATIONS) {
      const current = BigInt(listings[location].uidValidity);
      const stale = await db.indexedMessage.deleteMany({ where: { mailboxId, location, uidValidity: { not: current } } });
      if (stale.count > 0) {
        uidValidityChanged = true;
        counts.deleted += stale.count;
      }
    }

    // Cuarentena primero (pocos mensajes y los que importan para M7); luego INBOX del más nuevo al más viejo.
    const all: { location: MailLocation; message: FolderMessage; uidValidity: number }[] = [];
    for (const location of ['quarantine', 'inbox'] as const) {
      const listing = listings[location];
      for (const message of [...listing.messages].sort((a, b) => b.uid - a.uid)) all.push({ location, message, uidValidity: listing.uidValidity });
    }
    const selected = all.slice(0, deps.maxMessages);
    counts.ignored = all.length - selected.length;

    const known = new Map(
      (await db.indexedMessage.findMany({ where: { mailboxId }, select: { id: true, dedupeKey: true, location: true, uid: true, uidValidity: true } })).map((r) => [r.dedupeKey, r]),
    );
    const handled = new Set<string>();

    for (const { location, message, uidValidity } of selected) {
      checkTime();
      let raw: Buffer | null = null;
      let key = dedupeKey(message.messageId);
      if (key === null) {
        // Sin Message-ID hay que bajar el mensaje para calcular su clave (sha256:).
        raw = await withDeadline(provider.fetchRaw(location, message.uid, deps.maxEmlBytes));
        if (!raw) {
          counts.tooLarge++;
          continue;
        }
        counts.fetched++;
        key = dedupeKey(null, raw)!;
      }
      // Dos copias con la misma clave en el servidor: cuenta la primera.
      if (handled.has(key)) continue;
      handled.add(key);

      const row = known.get(key);
      if (row) {
        if (row.location !== location || row.uid !== BigInt(message.uid) || row.uidValidity !== BigInt(uidValidity)) {
          await db.indexedMessage.update({ where: { id: row.id }, data: { location, uid: BigInt(message.uid), uidValidity: BigInt(uidValidity) } });
          counts.updated++;
        }
        continue;
      }

      raw ??= await withDeadline(provider.fetchRaw(location, message.uid, deps.maxEmlBytes));
      if (!raw) {
        counts.tooLarge++;
        continue;
      }
      if (message.messageId !== null) counts.fetched++;
      checkTime();
      try {
        await indexMessage(db, {
          mailboxId,
          location,
          uid: message.uid,
          uidValidity,
          dedupeKey: key,
          raw,
          institutionalDomains: deps.institutionalDomains,
          ...(deps.analyzeFn ? { analyzeFn: deps.analyzeFn } : {}),
        });
        counts.added++;
      } catch (error) {
        // Otra fila ya tiene esa clave o ese UID (no debería pasar con el arriendo): se salta.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
        throw error;
      }
    }

    // Lo que ya no está en el servidor sale del índice. Las claves de mensajes ignorados por el tope
    // también cuentan como presentes; si alguno ignorado no tenía Message-ID, no se borra ningún sha256:.
    const ignoredMessages = all.slice(deps.maxMessages).map((s) => s.message);
    const present = new Set(handled);
    for (const { message } of all) {
      const k = dedupeKey(message.messageId);
      if (k) present.add(k);
    }
    const keepHashed = ignoredMessages.some((m) => dedupeKey(m.messageId) === null);
    const gone = [...known.values()].filter((r) => !present.has(r.dedupeKey) && !(keepHashed && r.dedupeKey.startsWith('sha256:'))).map((r) => r.id);
    if (gone.length > 0) counts.deleted += (await db.indexedMessage.deleteMany({ where: { id: { in: gone } } })).count;

    ok = true;
  } catch (error) {
    reason = error instanceof SyncTimeoutError ? 'timeout' : error instanceof MailUnavailableError ? 'mail_unavailable' : 'unexpected';
    throw error;
  } finally {
    await provider?.close().catch(() => {});
    const finished = await db.$queryRaw<{ last_sync_at: Date | null }[]>`
      UPDATE mailboxes
      SET last_sync_status = ${ok ? 'ok' : 'error'}::sync_status,
          last_sync_at = CASE WHEN ${ok} THEN now() ELSE last_sync_at END,
          sync_started_at = CASE WHEN sync_started_at = ${token} THEN NULL ELSE sync_started_at END
      WHERE id = ${mailboxId}::uuid
      RETURNING last_sync_at`;
    const durationMs = Date.now() - startedMs;
    const metadata = { ...counts, uidValidityChanged, durationMs, ...(reason ? { reason } : {}) };
    await recordAudit(db, {
      action: AuditAction.mailboxSync,
      result: ok ? 'success' : 'failure',
      targetType: 'mailbox',
      targetId: mailboxId,
      actorId: context.actorId ?? null,
      ...(context.requestId ? { requestId: context.requestId } : {}),
      metadata,
    }).catch(() => log.error('no se pudo registrar la auditoría de la sincronización'));
    if (ok) log.info(metadata, 'buzón sincronizado');
    else log.warn(metadata, 'falló la sincronización del buzón');
    if (ok) finishedAt = finished[0]?.last_sync_at ?? new Date();
  }

  return { mailboxId, fetched: counts.fetched, added: counts.added, updated: counts.updated, uidValidityChanged, finishedAt };
}
