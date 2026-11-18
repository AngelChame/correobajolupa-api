import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Hash de contraseñas con Argon2id, integrado en Node desde v24.7 (sin dependencias nativas).
 * Parámetros: configuración base de OWASP (Password Storage Cheat Sheet): 19 MiB, 2 pasadas, 1 hilo.
 * Se guardan en formato PHC dentro del propio hash, así que se pueden subir más adelante sin
 * invalidar los hashes existentes.
 */
export const ARGON2_PARAMS = {
  memory: 19_456, // KiB
  passes: 2,
  parallelism: 1,
  tagLength: 32, // bytes del hash
} as const;
const SALT_BYTES = 16;

// Límites para no aceptar un hash guardado con parámetros absurdos (memoria o tiempo).
const MAX_MEMORY = 262_144; // 256 MiB
const MAX_PASSES = 10;

type Argon2Params = { memory: number; passes: number; parallelism: number; tagLength: number };

function derive(password: string, salt: Buffer, params: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: password, nonce: salt, ...params }, (error, hash) => {
      if (error) reject(error);
      else resolve(hash);
    });
  });
}

const b64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '');

/** Devuelve `$argon2id$v=19$m=…,t=…,p=…$<sal>$<hash>` (formato PHC). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, ARGON2_PARAMS);
  const { memory, passes, parallelism } = ARGON2_PARAMS;
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/**
 * Verifica una contraseña contra un hash PHC. Compara con timingSafeEqual. Si el hash no tiene
 * el formato esperado devuelve false (nunca lanza con datos del usuario).
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const partes = PHC.exec(stored);
  if (!partes) return false;
  const [, m, t, p, saltB64, hashB64] = partes;
  const memory = Number(m);
  const passes = Number(t);
  const parallelism = Number(p);
  if (memory > MAX_MEMORY || passes > MAX_PASSES || parallelism > 16) return false;
  const salt = Buffer.from(saltB64 ?? '', 'base64');
  const esperado = Buffer.from(hashB64 ?? '', 'base64');
  if (salt.length < 8 || esperado.length < 16) return false;
  const calculado = await derive(password, salt, { memory, passes, parallelism, tagLength: esperado.length });
  return timingSafeEqual(calculado, esperado);
}

/**
 * Hash señuelo: se calcula UNA vez al arrancar con los mismos parámetros que los reales. Cuando
 * el correo no existe, el login verifica contra él para tardar lo mismo que con una cuenta real
 * y no revelar qué correos están registrados por el tiempo de respuesta.
 */
export function createDecoyHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString('base64url'));
}
