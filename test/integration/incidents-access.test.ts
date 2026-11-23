import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { IncidentDetail } from '../../src/contract/schemas/incidents.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Incidentes (M6): acceso por rol (401, 403, CSRF), P-08 sobre acciones de analista y P-18
// (ni el título, ni la descripción ni los comentarios llegan a los registros ni a la auditoría).
type App = Parameters<typeof request>[0];
const ID = '00000000-0000-4000-8000-000000000000';
const OTRO = '00000000-0000-4000-8000-000000000001';

type Metodo = 'get' | 'post' | 'patch' | 'delete';
/** Las 9 rutas de M6 con un cuerpo válido (la cuarentena y las acciones son de M7). */
const RUTAS: [Metodo, string, string, Record<string, unknown> | undefined][] = [
  ['post', '/incidents', '/api/v1/incidents', { title: 'Campaña' }],
  ['get', '/incidents', '/api/v1/incidents', undefined],
  ['get', '/incidents/:incidentId', `/api/v1/incidents/${ID}`, undefined],
  ['patch', '/incidents/:incidentId', `/api/v1/incidents/${ID}`, { status: 'analyzing' }],
  ['post', '/incidents/:incidentId/reports', `/api/v1/incidents/${ID}/reports`, { reportId: OTRO }],
  ['delete', '/incidents/:incidentId/reports/:reportId', `/api/v1/incidents/${ID}/reports/${OTRO}`, undefined],
  ['post', '/incidents/:incidentId/indicators', `/api/v1/incidents/${ID}/indicators`, { indicatorId: OTRO }],
  ['delete', '/incidents/:incidentId/indicators/:indicatorId', `/api/v1/incidents/${ID}/indicators/${OTRO}`, undefined],
  ['post', '/incidents/:incidentId/comments', `/api/v1/incidents/${ID}/comments`, { body: 'nota' }],
];

function pedir(a: App, metodo: Metodo, url: string, body: Record<string, unknown> | undefined, s?: Sesion, csrf = true) {
  let req = request(a)[metodo](url);
  if (s) req = req.set('Cookie', s.cookie);
  if (s && csrf) req = req.set('X-CSRF-Token', s.csrf);
  return body ? req.send(body) : req;
}

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

describe('acceso a /incidents', () => {
  it('401 sin sesión en las 9 rutas', async () => {
    const { app: a } = crearApp();
    for (const [metodo, , url, body] of RUTAS) {
      const res = await pedir(a, metodo, url, body);
      expect(res.status, `${metodo} ${url}`).toBe(401);
      expect(ErrorResponse.parse(res.body).code).toBe('unauthenticated');
    }
  });

  it('403 al reportante en las 9 rutas, auditado como authz.denied con el patrón de la ruta (no la URL)', async () => {
    const { app: a } = crearApp();
    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    for (const [metodo, , url, body] of RUTAS) {
      const res = await pedir(a, metodo, url, body, reportante);
      expect(res.status, `${metodo} ${url}`).toBe(403);
      expect(ErrorResponse.parse(res.body).code).toBe('forbidden');
    }
    const eventos = await db.auditEvent.findMany({ where: { action: 'authz.denied', actorId: reportante.userId }, orderBy: { createdAt: 'asc' } });
    expect(eventos.map((e) => (e.metadata as { route: string }).route)).toEqual(RUTAS.map(([, patron]) => `/api/v1${patron}`));
    expect(JSON.stringify(eventos)).not.toContain(ID);
  });

  it('403 sin token CSRF en las 7 rutas que modifican, aun para un administrador', async () => {
    const { app: a } = crearApp();
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    for (const [metodo, , url, body] of RUTAS.filter(([m]) => m !== 'get')) {
      const res = await pedir(a, metodo, url, body, admin, false);
      expect(res.status, `${metodo} ${url}`).toBe(403);
    }
    expect(await db.incident.count()).toBe(0);
  });

  it('analista y administrador pueden actuar sobre un incidente creado por el otro', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    const id = IncidentDetail.parse((await pedir(a, 'post', '/api/v1/incidents', { title: 'Del analista' }, analista).expect(201)).body).id;
    await pedir(a, 'patch', `/api/v1/incidents/${id}`, { status: 'analyzing' }, admin).expect(200);
    await pedir(a, 'post', `/api/v1/incidents/${id}/comments`, { body: 'visto' }, admin).expect(201);
    expect(IncidentDetail.parse((await pedir(a, 'get', `/api/v1/incidents/${id}`, undefined, admin).expect(200)).body)).toMatchObject({
      status: 'analyzing',
      createdBy: { id: analista.userId },
      comments: [{ author: { id: admin.userId } }],
    });
  });
});

