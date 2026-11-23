import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { ensureFirstAdmin } from '../../src/auth/bootstrap.js';
import { sha256Hex } from '../../src/auth/crypto.js';
import { createDecoyHash } from '../../src/auth/password.js';
import { SESSION_IDLE_TIMEOUT_MS } from '../../src/auth/session.js';
import { Session } from '../../src/contract/schemas/auth.js';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { createDb } from '../../src/db/client.js';
import { createLogger } from '../../src/logger.js';
import { fakeStorage, testConfig } from '../helpers.js';
import { testDatabaseUrl } from './test-db.js';

const db = createDb(testDatabaseUrl());
const decoyHash = await createDecoyHash();

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE report_links, findings, reports, audit_events, sessions, users');
});

function crearApp(overrides: NodeJS.ProcessEnv = {}) {
  const lineas: string[] = [];
  const logger = createLogger('info', { write: (linea: string) => void lineas.push(linea) });
  const config = testConfig({ DATABASE_URL: testDatabaseUrl(), ...overrides });
  return { app: createApp({ logger, db, config, decoyHash, storage: fakeStorage() }), lineas, logger, config };
}

const CLAVE = 'una-clave-de-prueba-larga';
const ANA = { email: 'ana@ejemplo.invalid', password: CLAVE, displayName: 'Ana Prueba' };

/** Token de la cookie cbl_session de una respuesta (o undefined). */
function tokenDe(res: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('cbl_session=') && !c.startsWith('cbl_session=;'));
  return cookie?.split(';')[0]?.slice('cbl_session='.length);
}

async function registrar(app: Parameters<typeof request>[0], datos = ANA) {
  const res = await request(app).post('/api/v1/auth/register').send(datos);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { res, token: tokenDe(res)!, sesion: Session.parse(res.body) };
}

describe('POST /auth/register', () => {
  it('crea la cuenta como reportante con el email normalizado e inicia sesión', async () => {
    const { app } = crearApp();
    const { res, token, sesion } = await registrar(app, { ...ANA, email: 'Ana@Ejemplo.INVALID' });

    expect(sesion.user).toMatchObject({ email: 'ana@ejemplo.invalid', displayName: 'Ana Prueba', role: 'reporter', active: true });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);

    const eventos = await db.auditEvent.findMany();
    expect(eventos).toEqual([
      expect.objectContaining({ action: 'auth.register', result: 'success', actorId: sesion.user.id, requestId: expect.any(String) }),
    ]);
  });

  it('responde 409 email_taken con el mismo correo en otra capitalización', async () => {
    const { app } = crearApp();
    await registrar(app);
    const res = await request(app).post('/api/v1/auth/register').send({ ...ANA, email: 'ANA@EJEMPLO.INVALID' });
    expect(res.status).toBe(409);
    expect(ErrorResponse.parse(res.body).code).toBe('email_taken');
  });

  it('con INVITE_CODE, el código correcto permite registrarse', async () => {
    const { app } = crearApp({ INVITE_CODE: 'codigo-de-prueba' });
    await registrar(app, { ...ANA, inviteCode: 'codigo-de-prueba' } as typeof ANA);
  });
});

describe('POST /auth/login', () => {
  it('con credenciales correctas responde 200 Session y crea una sesión nueva', async () => {
    const { app } = crearApp();
    const { sesion: alta } = await registrar(app);
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'ANA@ejemplo.invalid', password: CLAVE });
    expect(res.status).toBe(200);
    const sesion = Session.parse(res.body);
    expect(sesion.user.id).toBe(alta.user.id);
    expect(sesion.csrfToken).not.toBe(alta.csrfToken);
    expect(await db.session.count()).toBe(2);
  });

  it('si trae una sesión previa, la borra antes de crear la nueva', async () => {
    const { app } = crearApp();
    const { token } = await registrar(app);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Cookie', `cbl_session=${token}`)
      .send({ email: ANA.email, password: CLAVE });
    expect(res.status).toBe(200);
    expect(await db.session.count({ where: { tokenHash: sha256Hex(token) } })).toBe(0);
    expect(await db.session.count()).toBe(1);
  });

  it('contraseña incorrecta y cuenta inexistente dan el mismo 401 invalid_credentials', async () => {
    const { app } = crearApp();
    await registrar(app);
    const mala = await request(app).post('/api/v1/auth/login').send({ email: ANA.email, password: 'otra-clave-cualquiera' });
    const inexistente = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'MARCADOR_NADIE@ejemplo.invalid', password: 'otra-clave-cualquiera' });

    for (const res of [mala, inexistente]) {
      expect(res.status).toBe(401);
      expect(tokenDe(res)).toBeUndefined();
    }
    const a = ErrorResponse.parse(mala.body);
    const b = ErrorResponse.parse(inexistente.body);
    expect({ ...a, requestId: '' }).toEqual({ ...b, requestId: '' });
    expect(a.code).toBe('invalid_credentials');

    // La auditoría guarda el motivo, nunca el correo intentado ni la contraseña.
    const fallos = await db.auditEvent.findMany({ where: { action: 'auth.login', result: 'failure' } });
    expect(fallos.map((e) => (e.metadata as { reason: string }).reason).sort()).toEqual(['bad_password', 'unknown_account']);
    const textoAuditoria = JSON.stringify(await db.auditEvent.findMany());
    expect(textoAuditoria).not.toContain('MARCADOR_NADIE');
    expect(textoAuditoria).not.toContain('otra-clave-cualquiera');
  });

  it('una cuenta desactivada no puede entrar (401 invalid_credentials)', async () => {
    const { app } = crearApp();
    const { sesion } = await registrar(app);
    await db.user.update({ where: { id: sesion.user.id }, data: { active: false } });
    const res = await request(app).post('/api/v1/auth/login').send({ email: ANA.email, password: CLAVE });
    expect(res.status).toBe(401);
    expect(ErrorResponse.parse(res.body).code).toBe('invalid_credentials');
  });
});

