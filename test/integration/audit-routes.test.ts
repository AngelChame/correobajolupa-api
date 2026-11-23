import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../../src/audit.js';
import { AuditList } from '../../src/contract/schemas/audit.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// GET /audit (M7): filtros, orden, paginación, permisos y que metadata no filtre datos (P-18).
type App = Parameters<typeof request>[0];
const get = (a: App, s: Sesion, query = '') => request(a).get(`/api/v1/audit${query}`).set('Cookie', s.cookie);

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

async function evento(at: string, extra: Partial<Parameters<typeof recordAudit>[1]> = {}) {
  await recordAudit(db, { action: 'report.create', result: 'success', ...extra });
  const ultimo = await db.auditEvent.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  await db.auditEvent.update({ where: { id: ultimo.id }, data: { createdAt: new Date(at) } });
  return ultimo.id;
}

describe('GET /audit', () => {
  it('401 sin sesión y 403 al reportante (auditado como authz.denied)', async () => {
    const { app: a } = crearApp();
    expect((await request(a).get('/api/v1/audit')).status).toBe(401);
    const r = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    const res = await get(a, r);
    expect(res.status).toBe(403);
    expect(await db.auditEvent.count({ where: { action: 'authz.denied', actorId: r.userId } })).toBe(1);
  });

  it('lista con la forma del contrato, de lo más reciente a lo más viejo, con actor o null en eventos del sistema', async () => {
    const { app: a } = crearApp();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await db.auditEvent.deleteMany();
    const viejo = await evento('2026-11-20T10:00:00.000Z', { action: 'system.cleanup', metadata: { expiredReports: 2 } });
    const nuevo = await evento('2026-11-21T10:00:00.000Z', { actorId: s.userId, requestId: 'req-x', targetType: 'report', targetId: 'abc', metadata: { source: 'eml' } });

    const res = await get(a, s);
    expect(res.status).toBe(200);
    const lista = AuditList.parse(res.body);
    expect(lista).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    expect(lista.items.map((e) => e.id)).toEqual([nuevo, viejo]);
    expect(lista.items[0]).toEqual({
      id: nuevo,
      at: '2026-11-21T10:00:00.000Z',
      action: 'report.create',
      result: 'success',
      actor: { id: s.userId, displayName: 'Persona analyst' },
      targetType: 'report',
      targetId: 'abc',
      requestId: 'req-x',
      metadata: { source: 'eml' },
    });
    expect(lista.items[1]).toMatchObject({ action: 'system.cleanup', actor: null, requestId: null, metadata: { expiredReports: 2 } });
  });

  it('filtros action (exacta), actorId, from y to (inclusive) y paginación', async () => {
    const { app: a } = crearApp();
    const s = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    await db.auditEvent.deleteMany();
    for (let d = 1; d <= 5; d++) await evento(`2026-11-0${d}T12:00:00.000Z`, { actorId: d % 2 ? s.userId : null });
    await evento('2026-11-06T12:00:00.000Z', { action: 'report.delete', actorId: s.userId });

    const porAccion = AuditList.parse((await get(a, s, '?action=report.delete')).body);
    expect(porAccion.total).toBe(1);
    // Igualdad exacta: ni prefijo ni mayúsculas.
    expect(AuditList.parse((await get(a, s, '?action=report')).body).total).toBe(0);
    expect(AuditList.parse((await get(a, s, '?action=REPORT.DELETE')).body).total).toBe(0);

    expect(AuditList.parse((await get(a, s, `?actorId=${s.userId}`)).body).total).toBe(4);
    const rango = AuditList.parse((await get(a, s, '?from=2026-11-02T12:00:00.000Z&to=2026-11-04T12:00:00.000Z')).body);
    expect(rango.items.map((e) => e.at)).toEqual(['2026-11-04T12:00:00.000Z', '2026-11-03T12:00:00.000Z', '2026-11-02T12:00:00.000Z']);
    expect(AuditList.parse((await get(a, s, '?from=2026-11-05T00:00:00Z&action=report.create')).body).total).toBe(1);

    const p1 = AuditList.parse((await get(a, s, '?pageSize=4')).body);
    const p2 = AuditList.parse((await get(a, s, '?pageSize=4&page=2')).body);
    expect(p1.items).toHaveLength(4);
    expect(p2.items).toHaveLength(2);
    expect(new Set([...p1.items, ...p2.items].map((e) => e.id)).size).toBe(6);
    expect(p1.total).toBe(6);
  });

  it('400: fechas inválidas, from > to, actorId mal formado o paginación fuera de rango', async () => {
    const { app: a } = crearApp();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    for (const q of ['?from=ayer', '?to=2026-13-01T00:00:00Z', '?from=2026-11-05T00:00:00Z&to=2026-11-01T00:00:00Z', '?actorId=MARCADOR', '?page=0', '?pageSize=101']) {
      const res = await get(a, s, q);
      expect(res.status, q).toBe(400);
      expect(res.body.code).toBe('validation_error');
      expect(JSON.stringify(res.body)).not.toContain('MARCADOR');
    }
  });

  it('metadata pasa solo si es un objeto de JSON; lo demás sale como {}', async () => {
    const { app: a } = crearApp();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await db.auditEvent.deleteMany();
    for (const metadata of [['lista'], 'texto', 7]) await db.auditEvent.create({ data: { action: 'report.create', result: 'success', metadata } });
    await db.auditEvent.create({ data: { action: 'report.create', result: 'success' } });
    const lista = AuditList.parse((await get(a, s)).body);
    expect(lista.items.map((e) => e.metadata)).toEqual([{}, {}, {}, {}]);
  });

  it('los eventos que dejan las rutas no llevan correos, contraseñas, tokens ni textos del cliente', async () => {
    const { app: a } = crearApp();
    // Entrada fallida con un correo y una contraseña marcados.
    await request(a).post('/api/v1/auth/login').send({ email: 'marcador-correo@ejemplo.invalid', password: 'MARCADOR_CLAVE_123456' });
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    // Incidente con título y comentario marcados, y un rechazo con texto del cliente.
    const inc = await request(a).post('/api/v1/incidents').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send({ title: 'MARCADOR titulo', description: 'MARCADOR descripcion' });
    await request(a).post(`/api/v1/incidents/${inc.body.id}/comments`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send({ body: 'MARCADOR comentario' });
    await request(a).post(`/api/v1/incidents/${inc.body.id}/quarantine`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send({ messageIds: ['MARCADOR'], confirm: true });

    const res = await get(a, s, '?pageSize=100');
    const texto = JSON.stringify(res.body);
    expect(AuditList.parse(res.body).total).toBeGreaterThanOrEqual(5);
    expect(texto).not.toContain('marcador-correo');
    expect(texto).not.toContain('MARCADOR');
    expect(texto).not.toContain(s.token);
    expect(texto).not.toContain(s.csrf);
  });
});