describe('P-08 sobre acciones de analista', () => {
  it('un reportante no puede ver, crear, cambiar, asociar ni comentar un incidente existente; nada cambia', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    const id = IncidentDetail.parse((await pedir(a, 'post', '/api/v1/incidents', { title: 'Real' }, analista).expect(201)).body).id;
    const suyo = (await db.report.create({ data: { userId: reportante.userId, source: 'eml', storageKey: 'k/x', sizeBytes: 1, sha256: 'a'.repeat(64) } })).id;
    const antes = await db.incident.findUniqueOrThrow({ where: { id } });

    for (const [metodo, , url, body] of RUTAS) {
      const real = url.replace(ID, id).replace(OTRO, suyo);
      const res = await pedir(a, metodo, real, body && 'reportId' in body ? { reportId: suyo } : body, reportante);
      expect(res.status, `${metodo} ${real}`).toBe(403);
      // La respuesta no filtra nada del incidente.
      expect(JSON.stringify(res.body)).not.toContain('Real');
    }
    expect(await db.incident.findUniqueOrThrow({ where: { id } })).toEqual(antes);
    expect(await db.incident.count()).toBe(1);
    expect(await db.incidentReport.count()).toBe(0);
    expect(await db.incidentComment.count()).toBe(0);
  });

  it('asignación masiva: crear y actualizar ignoran id, status inicial, createdBy y conteos que mande el cliente', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    const res = await pedir(a, 'post', '/api/v1/incidents', { title: 'Campaña', id: ID, status: 'closed', createdById: admin.userId, createdBy: { id: admin.userId }, reportsCount: 9 }, analista);
    expect(res.status).toBe(201);
    const inc = IncidentDetail.parse(res.body);
    expect(inc).toMatchObject({ status: 'received', createdBy: { id: analista.userId }, reportsCount: 0 });
    expect(inc.id).not.toBe(ID);

    const upd = await pedir(a, 'patch', `/api/v1/incidents/${inc.id}`, { title: 'Nuevo', createdById: admin.userId, createdAt: '2000-01-01T00:00:00.000Z', id: ID }, analista);
    expect(upd.status).toBe(200);
    expect(IncidentDetail.parse(upd.body)).toMatchObject({ id: inc.id, title: 'Nuevo', createdBy: { id: analista.userId }, createdAt: inc.createdAt });
  });
});

describe('P-18: texto de usuario fuera de registros y auditoría', () => {
  it('ni el título, ni la descripción ni los comentarios aparecen en pino ni en la auditoría', async () => {
    const { app: a, lineas } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const TITULO = 'titulo-confidencial-7f3a';
    const DESC = 'descripcion-confidencial-91bc';
    const COMENTARIO = 'comentario-confidencial-c0de';
    const id = IncidentDetail.parse((await pedir(a, 'post', '/api/v1/incidents', { title: TITULO, description: DESC }, analista).expect(201)).body).id;
    await pedir(a, 'patch', `/api/v1/incidents/${id}`, { title: `${TITULO}-2`, description: `${DESC}-2`, status: 'analyzing' }, analista).expect(200);
    await pedir(a, 'post', `/api/v1/incidents/${id}/comments`, { body: COMENTARIO }, analista).expect(201);
    // Rechazos con el texto en el cuerpo.
    await pedir(a, 'patch', `/api/v1/incidents/${id}`, { title: TITULO, status: 'closed' }, analista).expect(409);
    await pedir(a, 'post', `/api/v1/incidents/${id}/comments`, { body: `${COMENTARIO}${'x'.repeat(2000)}` }, analista).expect(400);
    await pedir(a, 'get', `/api/v1/incidents/${id}`, undefined, analista).expect(200);
    await pedir(a, 'get', '/api/v1/incidents', undefined, analista).expect(200);

    const auditoria = JSON.stringify(await db.auditEvent.findMany());
    const registros = lineas.join('\n');
    expect(registros.length).toBeGreaterThan(0);
    for (const secreto of [TITULO, DESC, COMENTARIO]) {
      expect(auditoria).not.toContain(secreto);
      expect(registros).not.toContain(secreto);
    }
    // La auditoría de éxito sí deja rastro de qué pasó, solo con nombres, estados, IDs y longitudes.
    const update = await db.auditEvent.findFirstOrThrow({ where: { action: 'incident.update', result: 'success' } });
    expect(update.metadata).toEqual({ fields: ['title', 'description', 'status'], fromStatus: 'received', toStatus: 'analyzing' });
    const comentario = await db.auditEvent.findFirstOrThrow({ where: { action: 'incident.comment', result: 'success' } });
    expect(comentario.metadata).toMatchObject({ length: COMENTARIO.length });
  });
});
