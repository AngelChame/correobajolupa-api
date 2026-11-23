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

/** Devuelve el id del mensaje indexado y si hubo APPEND (false: ya estaba). */
export async function simulateDelivery(deps: DeliveryDeps, input: DeliveryInput): Promise<{ messageId: string; appended: boolean }> {
  const { db } = deps;
  const log = deps.logger.child({ mailboxId: input.mailboxId, reportId: input.reportId });

  const mailbox = await db.mailbox.findUnique({ where: { id: input.mailboxId }, select: { address: true } });
  if (!mailbox) throw new MailboxNotFoundError();
  const report = await db.report.findFirst({
    where: { id: input.reportId, ...(input.ownerId ? { userId: input.ownerId } : {}) },
    select: { source: true, storageKey: true },
  });
  if (!report) throw new ReportNotFoundError();
  if (report.source !== 'eml') throw new ReportNotEmlError();

  let appended = false;
  let reason: string | null = null;
  let messageId: string | undefined;
  const token = await acquireMailboxLease(db, input.mailboxId);
  try {
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
    reason =
      error instanceof SyncInProgressError
        ? 'in_progress'
        : error instanceof MailUnavailableError
          ? 'mail_unavailable'
          : error instanceof ReportFileMissingError
            ? 'file_missing'
            : 'unexpected';
    throw error;
  } finally {
    if (token) await releaseMailboxLease(db, input.mailboxId, token).catch(() => log.error('no se pudo soltar el arriendo del buzón'));
    // Siempre auditada. Solo IDs y conteos: nunca asunto, direcciones ni Message-ID.
    const metadata = { reportId: input.reportId, appended: appended ? 1 : 0, ...(reason ? { reason } : {}) };
    await recordAudit(db, {
      action: AuditAction.mailboxSimulatedDelivery,
      result: reason ? 'failure' : 'success',
      targetType: 'mailbox',
      targetId: input.mailboxId,
      actorId: input.actorId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      metadata,
    }).catch(() => log.error('no se pudo registrar la auditoría de la entrega simulada'));
    if (reason) log.warn(metadata, 'falló la entrega simulada');
    else log.info(metadata, 'entrega simulada');
  }
}
