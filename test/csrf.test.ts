import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { csrfGuard } from '../src/auth/csrf.js';
import type { AuthContext } from '../src/auth/session.js';
import { ErrorResponse } from '../src/contract/schemas/common.js';

const CSRF = 'token-csrf-de-prueba';

/** App mínima: simula loadSession con o sin sesión y responde 200 si pasa el guardia. */
function app(conSesion: boolean) {
  const a = express();
  a.use((req, _res, next) => {
    req.id = 'req-prueba';
    if (conSesion) req.auth = { sessionId: 's', csrfToken: CSRF, user: {} as AuthContext['user'] };
    next();
  });
  a.use(csrfGuard);
  a.all('/{*ruta}', (_req, res) => {
    res.json({ ok: true });
  });
  return a;
}

describe('csrfGuard', () => {
  it('deja pasar GET sin token', async () => {
    expect((await request(app(false)).get('/api/v1/auth/me')).status).toBe(200);
  });

  it('register y login no piden token (tampoco con otra capitalización o barra final)', async () => {
    for (const ruta of ['/api/v1/auth/register', '/api/v1/auth/login', '/API/v1/Auth/Login/']) {
      expect((await request(app(false)).post(ruta)).status, ruta).toBe(200);
    }
  });

  it('sin sesión, una petición que modifica datos responde 401', async () => {
    const res = await request(app(false)).post('/api/v1/auth/logout');
    expect(res.status).toBe(401);
    expect(ErrorResponse.parse(res.body).code).toBe('unauthenticated');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('%s sin token responde 403 forbidden', async (metodo) => {
    const res = await request(app(true))[metodo.toLowerCase() as 'post']('/api/v1/cualquier-cosa');
    expect(res.status).toBe(403);
    expect(ErrorResponse.parse(res.body).code).toBe('forbidden');
  });

  it('con token incorrecto responde 403 y con el correcto pasa', async () => {
    const mal = await request(app(true)).post('/api/v1/auth/logout').set('X-CSRF-Token', 'otro-token');
    expect(mal.status).toBe(403);
    const bien = await request(app(true)).post('/api/v1/auth/logout').set('X-CSRF-Token', CSRF);
    expect(bien.status).toBe(200);
  });
});
