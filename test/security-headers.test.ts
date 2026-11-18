import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { noStore, securityHeaders } from '../src/http/security.js';
import { appConRegistros, testConfig } from './helpers.js';

const ESPERADAS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none';frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

describe('cabeceras de seguridad', () => {
  it.each(['/api/v1/health', '/api/v1/no-existe', '/fuera-de-la-api'])('están en %s', async (ruta) => {
    const { app } = appConRegistros();
    const res = await request(app).get(ruta);
    expect(res.headers).toMatchObject(ESPERADAS);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('también en un error de validación de /auth', async () => {
    const { app } = appConRegistros();
    const res = await request(app).post('/api/v1/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.headers).toMatchObject(ESPERADAS);
  });

  it('sin HSTS fuera de producción', async () => {
    const { app } = appConRegistros();
    expect((await request(app).get('/api/v1/health')).headers['strict-transport-security']).toBeUndefined();
  });

  it('HSTS de ~6 meses, sin includeSubDomains ni preload, en producción con COOKIE_SECURE=true', async () => {
    const { app } = appConRegistros({ NODE_ENV: 'production', COOKIE_SECURE: 'true' });
    expect((await request(app).get('/api/v1/health')).headers['strict-transport-security']).toBe('max-age=15552000');
  });

  it('una ruta puede sobrescribir la CSP y el Cache-Control (como hará el visor de M1, D-035)', async () => {
    const app = express();
    app.use(securityHeaders(testConfig()));
    app.use(noStore);
    app.get('/visor', (_req, res) => {
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.send('ok');
    });
    const res = await request(app).get('/visor');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['cache-control']).toBe('private, max-age=60');
  });
});

describe('sin CORS (D-031: mismo origen)', () => {
  it('una petición con Origin ajeno no recibe Access-Control-Allow-Origin', async () => {
    const { app } = appConRegistros();
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://ajeno.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('un preflight OPTIONS tampoco recibe permisos de CORS', async () => {
    const { app } = appConRegistros();
    const res = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', 'https://ajeno.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });
});
