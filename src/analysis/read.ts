import { scanMimeStructure, type MimeStructure } from './structure.js';
import type { ReportSource } from './types.js';

/**
 * Preparación común del correo antes de mailparser. La usan el analizador y el visor (/html y
 * /text), así los dos leen exactamente lo mismo.
 */

/** Sin conversiones extra: no se genera texto desde el HTML ni HTML desde el texto ni enlaces. */
export const PARSER_OPTIONS = { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true } as const;

/** Primera línea con forma de encabezado ("Nombre:" sin espacios antes de los dos puntos). */
const HEADER_LINE = /^[\x21-\x39\x3b-\x7e]+:/;

export type PreparedInput = {
  /** Bytes que se le dan a mailparser. */
  input: Buffer;
  /** El texto pegado no traía bloque de encabezados. */
  missingHeaders: boolean;
  structure: MimeStructure;
};

export function prepareInput(bytes: Uint8Array, source: ReportSource): PreparedInput {
  let input: Buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let missingHeaders = false;
  if (source === 'paste') {
    const firstLine = input.subarray(0, 1000).toString('utf8').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
    if (!HEADER_LINE.test(firstLine)) {
      // Sin encabezados: todo es cuerpo. La línea vacía inicial evita que mailparser tome la
      // primera línea ("Estimado usuario:") como un encabezado.
      missingHeaders = true;
      input = Buffer.concat([Buffer.from('\r\n'), input]);
    }
  }
  return { input, missingHeaders, structure: scanMimeStructure(input) };
}

/** Solo el bloque de encabezados (hasta la primera línea vacía), para correos que no se parsean enteros. */
export function headerBlock(bytes: Uint8Array): Buffer {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  const ends = [crlf, lf].filter((i) => i !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : buf.length;
  return Buffer.concat([buf.subarray(0, end), Buffer.from('\r\n\r\n')]);
}
