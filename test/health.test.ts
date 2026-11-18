import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { ErrorResponse } from '../src/contract/schemas/common.js';

function appConRegistros() {
  const lineas: string[] = [];
  const logger = createLogger('info', { write: (linea: string) => void lineas.push(linea) });
  return { app: createApp({ logger }), lineas };
}

describe('GET /api/v1/health', () => {
  it('responde 200 con {status: "ok"} y un X-Request-Id', async () => {
    const { app } = appConRegistros();
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });

  it('respeta un X-Request-Id válido y reemplaza uno inválido', async () => {
    const { app } = appConRegistros();
    const valido = await request(app).get('/api/v1/health').set('X-Request-Id', 'prueba-123');
    expect(valido.headers['x-request-id']).toBe('prueba-123');
    const invalido = await request(app).get('/api/v1/health').set('X-Request-Id', '<script>');
    expect(invalido.headers['x-request-id']).not.toBe('<script>');
  });

  it('no anuncia Express (sin X-Powered-By)', async () => {
    const { app } = appConRegistros();
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('errores con la forma del contrato (D-044)', () => {
  it('una ruta desconocida responde 404 not_found', async () => {
    const { app } = appConRegistros();
    const res = await request(app).get('/api/v1/no-existe').set('X-Request-Id', 'abc');
    expect(res.status).toBe(404);
    const cuerpo = ErrorResponse.parse(res.body);
    expect(cuerpo.code).toBe('not_found');
    expect(cuerpo.requestId).toBe('abc');
  });

  it('un JSON mal formado responde 400 validation_error', async () => {
    const { app } = appConRegistros();
    const res = await request(app).post('/api/v1/health').set('Content-Type', 'application/json').send('{no es json');
    expect(res.status).toBe(400);
    expect(ErrorResponse.parse(res.body).code).toBe('validation_error');
  });
});

describe('registros (D-036)', () => {
  it('no guardan cookies, Authorization, CSRF ni la query string', async () => {
    const { app, lineas } = appConRegistros();
    await request(app)
      .get('/api/v1/health?correo=MARCADOR_QUERY')
      .set('Cookie', 'cbl_session=MARCADOR_COOKIE')
      .set('Authorization', 'Bearer MARCADOR_AUTH')
      .set('X-CSRF-Token', 'MARCADOR_CSRF');
    const todo = lineas.join('\n');
    expect(lineas.length).toBeGreaterThan(0);
    for (const marcador of ['MARCADOR_QUERY', 'MARCADOR_COOKIE', 'MARCADOR_AUTH', 'MARCADOR_CSRF']) {
      expect(todo).not.toContain(marcador);
    }
  });
});
