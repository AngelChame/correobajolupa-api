import type { Logger } from 'pino';
import { AuditAction, recordAudit } from '../audit.js';
import type { Db } from '../db/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ActionType, MessageLocation } from '../generated/prisma/enums.js';
import { createDeadline, DeadlineExceededError, type Deadline } from '../lab/deadline.js';
import { dedupeKey } from '../lab/index-message.js';
import { SyncInProgressError, withMailboxLease } from '../lab/lease.js';
import { MailUnavailableError, MoveUnconfirmedError, type MailLocation, type MailProvider } from '../mail/provider.js';

/**
 * Cuarentena y restauración de mensajes del laboratorio (M7; D-008, D-013, P-12 a P-15).
 *
 * Cada mensaje aprobado por una persona pasa, en este orden y sin saltarse nada, por:
 *  1. ¿Está en el índice? Si no: not_found.
 *  2. ¿Ya está en Cuarentena según el índice? already_quarantined, sin tocar el IMAP.
 *  3. Reverificación con el servidor ANTES de mover (D-008): UIDVALIDITY igual al guardado y el
 *     UID sigue siendo el mismo mensaje (Message-ID o, si la clave es sha256:, el SHA-256 del crudo).
 *  4. MOVE, con evidencia: el UID y el UIDVALIDITY nuevos salen del COPYUID del servidor.
 *  5. En UNA transacción: índice, acción `done` con su ubicación original y nueva, y auditoría.
 *
 * Idempotente (única por incidente, mensaje y tipo), un buzón a la vez (arriendo), una conexión
 * por buzón y por petición, presupuesto de tiempo total y un resultado por mensaje (P-14).
 * Los detalles de cada resultado son textos fijos: nunca llevan nada del servidor ni del correo.
 * Registros y auditoría: solo IDs y resultados; nunca asunto, remitente, direcciones,
 * Message-ID ni UID (P-18).
 */

export type QuarantineOutcome = 'quarantined' | 'already_quarantined' | 'uidvalidity_mismatch' | 'not_found' | 'error';
export type RestoreOutcome = 'restored' | 'already_restored' | 'uidvalidity_mismatch' | 'not_found' | 'error';

export type QuarantineResult = { messageId: string; outcome: QuarantineOutcome; actionId: string | null; detail: string | null };
export type RestoreResult = { actionId: string; outcome: RestoreOutcome; restoreActionId: string | null; detail: string | null };

/** Textos fijos de los resultados (los ve la persona; no llevan datos del servidor ni del correo). */
export const DETAIL = {
  notIndexed: 'El mensaje no está en el índice del laboratorio.',
  notOnServer: 'Ese UID ya no existe o ahora es otro mensaje; sincroniza el buzón. No se movió.',
  uidValidity: 'El UIDVALIDITY de la carpeta cambió; sincroniza el buzón. No se movió.',
  busy: 'Buzón ocupado: hay una sincronización u otra acción en curso. No se movió.',
  timeout: 'Tiempo agotado; no se movió.',
  unavailable: 'El servidor IMAP del laboratorio no respondió; no se movió.',
  unconfirmed: 'No se pudo confirmar el movimiento; sincroniza el buzón antes de reintentar.',
  dbAfterMove: 'Movido; resincroniza el buzón.',
  restoredBefore: 'El mensaje ya se restauró en este incidente; no se vuelve a poner en cuarentena en el mismo incidente.',
  movedOutside: 'El mensaje ya se puso en cuarentena en este incidente y volvió a INBOX por fuera de la plataforma; no se repite en el mismo incidente.',
} as const;

