import { describe, expect, it } from 'vitest';
import { randomToken, safeEqual, sha256Hex } from '../src/auth/crypto.js';
import { ARGON2_PARAMS, createDecoyHash, hashPassword, verifyPassword } from '../src/auth/password.js';

describe('hashPassword / verifyPassword (Argon2id)', () => {
  it('genera un hash PHC de Argon2id con los parámetros de OWASP', async () => {
    const hash = await hashPassword('una-contraseña-larga');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(ARGON2_PARAMS).toMatchObject({ memory: 19_456, passes: 2, parallelism: 1 });
    expect(hash).not.toContain('una-contraseña-larga');
  });

  it('usa una sal distinta cada vez', async () => {
    const [a, b] = await Promise.all([hashPassword('misma-contraseña'), hashPassword('misma-contraseña')]);
    expect(a).not.toBe(b);
  });

  it('acepta la contraseña correcta y rechaza otra', async () => {
    const hash = await hashPassword('correcta-123456');
    expect(await verifyPassword('correcta-123456', hash)).toBe(true);
    expect(await verifyPassword('incorrecta-1234', hash)).toBe(false);
  });

  it('devuelve false con un hash mal formado o con parámetros absurdos', async () => {
    expect(await verifyPassword('x', 'no-es-un-hash')).toBe(false);
    expect(await verifyPassword('x', '$argon2id$v=19$m=99999999,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA')).toBe(false);
  });

  it('el hash señuelo usa los mismos parámetros y no acepta contraseñas', async () => {
    const decoy = await createDecoyHash();
    expect(decoy).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword('cualquier-cosa', decoy)).toBe(false);
  });
});

describe('utilidades criptográficas', () => {
  it('randomToken da 32 bytes en base64url', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it('sha256Hex da 64 caracteres hexadecimales', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('safeEqual compara sin depender de la longitud', () => {
    expect(safeEqual('igual', 'igual')).toBe(true);
    expect(safeEqual('igual', 'distinto')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
