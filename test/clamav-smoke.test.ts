import { describe, expect, it } from 'vitest';
import { scanBuffer } from '../src/clamav/client.js';
import { eicar } from './eicar.js';

// Prueba de humo contra un clamd REAL. Solo corre con CLAMAV_TEST_HOST (y CLAMAV_TEST_PORT,
// 3310 por defecto); sin ella se salta y el CI sigue igual. Ejemplo local:
//   docker run -d --rm --name cbl-clamav-smoke -e CLAMAV_NO_MILTERD=true -p 127.0.0.1:3310:3310 clamav/clamav:1.5.5
//   (esperar a que cargue las firmas)  →  CLAMAV_TEST_HOST=127.0.0.1 npx vitest run test/clamav-smoke.test.ts
const host = process.env.CLAMAV_TEST_HOST;
const opciones = { host: host ?? '', port: Number(process.env.CLAMAV_TEST_PORT ?? 3310), timeoutMs: 30_000 };

describe.skipIf(!host)('ClamAV real (prueba de humo)', () => {
  it('EICAR → detected; texto normal → not_detected', async () => {
    const detectado = await scanBuffer(eicar(), opciones);
    expect(detectado.status).toBe('detected');
    expect(detectado.detail).toMatch(/eicar/i);
    expect(await scanBuffer(Buffer.from('Texto sintético sin nada raro.\n'), opciones)).toEqual({ status: 'not_detected', detail: null });
  });
});
