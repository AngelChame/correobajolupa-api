import { connect } from 'node:net';

/**
 * Cliente mínimo de clamd por TCP con el comando INSTREAM (M2, D-018), sin dependencias.
 *
 * Protocolo (man clamd, sección INSTREAM): se manda "zINSTREAM\0"; luego el contenido en trozos
 * "<longitud><datos>", con la longitud en 4 bytes sin signo en orden de red (big-endian); un trozo
 * de longitud 0 termina el envío. Con el prefijo "z", la respuesta termina en "\0". Si se pasa de
 * StreamMaxLength, clamd responde "INSTREAM size limit exceeded" y cierra.
 * Las respuestas "stream: OK" y "stream: <firma> FOUND" son las que da clamd en la práctica: POR
 * VERIFICAR contra el contenedor real (prueba de humo con CLAMAV_TEST_HOST).
 *
 * Regla de oro: si algo sale mal, el resultado es `error`, NUNCA `not_detected` (D-018).
 */

export type ScanResult = { status: 'not_detected' | 'detected' | 'error'; detail: string | null };

export type ClamdOptions = { host: string; port: number; timeoutMs: number };

/** Tamaño de cada trozo enviado. */
export const CHUNK_BYTES = 64 * 1024;
/** Una respuesta de clamd es una línea corta: más que esto es basura. */
const MAX_REPLY_BYTES = 1024;
/** scan_detail es VARCHAR(200). */
const MAX_DETAIL = 200;

export const SCAN_DETAIL = {
  timeout: 'tiempo de escaneo agotado',
  connection: 'no se pudo conectar con ClamAV o cortó la conexión',
  clamdError: 'ClamAV respondió con un error',
  sizeLimit: 'ClamAV rechazó el archivo por tamaño (StreamMaxLength)',
  unexpected: 'respuesta inesperada de ClamAV',
} as const;

const error = (detail: string): ScanResult => ({ status: 'error', detail });

/** Interpreta la respuesta completa de clamd (sin el "\0" final). */
export function parseReply(reply: string): ScanResult {
  const text = reply.trim();
  if (text === 'stream: OK') return { status: 'not_detected', detail: null };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) {
    // Nombre de la firma (lo pone ClamAV, no el correo). Solo caracteres visibles y recortado.
    const firma = found[1]!.replace(/[^\x20-\x7e]/g, '?').trim().slice(0, MAX_DETAIL);
    return firma === '' ? error(SCAN_DETAIL.unexpected) : { status: 'detected', detail: firma };
  }
  if (/size limit exceeded/i.test(text)) return error(SCAN_DETAIL.sizeLimit);
  if (/ERROR$/.test(text)) return error(SCAN_DETAIL.clamdError);
  return error(SCAN_DETAIL.unexpected);
}

/** Bytes que se mandan después del comando: trozos con su longitud y el trozo final de 0. */
export function* instreamFrames(content: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < content.length; offset += CHUNK_BYTES) {
    const chunk = content.subarray(offset, offset + CHUNK_BYTES);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.length, 0);
    yield length;
    yield chunk;
  }
  yield Buffer.alloc(4); // longitud 0: fin del envío
}

/**
 * Escanea un contenido en memoria. Nunca lanza: cualquier fallo (conexión rechazada o cortada,
 * tiempo agotado, respuesta rara) devuelve `error` con un motivo corto y sin datos del correo.
 */
export function scanBuffer(content: Buffer, { host, port, timeoutMs }: ClamdOptions): Promise<ScanResult> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let received = 0;

    const socket = connect({ host, port });
    const finish = (result: ScanResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(error(SCAN_DETAIL.timeout)), timeoutMs);
    const replyText = () => Buffer.concat(chunks).toString('latin1').replace(/\0[\s\S]*$/, '');

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (const frame of instreamFrames(content)) {
        if (settled || socket.destroyed) return;
        socket.write(frame);
      }
    });
    socket.on('data', (data: Buffer) => {
      chunks.push(data);
      received += data.length;
      if (data.includes(0)) {
        finish(parseReply(replyText()));
      } else if (received > MAX_REPLY_BYTES) {
        finish(error(SCAN_DETAIL.unexpected));
      }
    });
    // clamd puede cerrar sin "\0" (por ejemplo tras "size limit exceeded"): se interpreta lo recibido.
    socket.on('end', () => finish(received > 0 ? parseReply(replyText()) : error(SCAN_DETAIL.connection)));
    socket.on('close', () => finish(received > 0 ? parseReply(replyText()) : error(SCAN_DETAIL.connection)));
    socket.on('error', () => finish(received > 0 ? parseReply(replyText()) : error(SCAN_DETAIL.connection)));
  });
}
