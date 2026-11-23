import { createHash } from 'node:crypto';
import type { Attachment as ParsedAttachment } from 'mailparser';
import { defangText } from '../viewer/text.js';
import type { AnalyzedAttachment, FileFamily } from './types.js';

/**
 * Adjuntos de un correo (M2, D-018). Solo se LEEN sus bytes en memoria para calcular el SHA-256 y
 * mirar los primeros bytes: nunca se ejecutan, nunca se descomprimen y nunca se escriben a disco.
 * mailparser ya decodificó el base64 o quoted-printable; aquí no se interpreta nada más.
 */

/** Adjuntos que se registran por reporte; los demás se ignoran (y solo se cuentan). */
export const MAX_ATTACHMENTS = 50;
const MAX_FILE_NAME = 255;
const MAX_DECLARED_TYPE = 255;
/** Bytes del inicio que se miran para decidir si es texto. */
const TEXT_PROBE_BYTES = 4096;

/** Firma de los primeros bytes → tipo detectado y su familia. */
type Signature = { type: string; family: FileFamily; matches: (b: Buffer) => boolean };

const startsWith = (b: Buffer, ...bytes: number[]) => b.length >= bytes.length && bytes.every((v, i) => b[i] === v);
const startsWithText = (b: Buffer, text: string) => b.subarray(0, text.length).toString('latin1') === text;