/** Textos fijos de la restauración. */
export const RESTORE_DETAIL = {
  notOnServer: 'Ese UID de Cuarentena ya no existe o ahora es otro mensaje; sincroniza el buzón. No se restauró.',
  uidValidity: 'El UIDVALIDITY de Cuarentena cambió; sincroniza el buzón. No se restauró.',
  busy: 'Buzón ocupado: hay una sincronización u otra acción en curso. No se restauró.',
  timeout: 'Tiempo agotado; no se restauró.',
  unavailable: 'El servidor IMAP del laboratorio no respondió; no se restauró.',
  unconfirmed: DETAIL.unconfirmed,
  dbAfterMove: DETAIL.dbAfterMove,
} as const;

/** Código corto del fallo que se guarda en la acción `failed` (nunca texto del servidor). */
type FailureCode = 'uidvalidity_mismatch' | 'not_found' | 'unconfirmed' | 'mail_unavailable' | 'timeout' | 'db_after_move';

/** El incidente no existe (404). */
export class IncidentNotFoundError extends Error {
  constructor() {
    super('el incidente no existe');
    this.name = 'IncidentNotFoundError';
  }
}

/** El incidente no está en analyzing ni en contained (409). */
export class IncidentStateError extends Error {
  constructor() {
    super('el incidente no admite cuarentena en su estado actual');
    this.name = 'IncidentStateError';
  }
}

/** La acción no existe o no es una cuarentena hecha (404). */
export class ActionNotFoundError extends Error {
  constructor() {
    super('la acción no existe');
    this.name = 'ActionNotFoundError';
  }
}

/** Estados del incidente en los que se puede poner en cuarentena. */
const QUARANTINE_STATUSES = ['analyzing', 'contained'] as const;

export type QuarantineDeps = {
  db: Db;
  logger: Logger;
  /** MAX_EML_BYTES: tope para bajar el crudo cuando la clave es sha256:. */
  maxEmlBytes: number;
  /** SYNC_BUDGET_MS: tiempo máximo de toda la petición. */
  budgetMs: number;
  openProvider: (address: string) => Promise<MailProvider>;
};

export type ActionContext = { actorId: string; requestId?: string };

type Tx = Prisma.TransactionClient;

type IndexRow = { id: string; mailboxId: string; dedupeKey: string; location: MessageLocation; uid: bigint; uidValidity: bigint };
const INDEX_SELECT = { id: true, mailboxId: true, dedupeKey: true, location: true, uid: true, uidValidity: true } as const;

type Location = { location: MailLocation; uid: number; uidValidity: number };

/** Cierra la conexión sin esperar más de 2 s (una conexión colgada no retiene la respuesta). */
async function closeQuietly(provider: MailProvider | undefined): Promise<void> {
  if (!provider) return;
  await Promise.race([provider.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000).unref())]);
}

/**
 * Comprueba que el UID sigue siendo el mismo mensaje: misma clave de deduplicación. Si la clave
 * es sha256: hay que bajar el crudo (con tope). El texto del correo solo se compara, nunca se usa
 * para armar órdenes.
 */
async function sameMessage(provider: MailProvider, deadline: Deadline, location: MailLocation, uid: number, announced: string | null, storedKey: string, maxBytes: number): Promise<boolean> {
  if (!storedKey.startsWith('sha256:')) return announced !== null && dedupeKey(announced) === storedKey;
  if (announced !== null && dedupeKey(announced) !== null) return false;
  const raw = await deadline.run(provider.fetchRaw(location, uid, maxBytes));
  return raw !== null && dedupeKey(null, raw) === storedKey;
}

/** Marca el buzón para resincronizar (UIDVALIDITY distinto, D-008): last_sync_status = error. */
async function markForResync(db: Db, mailboxId: string): Promise<void> {
  await db.mailbox.update({ where: { id: mailboxId }, data: { lastSyncStatus: 'error' } });
}

type ActionKey = { incidentId: string; messageId: string; type: ActionType };

