import type { Logger } from 'pino';
import { AuditAction, recordAudit } from '../audit.js';
import type { Db } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { MailUnavailableError, type MailProvider } from '../mail/provider.js';
import type { ReportStorage } from '../storage/storage.js';
import { dedupeKey, headerDate, headerMessageId, indexMessage } from './index-message.js';
import { acquireMailboxLease, MailboxNotFoundError, releaseMailboxLease, SyncInProgressError } from './sync.js';

/**
 * Entrega simulada (M4, D-006): copia el .eml original de un reporte a INBOX de un buzón del
 * laboratorio con IMAP APPEND y lo indexa igual que la sincronización. Es una simulación LOCAL
 * dentro del Dovecot del laboratorio: no envía correo a ningún sitio ni resuelve dominios.
 *
 * Idempotente: si el buzón ya tiene indexado un mensaje con la misma clave de deduplicación, no
 * hace otro APPEND y devuelve el existente. Usa el mismo arriendo que la sincronización.
 */

/** El reporte no existe o quien pide no lo puede ver (404, igual que GET /reports/{id}). */
export class ReportNotFoundError extends Error {
  constructor() {
    super('el reporte no existe');
    this.name = 'ReportNotFoundError';
  }
}

/** El reporte se pegó como texto: no hay un .eml que entregar (400). */
export class ReportNotEmlError extends Error {
  constructor() {
    super('el reporte no se subió como .eml');
    this.name = 'ReportNotEmlError';
  }
}

/** El archivo original del reporte ya no está en el almacenamiento (404). */
export class ReportFileMissingError extends Error {
  constructor() {
    super('el archivo del reporte ya no existe');
    this.name = 'ReportFileMissingError';
  }
}

export type DeliveryDeps = {
  db: Db;
  storage: ReportStorage;
  logger: Logger;
  institutionalDomains: readonly string[];
  openProvider: (address: string) => Promise<MailProvider>;
};

export type DeliveryInput = {
  mailboxId: string;
  reportId: string;
  /** Mismas reglas que GET /reports/{id}: un reportante solo ve los suyos (ownerId); los demás, todos. */
  ownerId?: string;
  actorId: string;
  requestId?: string;
};

/** Motivos de una entrega simulada que no se completó (metadata.reason). */
export type DeliveryFailureReason =
  | 'mailbox_not_found'
  | 'report_not_found'
  | 'not_eml'
  | 'invalid_body'
  | 'in_progress'
  | 'mail_unavailable'
  | 'file_missing'
  | 'unexpected';

type DeliveryAuditEntry = {
  /** Solo si es un UUID ya validado; nunca el texto que mandó el cliente. */
  mailboxId?: string;
  /** Solo si es un UUID ya validado. */
  reportId?: string;
  appended?: boolean;
  /** null: la entrega se completó. */
  reason: DeliveryFailureReason | null;
  actorId: string;
  requestId?: string;
};

/**
 * Evento de auditoría de la entrega simulada (siempre auditada, D-006). Solo IDs, conteos y el
 * motivo: nunca asunto, direcciones, Message-ID ni lo que mandó el cliente. Si la auditoría falla,
 * se registra en pino y quien llama sigue igual.
 */
