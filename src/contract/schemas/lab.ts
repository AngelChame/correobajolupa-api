import { z } from 'zod';
import { Attachment } from './attachments.js';
import { PageQuery, pageOf } from './common.js';
import { AuthResult, ReportLink } from './reports.js';

/** M4 · Laboratorio IMAP: 3 buzones sintéticos (D-015). */

export const MailboxLabel = z
  .enum(['student', 'teacher', 'staff'])
  .meta({ id: 'MailboxLabel', description: 'Estudiante, docente o administrativo (D-015).' });

export const SyncStatus = z.enum(['ok', 'error', 'never']).meta({ id: 'SyncStatus' });

export const Mailbox = z
  .object({
    id: z.uuid(),
    label: MailboxLabel,
    address: z.string(),
    lastSyncAt: z.iso.datetime().nullable(),
    lastSyncStatus: SyncStatus,
    messageCount: z.number().int(),
  })
  .meta({ id: 'Mailbox' });

export const MailboxList = z.object({ items: z.array(Mailbox) }).meta({ id: 'MailboxList' });

export const MessageLocation = z.enum(['inbox', 'quarantine']).meta({ id: 'MessageLocation' });

export const MessageSummary = z
  .object({
    id: z.uuid(),
    mailboxId: z.uuid(),
    location: MessageLocation,
    uid: z.number().int(),
    uidValidity: z.number().int(),
    subject: z.string().nullable().meta({ description: 'Texto de correo: el front lo escapa siempre.' }),
    fromAddress: z.string().nullable().meta({ description: 'Texto de correo: el front lo escapa siempre.' }),
    date: z.iso.datetime().nullable(),
    hasAttachments: z.boolean(),
    linksCount: z.number().int(),
    quarantined: z.boolean(),
  })
  .meta({ id: 'MessageSummary' });

export const MessageList = pageOf(MessageSummary, 'MessageList');

export const MessageDetail = MessageSummary.extend({
  links: z.array(ReportLink).meta({ description: 'Desactivados (D-017).' }),
  attachments: z.array(Attachment),
  authentication: z
    .object({ spf: AuthResult, dkim: AuthResult, dmarc: AuthResult })
    .nullable()
    .meta({ description: 'Solo informativo; nunca suma puntaje (D-016).' }),
}).meta({ id: 'MessageDetail' });

export const MessageQuery = PageQuery.extend({ mailboxId: z.uuid().optional(), location: MessageLocation.optional() });

export const SyncResult = z
  .object({
    mailboxId: z.uuid(),
    fetched: z.number().int(),
    added: z.number().int(),
    updated: z.number().int(),
    uidValidityChanged: z.boolean().meta({ description: 'P-12: cambió UIDVALIDITY; hay que resincronizar.' }),
    finishedAt: z.iso.datetime(),
  })
  .meta({ id: 'SyncResult' });

export const SimulatedDeliveryBody = z
  .object({ reportId: z.uuid().meta({ description: 'Reporte subido como `.eml`.' }) })
  .meta({ id: 'SimulatedDeliveryBody' });

export const SimulatedDeliveryResult = z.object({ message: MessageSummary }).meta({ id: 'SimulatedDeliveryResult' });
