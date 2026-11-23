/** Profundidad máxima de multipart anidado que se acepta (H04 trae 40). */
export const MAX_MULTIPART_DEPTH = 15;

/** Máximo de bytes de encabezados que se acumulan por parte al buscar el boundary. */
const MAX_PART_HEADER_BYTES = 64 * 1024;

const BOUNDARY = /^content-type:[ \t]*multipart\/[^\n]*?\bboundary[ \t]*=[ \t]*(?:"([^"\n]{1,200})"|([^;\s]{1,200}))/im;

export type MimeStructure = {
  /** Algún multipart no trae su delimitador final (correo cortado, H02). */
  truncated: boolean;
  /** Se pasó de MAX_MULTIPART_DEPTH niveles (H04). El escaneo se detiene ahí. */
  tooDeep: boolean;
};

/**
 * Recorre el correo línea por línea ANTES de parsearlo, con una pila explícita de boundaries
 * (sin recursión: un correo con miles de niveles no desborda la pila de llamadas). Es lineal en
 * el tamaño del correo y no decodifica nada: solo mira encabezados Content-Type y delimitadores.
 */
export function scanMimeStructure(bytes: Uint8Array): MimeStructure {
  // latin1 conserva cada byte como un carácter: los delimitadores son ASCII.
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const stack: string[] = [];
  let inHeaders = true;
  let headers = '';

  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;

    if (inHeaders) {
      if (line === '') {
        const match = BOUNDARY.exec(headers.replace(/\r?\n[ \t]+/g, ' '));
        const boundary = match?.[1] ?? match?.[2];
        if (boundary) {
          stack.push(boundary);
          if (stack.length > MAX_MULTIPART_DEPTH) return { truncated: false, tooDeep: true };
        }
        inHeaders = false;
        headers = '';
      } else if (headers.length < MAX_PART_HEADER_BYTES) {
        headers += `${line}\n`;
      }
      if (end === text.length) break;
      continue;
    }

    if (stack.length > 0 && line.startsWith('--')) {
      const trimmed = line.trimEnd();
      // Del más interno al más externo: un delimitador externo cierra también los internos.
      for (let i = stack.length - 1; i >= 0; i--) {
        const b = stack[i]!;
        if (trimmed === `--${b}--`) {
          stack.length = i;
          break;
        }
        if (trimmed === `--${b}`) {
          stack.length = i + 1;
          inHeaders = true;
          break;
        }
      }
    }
    if (end === text.length) break;
  }
  return { truncated: stack.length > 0, tooDeep: false };
}
