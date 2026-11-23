import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IncidentDetail } from '../../src/contract/schemas/incidents.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Incidentes (M6): los 400, 404 y 409 de las rutas que modifican quedan en la auditoría con el
// motivo y solo IDs ya validados; nunca el título, la descripción, el comentario ni un ID mal formado.
type App = Parameters<typeof request>[0];
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';
const MAL_FORMADO = 'no-es-uuid-secreto';

const enviar = (a: App, s: Sesion, metodo: 'post' | 'patch' | 'delete', ruta: string, body?: Record<string, unknown>) => {
  const req = request(a)[metodo](`/api/v1${ruta}`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
  return body ? req.send(body) : req;
};

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

describe('rechazos auditados', () => {
  it('cada rechazo de las 7 rutas que modifican queda con su motivo, sin texto del cliente ni IDs mal formados', async () => {
    const { app: a, lineas } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const abierto = IncidentDetail.parse((await enviar(a, analista, 'post', '/incidents', { title: 'Abierto' }).expect(201)).body).id;
    const cerrado = IncidentDetail.parse((await enviar(a, analista, 'post', '/incidents', { title: 'Cerrado' }).expect(201)).body).id;
    const reporte = (await db.report.create({ data: { userId: analista.userId, source: 'eml', storageKey: 'k/x', sizeBytes: 1, sha256: 'a'.repeat(64) } })).id;
    const indicador = (await db.indicator.create({ data: { type: 'domain', value: 'malo.example', proposedById: analista.userId } })).id;
    await enviar(a, analista, 'post', `/incidents/${abierto}/reports`, { reportId: reporte }).expect(200);
    await enviar(a, analista, 'post', `/incidents/${abierto}/indicators`, { indicatorId: indicador }).expect(200);
    await db.incident.update({ where: { id: cerrado }, data: { status: 'closed' } });
    await db.auditEvent.deleteMany();

    const TEXTO = 'texto-hostil-del-cliente';
    // [método, ruta, cuerpo, estado esperado, acción, targetId esperado, metadata esperada]
    const casos: [('post' | 'patch' | 'delete'), string, Record<string, unknown> | undefined, number, string, string | null, Record<string, unknown>][] = [
      ['post', '/incidents', { title: '', description: TEXTO }, 400, 'incident.create', null, { reason: 'invalid_body' }],

      ['patch', `/incidents/${abierto}`, { title: 't'.repeat(121) + TEXTO }, 400, 'incident.update', abierto, { reason: 'invalid_body' }],
      ['patch', `/incidents/${MAL_FORMADO}`, { title: TEXTO }, 404, 'incident.update', null, { reason: 'not_found' }],
      ['patch', `/incidents/${UUID_INEXISTENTE}`, { title: TEXTO }, 404, 'incident.update', UUID_INEXISTENTE, { reason: 'not_found' }],
      ['patch', `/incidents/${cerrado}`, { title: TEXTO }, 409, 'incident.update', cerrado, { reason: 'final' }],
      ['patch', `/incidents/${abierto}`, { status: 'closed', description: TEXTO }, 409, 'incident.update', abierto, { reason: 'invalid_transition' }],

      ['post', `/incidents/${abierto}/reports`, { reportId: MAL_FORMADO }, 400, 'incident.report_add', abierto, { reason: 'invalid_body' }],
      ['post', `/incidents/${MAL_FORMADO}/reports`, { reportId: reporte }, 404, 'incident.report_add', null, { reason: 'not_found', reportId: reporte }],
      ['post', `/incidents/${UUID_INEXISTENTE}/reports`, { reportId: reporte }, 404, 'incident.report_add', UUID_INEXISTENTE, { reason: 'not_found', reportId: reporte }],
      ['post', `/incidents/${abierto}/reports`, { reportId: UUID_INEXISTENTE }, 404, 'incident.report_add', abierto, { reason: 'report_not_found', reportId: UUID_INEXISTENTE }],
      ['post', `/incidents/${abierto}/reports`, { reportId: reporte }, 409, 'incident.report_add', abierto, { reason: 'already_linked', reportId: reporte }],
      ['post', `/incidents/${cerrado}/reports`, { reportId: reporte }, 409, 'incident.report_add', cerrado, { reason: 'final', reportId: reporte }],

      ['delete', `/incidents/${MAL_FORMADO}/reports/${reporte}`, undefined, 404, 'incident.report_remove', null, { reason: 'not_found', reportId: reporte }],
      ['delete', `/incidents/${abierto}/reports/${MAL_FORMADO}`, undefined, 404, 'incident.report_remove', abierto, { reason: 'not_linked' }],
      ['delete', `/incidents/${abierto}/reports/${UUID_INEXISTENTE}`, undefined, 404, 'incident.report_remove', abierto, { reason: 'not_linked', reportId: UUID_INEXISTENTE }],
      ['delete', `/incidents/${cerrado}/reports/${reporte}`, undefined, 409, 'incident.report_remove', cerrado, { reason: 'final', reportId: reporte }],

      ['post', `/incidents/${abierto}/indicators`, {}, 400, 'incident.indicator_add', abierto, { reason: 'invalid_body' }],
      ['post', `/incidents/${abierto}/indicators`, { indicatorId: UUID_INEXISTENTE }, 404, 'incident.indicator_add', abierto, { reason: 'indicator_not_found', indicatorId: UUID_INEXISTENTE }],
      ['post', `/incidents/${abierto}/indicators`, { indicatorId: indicador }, 409, 'incident.indicator_add', abierto, { reason: 'already_linked', indicatorId: indicador }],
      ['delete', `/incidents/${UUID_INEXISTENTE}/indicators/${indicador}`, undefined, 404, 'incident.indicator_remove', UUID_INEXISTENTE, { reason: 'not_found', indicatorId: indicador }],
      ['delete', `/incidents/${cerrado}/indicators/${indicador}`, undefined, 409, 'incident.indicator_remove', cerrado, { reason: 'final', indicatorId: indicador }],

      ['post', `/incidents/${abierto}/comments`, { body: '' }, 400, 'incident.comment', abierto, { reason: 'invalid_body' }],
      ['post', `/incidents/${MAL_FORMADO}/comments`, { body: TEXTO }, 404, 'incident.comment', null, { reason: 'not_found' }],
      ['post', `/incidents/${UUID_INEXISTENTE}/comments`, { body: TEXTO }, 404, 'incident.comment', UUID_INEXISTENTE, { reason: 'not_found' }],
      ['post', `/incidents/${cerrado}/comments`, { body: TEXTO }, 409, 'incident.comment', cerrado, { reason: 'final' }],
    ];

    for (const [metodo, ruta, body, estado, action, targetId, metadata] of casos) {
      const caso = `${metodo} ${ruta}`;
      const antes = await db.auditEvent.count();
      const res = await enviar(a, analista, metodo, ruta, body);
      expect(res.status, caso).toBe(estado);
      expect(JSON.stringify(res.body), caso).not.toContain(TEXTO);
      const eventos = await db.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 1 });
      expect(await db.auditEvent.count(), caso).toBe(antes + 1);
      expect(eventos[0], caso).toMatchObject({ action, result: 'failure', actorId: analista.userId, targetType: 'incident', targetId, metadata });
      expect(eventos[0]!.requestId, caso).toBe(res.headers['x-request-id']);
    }

    // Ninguno guardó texto del cliente ni el ID mal formado; los registros tampoco tienen el texto.
    const todo = JSON.stringify(await db.auditEvent.findMany());
    expect(todo).not.toContain(TEXTO);
    expect(todo).not.toContain(MAL_FORMADO);
    expect(lineas.join('\n')).not.toContain(TEXTO);
    // Nada cambió.
    expect(await db.incident.count()).toBe(2);
    expect(await db.incidentReport.count()).toBe(1);
    expect(await db.incidentIndicator.count()).toBe(1);
    expect(await db.incidentComment.count()).toBe(0);
  });

  it('las lecturas (GET) no se auditan', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await request(a).get('/api/v1/incidents').set('Cookie', analista.cookie).expect(200);
    await request(a).get(`/api/v1/incidents/${UUID_INEXISTENTE}`).set('Cookie', analista.cookie).expect(404);
    await request(a).get('/api/v1/incidents?status=x').set('Cookie', analista.cookie).expect(400);
    expect(await db.auditEvent.count({ where: { action: { startsWith: 'incident.' } } })).toBe(0);
  });
});