async function auditDelivery(db: Pick<Db, 'auditEvent'>, logger: Logger, entry: DeliveryAuditEntry): Promise<void> {
  const metadata = {
    ...(entry.reportId ? { reportId: entry.reportId } : {}),
    appended: entry.appended ? 1 : 0,
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
  await recordAudit(db, {
    action: AuditAction.mailboxSimulatedDelivery,
    result: entry.reason ? 'failure' : 'success',
    targetType: 'mailbox',
    ...(entry.mailboxId ? { targetId: entry.mailboxId } : {}),
    actorId: entry.actorId,
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
    metadata,
  }).catch(() => logger.error('no se pudo registrar la auditoría de la entrega simulada'));
  if (entry.reason) logger.warn(metadata, 'falló la entrega simulada');
  else logger.info(metadata, 'entrega simulada');
}

/** Audita una entrega simulada rechazada (result failure, appended 0). La usa también la ruta. */
export async function auditDeliveryRejection(
  db: Pick<Db, 'auditEvent'>,
  logger: Logger,
  rejection: { mailboxId?: string; reportId?: string; reason: DeliveryFailureReason; actorId: string; requestId?: string },
): Promise<void> {
  await auditDelivery(db, logger, { ...rejection, appended: false });
}

function failureReason(error: unknown): DeliveryFailureReason {
  if (error instanceof MailboxNotFoundError) return 'mailbox_not_found';
  if (error instanceof ReportNotFoundError) return 'report_not_found';
  if (error instanceof ReportNotEmlError) return 'not_eml';
  if (error instanceof SyncInProgressError) return 'in_progress';
  if (error instanceof MailUnavailableError) return 'mail_unavailable';
  if (error instanceof ReportFileMissingError) return 'file_missing';
  return 'unexpected';
}

/** Devuelve el id del mensaje indexado y si hubo APPEND (false: ya estaba). */
export async function simulateDelivery(deps: DeliveryDeps, input: DeliveryInput): Promise<{ messageId: string; appended: boolean }> {
  const { db } = deps;
  const log = deps.logger.child({ mailboxId: input.mailboxId, reportId: input.reportId });

  let appended = false;
  let reason: DeliveryFailureReason | null = null;
  let messageId: string | undefined;
  let token: Date | null = null;
  // Todo queda dentro del try: también el buzón o el reporte inexistentes y el reporte pegado se auditan.
  try {
    const mailbox = await db.mailbox.findUnique({ where: { id: input.mailboxId }, select: { address: true } });
    if (!mailbox) throw new MailboxNotFoundError();
    const report = await db.report.findFirst({
      where: { id: input.reportId, ...(input.ownerId ? { userId: input.ownerId } : {}) },
      select: { source: true, storageKey: true },
    });
    if (!report) throw new ReportNotFoundError();
    if (report.source !== 'eml') throw new ReportNotEmlError();

    // El arriendo se toma después de las búsquedas: un rechazo no bloquea el buzón.
    token = await acquireMailboxLease(db, input.mailboxId);
    if (!token) throw new SyncInProgressError();

    // El original se lee del almacenamiento (D-038), nunca se recibe del cliente.
    let raw: Buffer;
    try {
      raw = await deps.storage.read(report.storageKey);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') throw new ReportFileMissingError();
      throw error;
    }

    const key = dedupeKey(headerMessageId(raw), raw)!;
    const existing = await db.indexedMessage.findUnique({ where: { mailboxId_dedupeKey: { mailboxId: input.mailboxId, dedupeKey: key } }, select: { id: true } });
    if (existing) {
      messageId = existing.id;
    } else {
      const provider = await deps.openProvider(mailbox.address);
      try {
        const { uid, uidValidity } = await provider.append('inbox', raw, headerDate(raw));
        appended = true;
        try {
          messageId = await indexMessage(db, { mailboxId: input.mailboxId, location: 'inbox', uid, uidValidity, dedupeKey: key, raw, institutionalDomains: deps.institutionalDomains });
        } catch (error) {
          // Ya indexado por otra vía (no debería pasar con el arriendo): se devuelve ese.
          if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
          messageId = (await db.indexedMessage.findUniqueOrThrow({ where: { mailboxId_dedupeKey: { mailboxId: input.mailboxId, dedupeKey: key } }, select: { id: true } })).id;
        }
      } finally {
        await provider.close().catch(() => {});
      }
    }
    return { messageId, appended };
  } catch (error) {
    reason = failureReason(error);
    throw error;
  } finally {
    if (token) await releaseMailboxLease(db, input.mailboxId, token).catch(() => log.error('no se pudo soltar el arriendo del buzón'));
    // Siempre auditada (D-006), también los rechazos.
    await auditDelivery(db, log, {
      mailboxId: input.mailboxId,
      reportId: input.reportId,
      appended,
      reason,
      actorId: input.actorId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
  }
}
