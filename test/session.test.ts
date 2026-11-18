import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_SAME_SITE,
  readSessionToken,
  setSessionCookie,
} from '../src/auth/session.js';

const TOKEN = 'a'.repeat(43);

describe('cookie de sesión', () => {
  it('constantes acordadas: 8 h absoluta, 30 min de inactividad, SameSite=Lax', () => {
    expect(SESSION_ABSOLUTE_TTL_MS).toBe(8 * 60 * 60 * 1000);
    expect(SESSION_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(SESSION_SAME_SITE).toBe('lax');
  });

  it.each([true, false])('Set-Cookie con HttpOnly, SameSite=Lax, Path=/ y Secure=%s', async (secure) => {
    const app = express();
    app.get('/', (_req, res) => {
      setSessionCookie(res, TOKEN, secure);
      res.end();
    });
    const res = await request(app).get('/');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`cbl_session=${TOKEN}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${SESSION_ABSOLUTE_TTL_MS / 1000}`);
    expect(cookie.includes('Secure')).toBe(secure);
  });

  it('readSessionToken solo acepta tokens con el formato esperado', async () => {
    const app = express();
    app.get('/', (req, res) => {
      res.json({ token: readSessionToken(req) ?? null });
    });
    const valido = await request(app).get('/').set('Cookie', `otra=1; cbl_session=${TOKEN}`);
    expect(valido.body.token).toBe(TOKEN);
    const raro = await request(app).get('/').set('Cookie', "cbl_session=' OR 1=1 --");
    expect(raro.body.token).toBeNull();
    const sinCookie = await request(app).get('/');
    expect(sinCookie.body.token).toBeNull();
  });
});
