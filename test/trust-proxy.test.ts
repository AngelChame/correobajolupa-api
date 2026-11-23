import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { appConRegistros } from './helpers.js';

// TRUST_PROXY_HOPS: 0 deja 'trust proxy' apagado (sin proxy, X-Forwarded-For se ignora);
// con n > 0 Express confía en n saltos y nada más.
describe("'trust proxy' según TRUST_PROXY_HOPS", () => {
  it('queda apagado por defecto', () => {
    const { app } = appConRegistros();
    expect(app.get('trust proxy')).toBe(false);
  });

  it('con 1 confía en un solo salto', () => {
    const { app } = appConRegistros({ TRUST_PROXY_HOPS: '1' });
    expect(app.get('trust proxy')).toBe(1);
  });

  it('apagado, un X-Forwarded-For falso no cambia la IP para el límite global', async () => {
    // Si se confiara en la cabecera, cada petición con otra IP falsa tendría su propio contador.
    const { app } = appConRegistros({ RATE_LIMIT_GLOBAL_PER_MINUTE: '2' });
    const estados: number[] = [];
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      const res = await request(app).get('/api/v1/ruta-inexistente').set('X-Forwarded-For', ip);
      estados.push(res.status);
    }
    expect(estados).toEqual([404, 404, 429]);
  });
});
