import type { Logger } from 'pino';
import type { Db } from '../db/client.js';

/**
 * Arriendo de un buzón del laboratorio (como la cola, D-054): una marca en
 * mailboxes.sync_started_at que solo se toma si está libre o vencida. Lo usan la sincronización,
 * la entrega simulada y la cuarentena (M7): nunca dos de ellas a la vez sobre el mismo buzón.
 */

/** El buzón ya está ocupado por una sincronización u otra acción (las rutas responden 409). */
export class SyncInProgressError extends Error {
  constructor() {
    super('ya hay una sincronización de este buzón en curso');
    this.name = 'SyncInProgressError';
  }
}

/** El arriendo vence a los 60 s: más que el presupuesto máximo (55 s), así nunca se pisa a sí mismo. */
const LEASE_SECONDS = 60;

/**
 * Toma el arriendo del buzón: devuelve su marca, o null si otro proceso lo tiene. Uno vencido
 * (proceso muerto) se retoma.
 */
export async function acquireMailboxLease(db: Db, mailboxId: string): Promise<Date | null> {
  const lease = await db.$queryRaw<{ sync_started_at: Date }[]>`
    UPDATE mailboxes SET sync_started_at = now()
    WHERE id = ${mailboxId}::uuid
      AND (sync_started_at IS NULL OR sync_started_at < now() - make_interval(secs => ${LEASE_SECONDS}::int))
    RETURNING sync_started_at`;
  return lease[0]?.sync_started_at ?? null;
}

/** Suelta el arriendo solo si sigue siendo el nuestro (no el de otro proceso que lo retomó). */
export async function releaseMailboxLease(db: Db, mailboxId: string, token: Date): Promise<void> {
  await db.$executeRaw`
    UPDATE mailboxes SET sync_started_at = NULL WHERE id = ${mailboxId}::uuid AND sync_started_at = ${token}`;
}

/**
 * Ejecuta fn con el arriendo del buzón tomado y lo suelta siempre al terminar (también si fn
 * falla). Si el buzón está ocupado lanza SyncInProgressError sin llamar a fn. Un fallo al soltar
 * no cambia el resultado: se registra y el arriendo vence solo a los 60 s.
 */
export async function withMailboxLease<T>(db: Db, mailboxId: string, logger: Logger, fn: () => Promise<T>): Promise<T> {
  const token = await acquireMailboxLease(db, mailboxId);
  if (!token) throw new SyncInProgressError();
  try {
    return await fn();
  } finally {
    await releaseMailboxLease(db, mailboxId, token).catch(() => logger.error('no se pudo soltar el arriendo del buzón'));
  }
}