/** Tabla pequeña de firmas ("magic numbers"). El orden importa: la primera que coincide gana. */
const SIGNATURES: readonly Signature[] = [
  { type: 'application/x-msdownload', family: 'executable', matches: (b) => startsWith(b, 0x4d, 0x5a) }, // "MZ" (PE de Windows)
  { type: 'application/x-elf', family: 'executable', matches: (b) => startsWith(b, 0x7f, 0x45, 0x4c, 0x46) },
  {
    type: 'application/x-mach-binary',
    family: 'executable',
    matches: (b) =>
      startsWith(b, 0xfe, 0xed, 0xfa, 0xce) ||
      startsWith(b, 0xfe, 0xed, 0xfa, 0xcf) ||
      startsWith(b, 0xce, 0xfa, 0xed, 0xfe) ||
      startsWith(b, 0xcf, 0xfa, 0xed, 0xfe) ||
      startsWith(b, 0xca, 0xfe, 0xba, 0xbe),
  },
  { type: 'application/pdf', family: 'pdf', matches: (b) => startsWithText(b, '%PDF-') },
  {
    type: 'application/zip',
    family: 'zip',
    matches: (b) => startsWith(b, 0x50, 0x4b, 0x03, 0x04) || startsWith(b, 0x50, 0x4b, 0x05, 0x06) || startsWith(b, 0x50, 0x4b, 0x07, 0x08),
  },
  { type: 'application/x-ole-storage', family: 'ole2', matches: (b) => startsWith(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) },
  { type: 'application/vnd.rar', family: 'rar', matches: (b) => startsWith(b, 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07) },
  { type: 'application/x-7z-compressed', family: '7z', matches: (b) => startsWith(b, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) },
  { type: 'application/gzip', family: 'gzip', matches: (b) => startsWith(b, 0x1f, 0x8b) },
  { type: 'image/png', family: 'image', matches: (b) => startsWith(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { type: 'image/jpeg', family: 'image', matches: (b) => startsWith(b, 0xff, 0xd8, 0xff) },
  { type: 'image/gif', family: 'image', matches: (b) => startsWithText(b, 'GIF87a') || startsWithText(b, 'GIF89a') },
  { type: 'application/rtf', family: 'rtf', matches: (b) => startsWithText(b, '{\\rtf') },
];

/** Familia de cada tipo detectado (para R7). */
const FAMILY_OF_TYPE = new Map<string, FileFamily>([...SIGNATURES.map((s) => [s.type, s.family] as const), ['text/plain', 'text']]);

export function familyOfDetected(detectedType: string | null): FileFamily | null {
  return detectedType ? (FAMILY_OF_TYPE.get(detectedType) ?? null) : null;
}

/** ¿El inicio del contenido es texto UTF-8 sin bytes de control (salvo tab, saltos y avance de página)? */
function looksLikeText(content: Buffer): boolean {
  const probe = content.subarray(0, TEXT_PROBE_BYTES);
  if (probe.includes(0)) return false;
  // El recorte puede partir un carácter de varios bytes al final: se prueba quitando hasta 3.
  let decoded: string | null = null;
  for (let cut = 0; cut <= 3 && decoded === null; cut++) {
    if (cut > 0 && probe.length < TEXT_PROBE_BYTES) break;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(probe.subarray(0, probe.length - cut));
    } catch {
      decoded = null;
    }
  }
  return decoded !== null && !/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(decoded);
}

/** Tipo por los primeros bytes; null si está vacío o no se reconoce. */
export function detectType(content: Buffer): string | null {
  if (content.length === 0) return null;
  const signature = SIGNATURES.find((s) => s.matches(content));
  if (signature) return signature.type;
  return looksLikeText(content) ? 'text/plain' : null;
}

/**
 * Caracteres que no deben llegar tal cual a una pantalla: controles C0, DEL, C1 y los de dirección
 * de texto (U+200E, U+200F, U+061C, U+202A a U+202E, U+2066 a U+2069). Con U+202E, por ejemplo,
 * "factura[U+202E]fdp.exe" se ve como "facturaexe.pdf".
 */
const HIDDEN_CHARS = /[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g;
const BIDI_CHARS = /[؜‎‏‪-‮⁦-⁩]/;

const escapeHidden = (s: string) =>
  s.replace(HIDDEN_CHARS, (c) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`);

/** Recorta por caracteres (puntos de código, como cuenta PostgreSQL), sin partir un par sustituto. */
const cutTo = (s: string, max: number) => {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
};

/**
 * Nombre para guardar y mostrar: caracteres ocultos escapados como [U+XXXX], URL desactivadas
 * (D-017), recortado a 255 caracteres; null si queda vacío. Sigue siendo texto hostil: se escapa
 * siempre al mostrarlo, nunca se usa como ruta y nunca va a los registros.
 */
export function sanitizeFileName(name: string | undefined | null): string | null {
  if (!name) return null;
  const clean = cutTo(defangText(escapeHidden(name)).trim(), MAX_FILE_NAME);
  return clean === '' ? null : clean;
}

function sanitizeDeclaredType(type: string | undefined | null): string | null {
  if (!type) return null;
  const clean = cutTo(escapeHidden(type).trim().toLowerCase(), MAX_DECLARED_TYPE);
  return clean === '' ? null : clean;
}

/**
 * Última y penúltima extensión del nombre ORIGINAL, en minúsculas, para R7. Windows ignora puntos y
 * espacios al final ("factura.pdf.exe. " se abre como .exe), así que se quitan antes. Solo cuentan
 * extensiones de 1 a 10 letras o dígitos.
 */
export function extensionsOf(name: string | undefined | null): { extension: string | null; previousExtension: string | null } {
  const parts = (name ?? '').replace(/[.\s]+$/, '').split('.');
  const ext = (i: number) => {
    const part = parts.length > 1 && i > 0 ? parts[i]?.toLowerCase() : undefined;
    return part && /^[a-z0-9]{1,10}$/.test(part) ? part : null;
  };
  const extension = ext(parts.length - 1);
  return { extension, previousExtension: extension ? ext(parts.length - 2) : null };
}

export type ExtractedAttachments = { attachments: AnalyzedAttachment[]; ignored: number };

/** Metadatos de los adjuntos que dio mailparser (los primeros MAX_ATTACHMENTS). */
export function extractAttachments(parsed: readonly ParsedAttachment[]): ExtractedAttachments {
  const attachments = parsed.slice(0, MAX_ATTACHMENTS).map((a, position): AnalyzedAttachment => {
    const content: Buffer = Buffer.isBuffer(a.content) ? a.content : Buffer.alloc(0);
    return {
      position,
      fileName: sanitizeFileName(a.filename),
      declaredType: sanitizeDeclaredType(a.contentType),
      detectedType: detectType(content),
      sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      ...extensionsOf(a.filename),
      hasBidiControls: BIDI_CHARS.test(a.filename ?? ''),
      content,
    };
  });
  return { attachments, ignored: Math.max(0, parsed.length - MAX_ATTACHMENTS) };
}
