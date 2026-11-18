import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bytes aleatorios criptográficos codificados en base64url (sin relleno). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 en hexadecimal. Es lo único que se guarda del token de sesión (D-034). */
export function sha256Hex(valor: string): string {
  return createHash('sha256').update(valor, 'utf8').digest('hex');
}

/**
 * Compara dos textos en tiempo constante. Se comparan sus SHA-256 (siempre 32 bytes) para que
 * timingSafeEqual no falle con longitudes distintas ni revele la longitud del valor esperado.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
