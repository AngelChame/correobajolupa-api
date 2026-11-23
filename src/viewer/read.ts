import { simpleParser } from 'mailparser';
import { PARSER_OPTIONS, prepareInput } from '../analysis/read.js';
import type { ReportSource } from '../generated/prisma/enums.js';

/**
 * Lee el correo para el visor igual que el analizador (misma preparación). Se hace al pedirlo:
 * no se guarda nada derivado del correo. Con más de 15 niveles de multipart solo hay encabezados,
 * así que no hay HTML ni texto.
 */

/** Parte HTML del correo, o null si no trae. */
export async function readHtml(bytes: Uint8Array, source: ReportSource): Promise<string | null> {
  const { input, structure } = prepareInput(bytes, source);
  if (structure.tooDeep) return null;
  const parsed = await simpleParser(input, PARSER_OPTIONS);
  return typeof parsed.html === 'string' && parsed.html !== '' ? parsed.html : null;
}

/**
 * Texto del correo: la parte de texto o, si no hay, el texto que mailparser deriva del HTML.
 * En un texto pegado sin encabezados, todo el texto. Cadena vacía si no hay nada.
 */
export async function readText(bytes: Uint8Array, source: ReportSource): Promise<string> {
  const { input, structure } = prepareInput(bytes, source);
  if (structure.tooDeep) return '';
  const parsed = await simpleParser(input, { ...PARSER_OPTIONS, skipHtmlToText: false });
  return typeof parsed.text === 'string' ? parsed.text : '';
}