/** Guarda (o reutiliza) la fila de la acción como `failed` con su código. Devuelve su id. */
async function saveFailed(tx: Tx, key: ActionKey, base: { mailboxId: string; dedupeKey: string; original: Location; actorId: string }, code: FailureCode): Promise<string> {
  const original = { originalLocation: base.original.location, originalUid: BigInt(base.original.uid), originalUidValidity: BigInt(base.original.uidValidity) };
  const row = await tx.quarantineAction.upsert({
    where: { incidentId_messageId_type: key },
    create: { ...key, mailboxId: base.mailboxId, dedupeKey: base.dedupeKey, status: 'failed', failureCode: code, actorId: base.actorId, ...original },
    // Solo se llega aquí con una fila `failed` (las `done` se resuelven antes): se reintenta en la misma.
    update: { status: 'failed', failureCode: code, actorId: base.actorId, attempts: { increment: 1 }, updatedAt: new Date(), ...original },
    select: { id: true },
  });
  return row.id;
}

/** Guarda la acción `done` con la ubicación original y la nueva (creándola o reutilizando la `failed`). */
async function saveDone(tx: Tx, key: ActionKey, base: { mailboxId: string; dedupeKey: string; original: Location; actorId: string }, moved: Location): Promise<string> {
  const data = {
    status: 'done' as const,
    failureCode: null,
    actorId: base.actorId,
    originalLocation: base.original.location,
    originalUid: BigInt(base.original.uid),
    originalUidValidity: BigInt(base.original.uidValidity),
    newLocation: moved.location,
    newUid: BigInt(moved.uid),
    newUidValidity: BigInt(moved.uidValidity),
  };
  const row = await tx.quarantineAction.upsert({
    where: { incidentId_messageId_type: key },
    create: { ...key, mailboxId: base.mailboxId, dedupeKey: base.dedupeKey, ...data },
    update: { ...data, attempts: { increment: 1 }, updatedAt: new Date() },
    select: { id: true },
  });
  return row.id;
}

type AuditFields = { incidentId: string; actionId: string | null; outcome: string; mailboxId?: string };

/** Auditoría por mensaje: solo incidentId, actionId, outcome y mailboxId (nunca datos del correo). */
async function auditMessage(db: Pick<Db, 'auditEvent'>, action: (typeof AuditAction)['quarantineExecute' | 'quarantineRestore'], ctx: ActionContext, messageId: string, success: boolean, f: AuditFields): Promise<void> {
  await recordAudit(db, {
    action,
    result: success ? 'success' : 'failure',
    actorId: ctx.actorId,
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    targetType: 'message',
    targetId: messageId,
    metadata: { incidentId: f.incidentId, actionId: f.actionId, outcome: f.outcome, ...(f.mailboxId ? { mailboxId: f.mailboxId } : {}) },
  });
}

const toLocation = (row: { location: MessageLocation; uid: bigint; uidValidity: bigint }): Location => ({ location: row.location, uid: Number(row.uid), uidValidity: Number(row.uidValidity) });

// ---------------------------------------------------------------------------------------------
// Cuarentena

