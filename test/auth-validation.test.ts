import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ErrorResponse } from '../src/contract/schemas/common.js';
import { appConRegistros } from './helpers.js';

// Valores marcador: si aparecen en la respuesta o en los registros, algo filtró datos.
const CLAVE_CORTA = 'MARC_CLAVE'; // 10 caracteres: no cumple el mínimo de 12
const CORREO_MALO = 'MARCADOR_CORREO_SIN_ARROBA';

describe('validación de /auth con los esquemas del contrato', () => {
  it('register con datos inválidos responde 400 sin repetir los valores recibidos', async () => {
    const { app, lineas } = appConRegistros();
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: CORREO_MALO, password: CLAVE_CORTA, displayName: '' });

    expect(res.status).toBe(400);
    const cuerpo = ErrorResponse.parse(res.body);
    expect(cuerpo.code).toBe('validation_error');
    expect(cuerpo.details?.map((d) => d.field).sort()).toEqual(['displayName', 'email', 'password']);
    for (const detalle of cuerpo.details ?? []) {
      expect(Object.keys(detalle).sort()).toEqual(['field', 'message']);
    }

    const todo = JSON.stringify(res.body) + lineas.join('\n');
    expect(todo).not.toContain(CLAVE_CORTA);
    expect(todo).not.toContain(CORREO_MALO);
  });

  it('los mensajes de validación están en español', async () => {
    const { app } = appConRegistros();
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'no-es-correo', password: '' });
    const mensajes = ErrorResponse.parse(res.body).details?.map((d) => d.message).join(' ') ?? '';
    expect(mensajes).toMatch(/inválid|demasiado|se esperaba/i);
  });

  it('login sin cuerpo JSON responde 400 validation_error', async () => {
    const { app } = appConRegistros();
    const res = await request(app).post('/api/v1/auth/login');
    expect(res.status).toBe(400);
    expect(ErrorResponse.parse(res.body).code).toBe('validation_error');
  });

  it('con INVITE_CODE definido, un código incorrecto responde 400 en inviteCode', async () => {
    const { app } = appConRegistros({ INVITE_CODE: 'codigo-correcto' });
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'ana@ejemplo.invalid', password: 'contraseña-larga-1', displayName: 'Ana', inviteCode: 'otro' });
    expect(res.status).toBe(400);
    expect(ErrorResponse.parse(res.body).details).toEqual([{ field: 'inviteCode', message: 'El código de invitación no es válido.' }]);
  });

  it('/auth/me sin sesión responde 401 unauthenticated', async () => {
    const { app } = appConRegistros();
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(ErrorResponse.parse(res.body).code).toBe('unauthenticated');
  });
});
