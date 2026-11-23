import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Session, User, UserList } from '../../src/contract/schemas/auth.js';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { ReportSummary } from '../../src/contract/schemas/reports.js';
import { CLAVE, crearApp, db, entrarComo, limpiarBase, tokenDe } from './support.js';

/**
 * Pruebas de seguridad básicas de M0. Los nombres P-07 a P-10 son aproximados: siguen el sentido
 * que les da el plan (permisos, rol inicial, escalada y ráfagas 429); hay que cotejarlos con el
 * texto del documento de requerimientos.
 */

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(limpiarBase);

type App = Parameters<typeof request>[0];

function patch(app: App, quien: { cookie: string; csrf: string }, userId: string, body: object) {
  return request(app).patch(`/api/v1/users/${userId}`).set('Cookie', quien.cookie).set('X-CSRF-Token', quien.csrf).send(body);
}

describe('P-07 (aprox.) permisos por rol en /users', () => {
  it('sin sesión: 401 en GET y PATCH', async () => {
    const { app } = crearApp();
    const get = await request(app).get('/api/v1/users');
    const pat = await request(app).patch('/api/v1/users/00000000-0000-4000-8000-000000000000').send({ role: 'admin' });
    for (const res of [get, pat]) {
      expect(res.status).toBe(401);
      expect(ErrorResponse.parse(res.body).code).toBe('unauthenticated');
    }
  });

  it.each(['reporter', 'analyst'] as const)('%s: 403 en GET /users y queda auditado como denied', async (rol) => {
    const { app } = crearApp();
    const quien = await entrarComo(app, rol, `${rol}@ejemplo.invalid`);
    const res = await request(app).get('/api/v1/users?page=1').set('Cookie', quien.cookie);
    expect(res.status).toBe(403);
    expect(ErrorResponse.parse(res.body).code).toBe('forbidden');

    const evento = await db.auditEvent.findFirstOrThrow({ where: { action: 'authz.denied' } });
    expect(evento).toMatchObject({
      result: 'denied',
      actorId: quien.userId,
      requestId: expect.any(String),
      metadata: { method: 'GET', route: '/api/v1/users/', role: rol, requiredRoles: ['admin'] },
    });
  });

  it('admin: 200 con UserList', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const res = await request(app).get('/api/v1/users').set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    UserList.parse(res.body);
  });
});

describe('P-08 (aprox.) rol inicial y asignación masiva', () => {
  it('un registro nuevo siempre es reporter activo aunque el cuerpo traiga role y active', async () => {
    const { app } = crearApp();
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'mallory@ejemplo.invalid',
      password: CLAVE,
      displayName: 'Mallory',
      role: 'admin',
      active: false,
      id: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.status).toBe(201);
    const { user } = Session.parse(res.body);
    expect(user).toMatchObject({ role: 'reporter', active: true });
    expect(user.id).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(await db.user.count({ where: { role: 'admin' } })).toBe(0);
  });
});