export async function quarantineMessages(deps: QuarantineDeps, incidentId: string, messageIds: string[], ctx: ActionContext): Promise<QuarantineResult[]> {
  const { db } = deps;
  const log = deps.logger.child({ incidentId });
  const deadline = createDeadline(deps.budgetMs);

  const incident = await db.incident.findUnique({ where: { id: incidentId }, select: { status: true } });
  if (!incident) throw new IncidentNotFoundError();
  if (!(QUARANTINE_STATUSES as readonly string[]).includes(incident.status)) throw new IncidentStateError();

  const results = new Map<string, QuarantineResult>();
  const mailboxOf = new Map<string, string>();
  const audited = new Set<string>();

  /** Resultado sin acción en la base: se audita solo (fuera de una transacción). */
  const settle = async (messageId: string, outcome: QuarantineOutcome, actionId: string | null, detail: string | null) => {
    results.set(messageId, { messageId, outcome, actionId, detail });
    const mailboxId = mailboxOf.get(messageId);
    await auditMessage(db, AuditAction.quarantineExecute, ctx, messageId, outcome === 'quarantined' || outcome === 'already_quarantined', {
      incidentId,
      actionId,
      outcome,
      ...(mailboxId ? { mailboxId } : {}),
    }).catch(() => log.error('no se pudo registrar la auditoría de la cuarentena'));
    audited.add(messageId);
  };

  /** Resultado fallido con su fila `failed` y su auditoría en una transacción. */
  const settleFailed = async (row: IndexRow, outcome: QuarantineOutcome, code: FailureCode, detail: string) => {
    let actionId: string | null = null;
    try {
      actionId = await db.$transaction(async (tx) => {
        const id = await saveFailed(tx, { incidentId, messageId: row.id, type: 'quarantine' }, { mailboxId: row.mailboxId, dedupeKey: row.dedupeKey, original: toLocation(row), actorId: ctx.actorId }, code);
        await auditMessage(tx, AuditAction.quarantineExecute, ctx, row.id, false, { incidentId, actionId: id, outcome, mailboxId: row.mailboxId });
        return id;
      });
      audited.add(row.id);
    } catch {
      log.error({ mailboxId: row.mailboxId }, 'no se pudo registrar la acción fallida');
    }
    results.set(row.id, { messageId: row.id, outcome, actionId, detail });
    if (!audited.has(row.id)) await settle(row.id, outcome, actionId, detail);
  };

  // 1 y 2: índice y acciones previas de este incidente (sin IMAP).
  const rows = await db.indexedMessage.findMany({ where: { id: { in: messageIds } }, select: INDEX_SELECT });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) mailboxOf.set(r.id, r.mailboxId);
  const doneOf = (messageId: string, type: ActionType) =>
    db.quarantineAction.findFirst({ where: { incidentId, messageId, type, status: 'done' }, select: { id: true } });

  /** Clasifica sin IMAP (pasos 2 y 6); devuelve true si hace falta ir al servidor. */
  const classify = async (row: IndexRow): Promise<boolean> => {
    const done = await doneOf(row.id, 'quarantine');
    if (row.location === 'quarantine') {
      await settle(row.id, 'already_quarantined', done?.id ?? null, null);
      return false;
    }
    if (done) {
      // Ya hubo una cuarentena hecha en este incidente y el mensaje está en INBOX otra vez.
      await settle(row.id, 'error', done.id, (await doneOf(row.id, 'restore')) ? DETAIL.restoredBefore : DETAIL.movedOutside);
      return false;
    }
    return true;
  };

  const pendingByMailbox = new Map<string, string[]>();
  for (const id of messageIds) {
    const row = byId.get(id);
    if (!row) {
      await settle(id, 'not_found', null, DETAIL.notIndexed);
      continue;
    }
    if (await classify(row)) pendingByMailbox.set(row.mailboxId, [...(pendingByMailbox.get(row.mailboxId) ?? []), id]);
  }

  // 3 a 5: un buzón a la vez, con su arriendo y una sola conexión.
  let opened = 0;
  let unreachable = 0;
  for (const [mailboxId, ids] of pendingByMailbox) {
    const failRest = async (rest: string[], detail: string) => {
      for (const id of rest) if (!results.has(id)) await settle(id, 'error', null, detail);
    };
    if (deadline.expired()) {
      await failRest(ids, DETAIL.timeout);
      continue;
    }
    const mailbox = await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId }, select: { address: true } });
    try {
      await withMailboxLease(db, mailboxId, log, async () => {
        let provider: MailProvider | undefined;
        try {
          try {
            provider = await deadline.run(deps.openProvider(mailbox.address));
          } catch (error) {
            if (error instanceof DeadlineExceededError) return failRest(ids, DETAIL.timeout);
            unreachable++;
            return failRest(ids, DETAIL.unavailable);
          }
          opened++;
          let broken = false;
          for (const id of ids) {
            if (deadline.expired()) {
              await settle(id, 'error', null, DETAIL.timeout);
              continue;
            }
            if (broken) {
              // Se cortó la conexión de este buzón: el resto no se intenta (una conexión por buzón).
              await settle(id, 'error', null, DETAIL.unavailable);
              continue;
            }
            // Se relee dentro del arriendo: lo que vio la clasificación pudo cambiar.
            const row = await db.indexedMessage.findUnique({ where: { id }, select: INDEX_SELECT });
            if (!row) {
              await settle(id, 'not_found', null, DETAIL.notIndexed);
              continue;
            }
            if (!(await classify(row))) continue;
            const outcome = await quarantineOne(deps, provider, deadline, row, incidentId, ctx, log);
            if (outcome.connectionLost) broken = true;
            if (outcome.failed) await settleFailed(row, outcome.failed.outcome, outcome.failed.code, outcome.failed.detail);
            else if (outcome.done) {
              results.set(row.id, { messageId: row.id, outcome: 'quarantined', actionId: outcome.done.actionId, detail: null });
              audited.add(row.id);
            } else {
              await settle(row.id, 'error', null, DETAIL.dbAfterMove);
            }
          }
        } finally {
          await closeQuietly(provider);
        }
      });
    } catch (error) {
      if (!(error instanceof SyncInProgressError)) throw error;
      await failRest(ids, DETAIL.busy);
    }
  }

  // 503 solo si nadie respondió y no se intentó nada: todos los buzones que hacían falta fallaron al abrir.
  if (pendingByMailbox.size > 0 && opened === 0 && unreachable === pendingByMailbox.size) throw new MailUnavailableError();

  const ordered = messageIds.map((id) => results.get(id)!);
  log.info({ counts: countOutcomes(ordered) }, 'cuarentena terminada');
  return ordered;
}

