import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { User, UserList } from '../../src/contract/schemas/auth.js';
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

/** PATCH con la sesión y el token CSRF de quien actúa. */
function patch(app: Parameters<typeof request>[0], quien: { cookie: string; csrf: string }, userId: string, body: object) {
  return request(app).patch(`/api/v1/users/${userId}`).set('Cookie', quien.cookie).set('X-CSRF-Token', quien.csrf).send(body);
}

describe('PATCH /users/{userId}', () => {
  it('cambia el rol, cierra las sesiones del afectado y audita roleFrom/roleTo', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');

    const res = await patch(app, admin, ana.userId, { role: 'analyst' });
    expect(res.status).toBe(200);
    expect(User.parse(res.body)).toMatchObject({ id: ana.userId, role: 'analyst', active: true });
    expect(await db.session.count({ where: { userId: ana.userId } })).toBe(0);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', ana.cookie)).status).toBe(401);

    const evento = await db.auditEvent.findFirstOrThrow({ where: { action: 'user.role_change' } });
    expect(evento).toMatchObject({
      result: 'success',
      actorId: admin.userId,
      targetType: 'user',
      targetId: ana.userId,
      requestId: expect.any(String),
      metadata: { roleFrom: 'reporter', roleTo: 'analyst' },
    });
  });

  it('desactivar cierra sesiones y audita; reactivar no cierra sesiones', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');

    expect((await patch(app, admin, ana.userId, { active: false })).status).toBe(200);
    expect(await db.session.count({ where: { userId: ana.userId } })).toBe(0);
    expect(await db.auditEvent.count({ where: { action: 'user.deactivate', targetId: ana.userId } })).toBe(1);

    const adminSesiones = await db.session.count({ where: { userId: admin.userId } });
    const reactivar = await patch(app, admin, ana.userId, { active: true });
    expect(User.parse(reactivar.body).active).toBe(true);
    expect(await db.auditEvent.count({ where: { action: 'user.activate', targetId: ana.userId } })).toBe(1);
    expect(await db.session.count({ where: { userId: admin.userId } })).toBe(adminSesiones);
  });

  it('un PATCH sin cambios reales responde 200 sin auditoría ni cierre de sesiones', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const res = await patch(app, admin, ana.userId, { role: 'reporter', active: true });
    expect(res.status).toBe(200);
    expect(await db.auditEvent.count({ where: { action: { startsWith: 'user.' } } })).toBe(0);
    expect(await db.session.count({ where: { userId: ana.userId } })).toBe(1);
  });

  it('cuerpo vacío o sin campos conocidos responde 400', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    for (const body of [{}, { email: 'otro@ejemplo.invalid' }]) {
      const res = await patch(app, admin, ana.userId, body);
      expect(res.status).toBe(400);
      expect(ErrorResponse.parse(res.body).code).toBe('validation_error');
    }
    expect((await patch(app, admin, ana.userId, { role: 'superadmin' })).status).toBe(400);
  });

  it('userId desconocido o que no es UUID responde 404', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    for (const id of ['00000000-0000-4000-8000-000000000000', 'no-es-uuid']) {
      const res = await patch(app, admin, id, { role: 'analyst' });
      expect(res.status, id).toBe(404);
      expect(ErrorResponse.parse(res.body).code).toBe('not_found');
    }
  });

  // El que llega segundo ya no es administrador. Si su petición ya había pasado requireRole, la
  // comprobación dentro de la transacción responde 403; si llegó después de que se cerraran sus
  // sesiones, 401. En ningún caso el sistema se queda sin administradores.
  it('dos administradores que se degradan a la vez: uno gana y el otro es rechazado', async () => {
    const { app } = crearApp();
    const a = await entrarComo(app, 'admin', 'a@ejemplo.invalid');
    const b = await entrarComo(app, 'admin', 'b@ejemplo.invalid');
    const [ra, rb] = await Promise.all([patch(app, a, b.userId, { role: 'analyst' }), patch(app, b, a.userId, { role: 'analyst' })]);
    const [ganador, perdedor] = [ra, rb].sort((x, y) => x.status - y.status);
    expect(ganador?.status).toBe(200);
    expect([401, 403]).toContain(perdedor?.status);
    expect(await db.user.count({ where: { role: 'admin', active: true } })).toBe(1);
  });
});

