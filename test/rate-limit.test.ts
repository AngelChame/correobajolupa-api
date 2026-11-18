import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ErrorResponse } from '../src/contract/schemas/common.js';
import { appConRegistros } from './helpers.js';

// Con datos inválidos la petición no llega a la base: basta para probar el límite por IP.
describe('límite de peticiones por IP', () => {
  it('register responde 429 rate_limited al pasar el límite', async () => {
    const { app } = appConRegistros({ RATE_LIMIT_REGISTER_PER_IP: '2' });
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post('/api/v1/auth/register').send({})).status).toBe(400);
    }
    const res = await request(app).post('/api/v1/auth/register').send({});
    expect(res.status).toBe(429);
    expect(ErrorResponse.parse(res.body).code).toBe('rate_limited');
    expect(res.headers['ratelimit-policy']).toBeDefined();
  });

  it('login responde 429 al pasar el límite por IP', async () => {
    const { app } = appConRegistros({ RATE_LIMIT_LOGIN_PER_IP: '3' });
    for (let i = 0; i < 3; i++) {
      expect((await request(app).post('/api/v1/auth/login').send({})).status).toBe(400);
    }
    expect((await request(app).post('/api/v1/auth/login').send({})).status).toBe(429);
  });

  it('cada app tiene sus propios contadores', async () => {
    const a = appConRegistros({ RATE_LIMIT_REGISTER_PER_IP: '1' }).app;
    const b = appConRegistros({ RATE_LIMIT_REGISTER_PER_IP: '1' }).app;
    await request(a).post('/api/v1/auth/register').send({});
    expect((await request(a).post('/api/v1/auth/register').send({})).status).toBe(429);
    expect((await request(b).post('/api/v1/auth/register').send({})).status).toBe(400);
  });
});