function countOutcomes(results: { outcome: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return counts;
}

type OneOutcome = {
  connectionLost?: boolean;
  failed?: { outcome: QuarantineOutcome; code: FailureCode; detail: string };
  done?: { actionId: string };
  dbAfterMove?: boolean;
};

/** Reverifica, mueve con evidencia y registra un mensaje que está en INBOX. */
async function quarantineOne(deps: QuarantineDeps, provider: MailProvider, deadline: Deadline, row: IndexRow, incidentId: string, ctx: ActionContext, log: Logger): Promise<OneOutcome> {
  const { db } = deps;
  const uid = Number(row.uid);

  // 3. Reverificación antes de mover (D-008).
  let same: boolean;
  try {
    const current = await deadline.run(provider.inspect('inbox', uid));
    if (current.uidValidity !== Number(row.uidValidity)) {
      await markForResync(db, row.mailboxId).catch(() => log.error({ mailboxId: row.mailboxId }, 'no se pudo marcar el buzón para resincronizar'));
      return { failed: { outcome: 'uidvalidity_mismatch', code: 'uidvalidity_mismatch', detail: DETAIL.uidValidity } };
    }
    same = current.found && (await sameMessage(provider, deadline, 'inbox', uid, current.messageId, row.dedupeKey, deps.maxEmlBytes));
  } catch (error) {
    if (error instanceof DeadlineExceededError) return { connectionLost: true, failed: { outcome: 'error', code: 'timeout', detail: DETAIL.timeout } };
    return { connectionLost: true, failed: { outcome: 'error', code: 'mail_unavailable', detail: DETAIL.unavailable } };
  }
  if (!same) return { failed: { outcome: 'not_found', code: 'not_found', detail: DETAIL.notOnServer } };

  // 4. MOVE con evidencia (COPYUID). Si se cortó o no hay evidencia, no se sabe si se movió.
  let moved: Location;
  try {
    const r = await deadline.run(provider.move('inbox', 'quarantine', uid));
    moved = { location: 'quarantine', uid: r.uid, uidValidity: r.uidValidity };
  } catch (error) {
    const lost = error instanceof DeadlineExceededError || error instanceof MailUnavailableError;
    if (!(error instanceof MoveUnconfirmedError) && !lost) throw error;
    return { connectionLost: lost, failed: { outcome: 'error', code: 'unconfirmed', detail: DETAIL.unconfirmed } };
  }

  // 5. Índice, acción y auditoría en una transacción.
  try {
    const actionId = await db.$transaction(async (tx) => {
      // Condicional: si la fila cambió mientras tanto, la transacción se deshace.
      const { count } = await tx.indexedMessage.updateMany({
        where: { id: row.id, location: 'inbox', uid: row.uid, uidValidity: row.uidValidity },
        data: { location: 'quarantine', uid: BigInt(moved.uid), uidValidity: BigInt(moved.uidValidity) },
      });
      if (count !== 1) throw new Error('el índice cambió durante la cuarentena');
      const id = await saveDone(tx, { incidentId, messageId: row.id, type: 'quarantine' }, { mailboxId: row.mailboxId, dedupeKey: row.dedupeKey, original: toLocation(row), actorId: ctx.actorId }, moved);
      await auditMessage(tx, AuditAction.quarantineExecute, ctx, row.id, true, { incidentId, actionId: id, outcome: 'quarantined', mailboxId: row.mailboxId });
      return id;
    });
    log.info({ mailboxId: row.mailboxId, actionId, outcome: 'quarantined' }, 'mensaje en cuarentena');
    return { done: { actionId } };
  } catch {
    // El servidor ya lo movió, pero la base no lo registró: se dice tal cual y se deja constancia.
    log.error({ mailboxId: row.mailboxId, outcome: 'error', reason: 'db_after_move' }, 'mensaje movido sin registrar; hay que resincronizar el buzón');
    await markForResync(db, row.mailboxId).catch(() => {});
    return { dbAfterMove: true };
  }
}

// ---------------------------------------------------------------------------------------------
// Restauración

export async function restoreAction(deps: QuarantineDeps, actionId: string, ctx: ActionContext): Promise<RestoreResult> {
  const { db } = deps;
  const deadline = createDeadline(deps.budgetMs);
  const action = await db.quarantineAction.findUnique({ where: { id: actionId } });
  if (!action || action.type !== 'quarantine' || action.status !== 'done' || action.newLocation === null || action.newUid === null || action.newUidValidity === null) throw new ActionNotFoundError();
  const log = deps.logger.child({ incidentId: action.incidentId, actionId });
  const key: ActionKey = { incidentId: action.incidentId, messageId: action.messageId, type: 'restore' };
  const from: Location = { location: 'quarantine', uid: Number(action.newUid), uidValidity: Number(action.newUidValidity) };
  const base = { mailboxId: action.mailboxId, dedupeKey: action.dedupeKey, original: from, actorId: ctx.actorId };

  const finish = async (outcome: RestoreOutcome, restoreActionId: string | null, detail: string | null): Promise<RestoreResult> => {
    await auditMessage(db, AuditAction.quarantineRestore, ctx, action.messageId, outcome === 'restored' || outcome === 'already_restored', {
      incidentId: action.incidentId,
      actionId,
      outcome,
      mailboxId: action.mailboxId,
    }).catch(() => log.error('no se pudo registrar la auditoría de la restauración'));
    return { actionId, outcome, restoreActionId, detail };
  };
  const fail = async (outcome: RestoreOutcome, code: FailureCode, detail: string): Promise<RestoreResult> => {
    let id: string | null = null;
    try {
      id = await db.$transaction(async (tx) => {
        const saved = await saveFailed(tx, key, base, code);
        await auditMessage(tx, AuditAction.quarantineRestore, ctx, action.messageId, false, { incidentId: action.incidentId, actionId, outcome, mailboxId: action.mailboxId });
        return saved;
      });
    } catch {
      log.error('no se pudo registrar la restauración fallida');
      return finish(outcome, null, detail);
    }
    return { actionId, outcome, restoreActionId: id, detail };
  };

  const already = await db.quarantineAction.findUnique({ where: { incidentId_messageId_type: key }, select: { id: true, status: true } });
  if (already?.status === 'done') return finish('already_restored', already.id, null);

  const mailbox = await db.mailbox.findUniqueOrThrow({ where: { id: action.mailboxId }, select: { address: true } });
  try {
    return await withMailboxLease(db, action.mailboxId, log, async () => {
      // Se relee dentro del arriendo: otra petición pudo restaurarlo justo antes.
      const again = await db.quarantineAction.findUnique({ where: { incidentId_messageId_type: key }, select: { id: true, status: true } });
      if (again?.status === 'done') return finish('already_restored', again.id, null);

      let provider: MailProvider | undefined;
      try {
        try {
          provider = await deadline.run(deps.openProvider(mailbox.address));
        } catch (error) {
          if (error instanceof DeadlineExceededError) return finish('error', null, RESTORE_DETAIL.timeout);
          // No se contactó al servidor y no se intentó nada: 503 (la ruta lo audita).
          throw new MailUnavailableError();
        }

        // Reverificación antes de mover (D-008): UIDVALIDITY de Cuarentena y el mismo mensaje.
        let same: boolean;
        try {
          const current = await deadline.run(provider.inspect('quarantine', from.uid));
          if (current.uidValidity !== from.uidValidity) {
            await markForResync(db, action.mailboxId).catch(() => {});
            return fail('uidvalidity_mismatch', 'uidvalidity_mismatch', RESTORE_DETAIL.uidValidity);
          }
          same = current.found && (await sameMessage(provider, deadline, 'quarantine', from.uid, current.messageId, action.dedupeKey, deps.maxEmlBytes));
        } catch (error) {
          if (error instanceof DeadlineExceededError) return fail('error', 'timeout', RESTORE_DETAIL.timeout);
          return fail('error', 'mail_unavailable', RESTORE_DETAIL.unavailable);
        }
        if (!same) return fail('not_found', 'not_found', RESTORE_DETAIL.notOnServer);

        let moved: Location;
        try {
          const r = await deadline.run(provider.move('quarantine', 'inbox', from.uid));
          moved = { location: 'inbox', uid: r.uid, uidValidity: r.uidValidity };
        } catch (error) {
          if (!(error instanceof MoveUnconfirmedError || error instanceof DeadlineExceededError || error instanceof MailUnavailableError)) throw error;
          return fail('error', 'unconfirmed', RESTORE_DETAIL.unconfirmed);
        }

        try {
          const restoreId = await db.$transaction(async (tx) => {
            // El índice se busca por buzón y clave: su id pudo cambiar si la sincronización lo reindexó.
            await tx.indexedMessage.updateMany({
              where: { mailboxId: action.mailboxId, dedupeKey: action.dedupeKey },
              data: { location: 'inbox', uid: BigInt(moved.uid), uidValidity: BigInt(moved.uidValidity) },
            });
            const id = await saveDone(tx, key, base, moved);
            await auditMessage(tx, AuditAction.quarantineRestore, ctx, action.messageId, true, { incidentId: action.incidentId, actionId, outcome: 'restored', mailboxId: action.mailboxId });
            return id;
          });
          log.info({ mailboxId: action.mailboxId, restoreActionId: restoreId, outcome: 'restored' }, 'mensaje restaurado');
          return { actionId, outcome: 'restored' as const, restoreActionId: restoreId, detail: null };
        } catch {
          log.error({ mailboxId: action.mailboxId, outcome: 'error', reason: 'db_after_move' }, 'mensaje restaurado sin registrar; hay que resincronizar el buzón');
          await markForResync(db, action.mailboxId).catch(() => {});
          return finish('error', null, RESTORE_DETAIL.dbAfterMove);
        }
      } finally {
        await closeQuietly(provider);
      }
    });
  } catch (error) {
    if (error instanceof SyncInProgressError) return finish('error', null, RESTORE_DETAIL.busy);
    throw error;
  }
}
