import type { z } from 'zod';
import { defangHost } from '../analysis/links.js';
import { Mailbox, MessageDetail, MessageSummary } from '../contract/schemas/lab.js';
import type { IndexedMessage, IndexedMessageAttachment, IndexedMessageLink, Mailbox as MailboxRow } from '../generated/prisma/client.js';
import { defangLooseText } from '../viewer/text.js';

/**
 * Formas del contrato para el laboratorio (M4). Se validan con el esquema antes de salir: si una
 * fila no cumple, falla con 500 en vez de mandar datos mal formados. Nunca incluyen rule_ids,
 * la clave de deduplicación ni bytes de nada. subject, fromAddress y fileName son texto del
 * correo: salen tal cual y el front los escapa.
 */

export function toMailboxDto(row: Pick<MailboxRow, 'id' | 'label' | 'address' | 'lastSyncAt' | 'lastSyncStatus'>, messageCount: number): z.infer<typeof Mailbox> {
  return Mailbox.parse({
    id: row.id,
    label: row.label,
    address: row.address,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: row.lastSyncStatus,
    messageCount,
  });
}

/** Columnas de MessageSummary (sin dedupe_key, reply_to, rule_ids, autenticación ni prioridad). */
export const MESSAGE_SUMMARY_SELECT = {
  id: true,
  mailboxId: true,
  location: true,
  uid: true,
  uidValidity: true,
  subject: true,
  fromAddress: true,
  date: true,
  hasAttachments: true,
  linksCount: true,
} as const;

type SummaryRow = Pick<IndexedMessage, keyof typeof MESSAGE_SUMMARY_SELECT>;

function summary(row: SummaryRow): z.infer<typeof MessageSummary> {
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    location: row.location,
    // UID y UIDVALIDITY son de 32 bits sin signo (CHECK en la base): caben en un número de JS.
    uid: Number(row.uid),
    uidValidity: Number(row.uidValidity),
    subject: row.subject,
    fromAddress: row.fromAddress,
    date: row.date?.toISOString() ?? null,
    hasAttachments: row.hasAttachments,
    linksCount: row.linksCount,
    quarantined: row.location === 'quarantine',
  };
}

export function toMessageSummaryDto(row: SummaryRow): z.infer<typeof MessageSummary> {
  return MessageSummary.parse(summary(row));
}

export const MESSAGE_DETAIL_SELECT = {
  ...MESSAGE_SUMMARY_SELECT,
  authentication: true,
  links: { select: { displayText: true, defangedUrl: true, domain: true }, orderBy: { position: 'asc' } },
  attachments: { orderBy: { position: 'asc' } },
} as const;

type DetailRow = SummaryRow &
  Pick<IndexedMessage, 'authentication'> & {
    links: Pick<IndexedMessageLink, 'displayText' | 'defangedUrl' | 'domain'>[];
    attachments: IndexedMessageAttachment[];
  };

export function toMessageDetailDto(row: DetailRow): z.infer<typeof MessageDetail> {
  return MessageDetail.parse({
    ...summary(row),
    // La base guarda texto y dominio crudos (para correlacionar en M5); salen desactivados (D-017).
    links: row.links.map((l) => ({
      displayText: l.displayText === null ? null : defangLooseText(l.displayText),
      defangedUrl: l.defangedUrl,
      domain: l.domain === null ? null : defangHost(l.domain),
    })),
    // Al sincronizar no se escanea: unsupported con su motivo, nunca "limpio" (D-018).
    attachments: row.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      declaredType: a.declaredType,
      detectedType: a.detectedType,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
      scanStatus: a.scanStatus,
      scanDetail: a.scanDetail,
      scannedAt: a.scannedAt?.toISOString() ?? null,
    })),
    authentication: row.authentication ?? null,
  });
}
