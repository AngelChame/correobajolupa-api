import { createHash } from 'node:crypto';
import { analyze } from '../analysis/index.js';
import type { Db } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { MailLocation } from '../mail/provider.js';

/** Los adjuntos del laboratorio no se escanean al sincronizar (D-018: nunca "limpio"). */
export const LAB_SCAN_DETAIL = 'No se escanea al sincronizar el laboratorio.';

/** Un Message-ID más largo que esto se guarda por su SHA-256 (la columna admite hasta 1000). */
const MAX_MESSAGE_ID_KEY = 900;

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/**
 * Clave de deduplicación (RF-07): el Message-ID sin espacios y en minúsculas; si no trae,
 * "sha256:" + el SHA-256 del mensaje crudo. Mover el mensaje de carpeta no la cambia.
 * Sin Message-ID hace falta el crudo; si tampoco hay crudo devuelve null.
 */
export function dedupeKey(messageId: string | null | undefined, raw?: Uint8Array): string | null {
  const normalized = (messageId ?? '').replace(/\s+/g, '').toLowerCase();
  if (normalized !== '') {
    return normalized.length > MAX_MESSAGE_ID_KEY ? `message-id-sha256:${sha256(normalized)}` : normalized;
  }
  return raw ? `sha256:${sha256(raw)}` : null;
}

/**
 * Valor de un encabezado (el primero con ese nombre), o null. Solo mira el bloque de encabezados
 * (hasta 64 KiB) y une las líneas plegadas. El texto es del correo: nunca se interpreta.
 */
const HEADER_PATTERNS = {
  date: /^date:[ \t]*(.+?)[ \t]*$/im,
  'message-id': /^message-id:[ \t]*(.+?)[ \t]*$/im,
} as const;

function headerValue(raw: Uint8Array, name: keyof typeof HEADER_PATTERNS): string | null {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  const end = [crlf, lf].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? buf.length;
  const headers = buf.subarray(0, Math.min(end, 64 * 1024)).toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  return HEADER_PATTERNS[name].exec(headers)?.[1] ?? null;
}

/** Fecha del encabezado Date (la del mensaje, no la de llegada). null si falta o no se entiende. */
export function headerDate(raw: Uint8Array): Date | null {
  const value = headerValue(raw, 'date');
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Message-ID del encabezado, o null si no trae. */
export function headerMessageId(raw: Uint8Array): string | null {
  return headerValue(raw, 'message-id');
}

export type IndexInput = {
  mailboxId: string;
  location: MailLocation;
  uid: number;
  uidValidity: number;
  dedupeKey: string;
  raw: Buffer;
  institutionalDomains: readonly string[];
  /** Solo para pruebas: reemplaza al analizador. */
  analyzeFn?: typeof analyze;
};

/**
 * Analiza un mensaje del laboratorio con el mismo analizador de los reportes y lo guarda con sus
 * enlaces y adjuntos en UNA transacción. Nada de bytes del correo en la base: solo lo extraído.
 * Asunto, remitente, Reply-To y nombres de archivo son texto hostil: se guardan tal cual y se
 * escapan al mostrarlos. Devuelve el id de la fila nueva.
 */
export async function indexMessage(db: Db, input: IndexInput): Promise<string> {
  const result = await (input.analyzeFn ?? analyze)(input.raw, 'eml', { institutionalDomains: input.institutionalDomains });
  return db.$transaction(async (tx) => {
    const message = await tx.indexedMessage.create({
      data: {
        mailboxId: input.mailboxId,
        dedupeKey: input.dedupeKey,
        location: input.location,
        uid: BigInt(input.uid),
        uidValidity: BigInt(input.uidValidity),
        subject: result.subject,
        fromAddress: result.fromAddress,
        replyTo: result.replyTo,
        date: headerDate(input.raw),
        hasAttachments: result.attachments.length > 0,
        linksCount: result.links.length,
        authentication: result.authentication ?? Prisma.DbNull,
        rulesVersion: result.rulesVersion,
        priority: result.priority,
        ruleIds: result.findings.map((f) => f.ruleId),
      },
      select: { id: true },
    });
    if (result.links.length > 0) {
      await tx.indexedMessageLink.createMany({
        data: result.links.map((l) => ({
          messageId: message.id,
          position: l.position,
          displayText: l.displayText,
          normalizedUrl: l.normalizedUrl,
          defangedUrl: l.defangedUrl,
          domain: l.domain,
        })),
      });
    }
    if (result.attachments.length > 0) {
      // Solo metadatos: el contenido del adjunto nunca llega a la base (D-056.1).
      await tx.indexedMessageAttachment.createMany({
        data: result.attachments.map((a) => ({
          messageId: message.id,
          position: a.position,
          fileName: a.fileName,
          declaredType: a.declaredType,
          detectedType: a.detectedType,
          sizeBytes: a.sizeBytes,
          sha256: a.sha256,
          scanStatus: 'unsupported' as const,
          scanDetail: LAB_SCAN_DETAIL,
          scannedAt: null,
        })),
      });
    }
    return message.id;
  });
}