describe('sesión, /auth/me y /auth/logout', () => {
  it('/auth/me con la cookie devuelve la Session del contrato', async () => {
    const { app } = crearApp();
    const { token, sesion } = await registrar(app);
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', `cbl_session=${token}`);
    expect(res.status).toBe(200);
    expect(Session.parse(res.body)).toEqual(sesion);
  });

  it('/auth/me sin sesión responde 401', async () => {
    const { app } = crearApp();
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(ErrorResponse.parse(res.body).code).toBe('unauthenticated');
  });

  it('logout sin X-CSRF-Token o con uno incorrecto responde 403 y la sesión sigue viva', async () => {
    const { app } = crearApp();
    const { token } = await registrar(app);
    const sin = await request(app).post('/api/v1/auth/logout').set('Cookie', `cbl_session=${token}`);
    const mal = await request(app).post('/api/v1/auth/logout').set('Cookie', `cbl_session=${token}`).set('X-CSRF-Token', 'incorrecto');
    for (const res of [sin, mal]) {
      expect(res.status).toBe(403);
      expect(ErrorResponse.parse(res.body).code).toBe('forbidden');
    }
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', `cbl_session=${token}`)).status).toBe(200);
  });

  it('logout con el token CSRF borra la sesión y la cookie deja de servir', async () => {
    const { app } = crearApp();
    const { token, sesion } = await registrar(app);
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `cbl_session=${token}`)
      .set('X-CSRF-Token', sesion.csrfToken);
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/cbl_session=;/);
    expect(await db.session.count()).toBe(0);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', `cbl_session=${token}`)).status).toBe(401);
    expect(await db.auditEvent.count({ where: { action: 'auth.logout', actorId: sesion.user.id } })).toBe(1);
  });

  it('una sesión con vencimiento absoluto pasado responde 401 y se borra', async () => {
    const { app } = crearApp();
    const { token } = await registrar(app);
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', `cbl_session=${token}`)).status).toBe(401);
    expect(await db.session.count()).toBe(0);
  });

  it('una sesión inactiva más de 30 min responde 401', async () => {
    const { app } = crearApp();
    const { token } = await registrar(app);
    await db.session.updateMany({ data: { lastActivityAt: new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 1000) } });
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', `cbl_session=${token}`)).status).toBe(401);
  });

  it('la actividad renueva lastActivityAt', async () => {
    const { app } = crearApp();
    const { token } = await registrar(app);
    const hace = new Date(Date.now() - 5 * 60 * 1000);
    await db.session.updateMany({ data: { lastActivityAt: hace } });
    await request(app).get('/api/v1/auth/me').set('Cookie', `cbl_session=${token}`);
    const sesion = await db.session.findFirstOrThrow();
    expect(sesion.lastActivityAt.getTime()).toBeGreaterThan(hace.getTime());
  });

  it('si la cuenta se desactiva, su sesión deja de valer (401)', async () => {
    const { app } = crearApp();
    const { token, sesion } = await registrar(app);
    await db.user.update({ where: { id: sesion.user.id }, data: { active: false } });
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', `cbl_session=${token}`)).status).toBe(401);
  });

  it('en la base solo está el SHA-256 del token, nunca el token', async () => {
    const { app } = crearApp();
    const { token } = await registrar(app);
    const filas = await db.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM sessions');
    expect(filas).toHaveLength(1);
    expect(filas[0]?.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(filas)).not.toContain(token);
  });
});