describe('P-09 (aprox.) escalada de privilegios y último administrador', () => {
  it('un reportante no puede cambiar su propio rol ni el de otro (403)', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const luis = await entrarComo(app, 'reporter', 'luis@ejemplo.invalid');
    for (const objetivo of [ana.userId, luis.userId]) {
      const res = await patch(app, ana, objetivo, { role: 'admin' });
      expect(res.status).toBe(403);
      expect(ErrorResponse.parse(res.body).code).toBe('forbidden');
    }
    expect(await db.user.count({ where: { role: 'admin' } })).toBe(0);
    expect(await db.auditEvent.count({ where: { action: 'authz.denied', actorId: ana.userId } })).toBe(2);
  });

  it('sin X-CSRF-Token, ni un administrador puede hacer PATCH (403 por CSRF)', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const res = await request(app).patch(`/api/v1/users/${ana.userId}`).set('Cookie', admin.cookie).send({ role: 'admin' });
    expect(res.status).toBe(403);
    expect((await db.user.findUniqueOrThrow({ where: { id: ana.userId } })).role).toBe('reporter');
  });

  it('un administrador no puede quitarse el rol ni desactivarse (409 conflict)', async () => {
    const { app } = crearApp();
    const a = await entrarComo(app, 'admin', 'a@ejemplo.invalid');
    await entrarComo(app, 'admin', 'b@ejemplo.invalid');
    for (const body of [{ role: 'analyst' }, { active: false }]) {
      const res = await patch(app, a, a.userId, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(ErrorResponse.parse(res.body)).toMatchObject({ code: 'conflict', message: expect.stringMatching(/propia cuenta/) });
    }
  });

  // Quien actúa siempre es un administrador activo; si actúa sobre OTRO administrador, hay al
  // menos dos activos. Por eso "dejar el sistema sin administradores" solo puede pasar consigo
  // mismo (esta prueba) o en una carrera entre dos (test/integration/users.test.ts).
  it('el único administrador activo no puede degradarse ni desactivarse (409 conflict)', async () => {
    const { app } = crearApp();
    const unico = await entrarComo(app, 'admin', 'unico@ejemplo.invalid');
    const inactivo = await entrarComo(app, 'admin', 'inactivo@ejemplo.invalid');
    await db.user.update({ where: { id: inactivo.userId }, data: { active: false } }); // no cuenta
    for (const body of [{ role: 'reporter' }, { active: false }]) {
      const res = await patch(app, unico, unico.userId, body);
      expect(res.status).toBe(409);
      expect(ErrorResponse.parse(res.body).code).toBe('conflict');
    }
    expect(await db.user.count({ where: { role: 'admin', active: true } })).toBe(1);
  });

  it('con dos administradores, uno puede degradar al otro y el que queda no puede degradarse', async () => {
    const { app } = crearApp();
    const a = await entrarComo(app, 'admin', 'a@ejemplo.invalid');
    const b = await entrarComo(app, 'admin', 'b@ejemplo.invalid');
    expect(User.parse((await patch(app, a, b.userId, { role: 'analyst' })).body).role).toBe('analyst');
    expect((await patch(app, a, a.userId, { active: false })).status).toBe(409);
    expect(await db.user.count({ where: { role: 'admin', active: true } })).toBe(1);
  });

  it('cambiar el rol o desactivar cierra las sesiones del afectado (401) y deja auditoría', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const luis = await entrarComo(app, 'reporter', 'luis@ejemplo.invalid');

    expect(User.parse((await patch(app, admin, ana.userId, { role: 'analyst' })).body).role).toBe('analyst');
    expect(User.parse((await patch(app, admin, luis.userId, { active: false })).body).active).toBe(false);

    for (const quien of [ana, luis]) {
      const res = await request(app).get('/api/v1/auth/me').set('Cookie', quien.cookie);
      expect(res.status).toBe(401);
    }
    const acciones = (await db.auditEvent.findMany({ where: { actorId: admin.userId }, orderBy: { createdAt: 'asc' } })).map(
      (e) => e.action,
    );
    expect(acciones).toEqual(expect.arrayContaining(['user.role_change', 'user.deactivate']));
    // La desactivada tampoco puede volver a entrar.
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'luis@ejemplo.invalid', password: CLAVE });
    expect(login.status).toBe(401);
    expect(ErrorResponse.parse(login.body).code).toBe('invalid_credentials');
  });
});

describe('P-10 (aprox.) ráfagas: 429 con la forma del contrato', () => {
  it('superar el límite de login por IP responde 429 rate_limited', async () => {
    const { app } = crearApp({ RATE_LIMIT_LOGIN_PER_IP: '3' });
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/v1/auth/login').send({ email: `x${i}@ejemplo.invalid`, password: 'no-importa-123' });
    }
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'y@ejemplo.invalid', password: 'no-importa-123' });
    expect(res.status).toBe(429);
    expect(ErrorResponse.parse(res.body).code).toBe('rate_limited');
  });

  it('superar el límite global responde 429 rate_limited también con sesión de admin', async () => {
    const { app } = crearApp({ RATE_LIMIT_GLOBAL_PER_MINUTE: '5' });
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid'); // 1 petición
    for (let i = 0; i < 4; i++) {
      expect((await request(app).get('/api/v1/users').set('Cookie', admin.cookie)).status).toBe(200);
    }
    const res = await request(app).get('/api/v1/users').set('Cookie', admin.cookie);
    expect(res.status).toBe(429);
    expect(ErrorResponse.parse(res.body).code).toBe('rate_limited');
  });
});

describe('cabeceras de seguridad en rutas reales', () => {
  it('están en GET /users, en un 404 y en /auth, con Cache-Control: no-store', async () => {
    const { app } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const respuestas = [
      await request(app).get('/api/v1/users').set('Cookie', admin.cookie),
      await request(app).get('/api/v1/no-existe'),
      await request(app).get('/api/v1/auth/me').set('Cookie', admin.cookie),
    ];
    for (const res of respuestas) {
      expect(res.headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none';frame-ancestors 'none'",
        'cross-origin-resource-policy': 'same-origin',
      });
    }
  });
});

