import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { UserList } from '../../src/contract/schemas/auth.js';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { db, entrarComo, crearApp, limpiarBase } from './support.js';

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(limpiarBase);

describe('GET /users', () => {
  it('el administrador recibe la UserList del contrato, sin campos internos', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    await entrarComo(app, 'analyst', 'luis@ejemplo.invalid');

    const res = await request(app).get('/api/v1/users').set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    const lista = UserList.parse(res.body);
    expect(lista).toMatchObject({ page: 1, pageSize: 20, total: 3 });
    expect(lista.items.map((u) => u.email)).toEqual(['admin@ejemplo.invalid', 'ana@ejemplo.invalid', 'luis@ejemplo.invalid']);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash|argon2/);
  });

  it('pagina en orden estable y filtra por rol', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    for (const nombre of ['a', 'b', 'c']) await entrarComo(app, 'reporter', `${nombre}@ejemplo.invalid`);

    const p1 = UserList.parse((await request(app).get('/api/v1/users?page=1&pageSize=2').set('Cookie', admin.cookie)).body);
    const p2 = UserList.parse((await request(app).get('/api/v1/users?page=2&pageSize=2').set('Cookie', admin.cookie)).body);
    expect(p1.total).toBe(4);
    expect([...p1.items, ...p2.items].map((u) => u.email)).toEqual([
      'admin@ejemplo.invalid',
      'a@ejemplo.invalid',
      'b@ejemplo.invalid',
      'c@ejemplo.invalid',
    ]);

    const reporters = UserList.parse((await request(app).get('/api/v1/users?role=reporter').set('Cookie', admin.cookie)).body);
    expect(reporters.total).toBe(3);
    expect(reporters.items.every((u) => u.role === 'reporter')).toBe(true);
  });

  it('parámetros inválidos responden 400 validation_error sin repetir el valor', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const res = await request(app).get('/api/v1/users?pageSize=500&role=MARCADOR_ROL').set('Cookie', admin.cookie);
    expect(res.status).toBe(400);
    const error = ErrorResponse.parse(res.body);
    expect(error.code).toBe('validation_error');
    expect(error.details?.map((d) => d.field).sort()).toEqual(['pageSize', 'role']);
    expect(JSON.stringify(res.body)).not.toContain('MARCADOR_ROL');
  });
});