describe('límite de fallos de login por correo', () => {
  it('tras N fallos responde 429 aunque la contraseña sea correcta; otro correo no se afecta', async () => {
    const { app } = crearApp({ RATE_LIMIT_LOGIN_FAILS_PER_EMAIL: '2' });
    await registrar(app);
    await registrar(app, { ...ANA, email: 'luis@ejemplo.invalid' });
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post('/api/v1/auth/login').send({ email: ANA.email, password: 'clave-mala-123' })).status).toBe(401);
    }
    const bloqueado = await request(app).post('/api/v1/auth/login').send({ email: 'Ana@Ejemplo.invalid', password: CLAVE });
    expect(bloqueado.status).toBe(429);
    expect(ErrorResponse.parse(bloqueado.body).code).toBe('rate_limited');
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'luis@ejemplo.invalid', password: CLAVE })).status).toBe(200);
  });

  it('los logins correctos no gastan intentos', async () => {
    const { app } = crearApp({ RATE_LIMIT_LOGIN_FAILS_PER_EMAIL: '2' });
    await registrar(app);
    for (let i = 0; i < 4; i++) {
      expect((await request(app).post('/api/v1/auth/login').send({ email: ANA.email, password: CLAVE })).status).toBe(200);
    }
  });
});

describe('registros (D-036) en las rutas de /auth', () => {
  it('ninguna línea contiene contraseña, token de sesión, cookie ni token CSRF', async () => {
    const { app, lineas } = crearApp();
    const clave = 'MARCADOR_CLAVE_SECRETA_123';
    const { token, sesion } = await registrar(app, { ...ANA, password: clave });
    const login = await request(app).post('/api/v1/auth/login').send({ email: ANA.email, password: clave });
    const token2 = tokenDe(login)!;
    const csrf2 = Session.parse(login.body).csrfToken;
    await request(app).post('/api/v1/auth/login').send({ email: ANA.email, password: 'MARCADOR_CLAVE_MALA_456' });
    await request(app).get('/api/v1/auth/me').set('Cookie', `cbl_session=${token2}`);
    await request(app).post('/api/v1/auth/logout').set('Cookie', `cbl_session=${token2}`).set('X-CSRF-Token', csrf2);

    const todo = lineas.join('\n');
    expect(lineas.length).toBeGreaterThan(4);
    for (const secreto of [clave, 'MARCADOR_CLAVE_MALA_456', token, token2, sesion.csrfToken, csrf2]) {
      expect(todo).not.toContain(secreto);
    }
  });
});

describe('primer administrador', () => {
  const env = { FIRST_ADMIN_EMAIL: 'Admin@Ejemplo.invalid', FIRST_ADMIN_PASSWORD: 'MARCADOR_CLAVE_ADMIN_789' };

  it('se crea una vez, puede entrar y queda como system.bootstrap_admin', async () => {
    const { config, logger, lineas, app } = crearApp(env);
    expect(await ensureFirstAdmin(db, config, logger)).toBe('created');
    expect(await ensureFirstAdmin(db, config, logger)).toBe('admin_exists');

    const admins = await db.user.findMany({ where: { role: 'admin' } });
    expect(admins).toHaveLength(1);
    expect(admins[0]).toMatchObject({ email: 'admin@ejemplo.invalid', displayName: 'Administrador', active: true });

    const evento = await db.auditEvent.findFirstOrThrow({ where: { action: 'system.bootstrap_admin' } });
    expect(evento).toMatchObject({ requestId: null, actorId: null, result: 'success', targetType: 'user', targetId: admins[0]?.id });

    const res = await request(app).post('/api/v1/auth/login').send({ email: 'admin@ejemplo.invalid', password: env.FIRST_ADMIN_PASSWORD });
    expect(Session.parse(res.body).user.role).toBe('admin');
    expect(lineas.join('\n')).not.toContain(env.FIRST_ADMIN_PASSWORD);
  });

  it('no toca una cuenta existente con ese correo', async () => {
    const { config, logger, app } = crearApp(env);
    await registrar(app, { ...ANA, email: 'admin@ejemplo.invalid' });
    expect(await ensureFirstAdmin(db, config, logger)).toBe('email_in_use');
    expect(await db.user.count({ where: { role: 'admin' } })).toBe(0);
  });

  it('sin las variables no hace nada', async () => {
    const { config, logger } = crearApp();
    expect(await ensureFirstAdmin(db, config, logger)).toBe('skipped');
  });
});