describe('registros (D-036) en /users', () => {
  it('ninguna línea contiene contraseñas, tokens de sesión, cookies ni tokens CSRF', async () => {
    const { app, lineas } = crearApp();
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'ana@ejemplo.invalid', password: 'MARCADOR_CLAVE_ANA_123', displayName: 'Ana' });
    const ana = { token: tokenDe(reg)!, csrf: Session.parse(reg.body).csrfToken, id: Session.parse(reg.body).user.id };

    await request(app).get('/api/v1/users?role=reporter').set('Cookie', admin.cookie);
    await request(app).get('/api/v1/users').set('Cookie', `cbl_session=${ana.token}`);
    await patch(app, { cookie: `cbl_session=${ana.token}`, csrf: ana.csrf }, ana.id, { role: 'admin' });
    await patch(app, admin, ana.id, { role: 'analyst' });
    await request(app).patch(`/api/v1/users/${ana.id}`).set('Cookie', admin.cookie).set('X-CSRF-Token', 'MARCADOR_CSRF_MALO');

    const todo = lineas.join('\n');
    expect(lineas.length).toBeGreaterThan(5);
    for (const secreto of ['MARCADOR_CLAVE_ANA_123', CLAVE, admin.token, admin.csrf, ana.token, ana.csrf, 'MARCADOR_CSRF_MALO']) {
      expect(todo).not.toContain(secreto);
    }
  });
});

describe('registros y auditoría (D-036) en /reports: nada del correo', () => {
  it('ni asunto, ni remitente, ni cuerpo, ni texto pegado, ni nombre del archivo', async () => {
    // R1 (sintético) con marcadores agregados al vuelo: el fixture en disco no cambia.
    const original = readFileSync(new URL('../fixtures/emails/R1-reply-to-distinto.eml', import.meta.url), 'latin1');
    const eml = Buffer.from(
      original.replace('Subject: Verifica tu cuenta', 'Subject: MARCADOR_ASUNTO_R1') + 'MARCADOR_CUERPO_R1\r\n',
      'latin1',
    );
    expect(eml.toString('latin1')).toContain('MARCADOR_CUERPO_R1');
    const remitente = 'soporte@banco-ejemplo.example';

    const { app, lineas } = crearApp({ MAX_EML_BYTES: String(eml.byteLength + 10) });
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const analista = await entrarComo(app, 'analyst', 'analista@ejemplo.invalid');
    const post = (ruta: string) => request(app).post(`/api/v1/reports${ruta}`).set('Cookie', ana.cookie).set('X-CSRF-Token', ana.csrf);

    const subida = await post('').attach('file', eml, { filename: 'MARCADOR_NOMBRE_ARCHIVO.eml' });
    expect(subida.status).toBe(202);
    const id = ReportSummary.parse(subida.body).id;
    expect((await post('/paste').send({ text: `Subject: MARCADOR_ASUNTO_PEGADO\n\nMARCADOR_PEGADO ${remitente}` })).status).toBe(202);
    // Errores: 415, 413 y 400 con marcadores en el nombre, el cuerpo y el nombre del campo.
    expect((await post('').attach('file', eml, { filename: 'MARCADOR_NOMBRE_415.txt', contentType: 'text/plain' })).status).toBe(415);
    expect((await post('').attach('file', Buffer.concat([eml, eml]), { filename: 'MARCADOR_NOMBRE_413.eml' })).status).toBe(413);
    expect((await post('').field('MARCADOR_CAMPO', 'MARCADOR_VALOR').attach('file', eml, { filename: 'c.eml' })).status).toBe(400);
    expect((await post('/paste').send({ text: '', MARCADOR_EXTRA: 'MARCADOR_VALOR_JSON' })).status).toBe(400);
    // Consultas y borrado.
    await request(app).get('/api/v1/reports').set('Cookie', analista.cookie);
    await request(app).get(`/api/v1/reports/${id}`).set('Cookie', analista.cookie);
    await request(app).get(`/api/v1/reports/${id}/findings`).set('Cookie', analista.cookie);
    expect((await request(app).delete(`/api/v1/reports/${id}`).set('Cookie', ana.cookie).set('X-CSRF-Token', ana.csrf)).status).toBe(204);

    const registros = lineas.join('\n');
    expect(lineas.length).toBeGreaterThan(8);
    expect(registros).not.toContain('MARCADOR_');
    expect(registros).not.toContain(remitente);

    const auditoria = JSON.stringify(await db.auditEvent.findMany({ where: { action: { startsWith: 'report.' } } }));
    expect(auditoria).toContain('report.create');
    expect(auditoria).toContain('report.delete');
    expect(auditoria).not.toContain('MARCADOR_');
    expect(auditoria).not.toContain(remitente);
  });
});
