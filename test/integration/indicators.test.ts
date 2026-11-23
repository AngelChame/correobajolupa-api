import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Indicator, IndicatorList } from '../../src/contract/schemas/indicators.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Indicadores (M5): proponer, listar, confirmar y descartar, con P-11 (lista de exclusión).
type App = Parameters<typeof request>[0];
const INST = { INSTITUTIONAL_DOMAINS: 'universidad-ejemplo.example' };
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';
const SHA = 'e1ebcaeb1816296896173ffd4d783a7c5b7c9c23d73e610c805d4f9afabdf7db';

const proponer = (a: App, s: Sesion, body: Record<string, unknown>) =>
  request(a).post('/api/v1/indicators').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
const decidir = (a: App, s: Sesion, id: string, accion: 'confirm' | 'dismiss') =>
  request(a).post(`/api/v1/indicators/${id}/${accion}`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
const listar = (a: App, s: Sesion, query = '') => request(a).get(`/api/v1/indicators${query}`).set('Cookie', s.cookie);

/** Reporte mínimo de una persona (directo en la base: aquí no importa el análisis). */
async function reporteDe(userId: string): Promise<string> {
  const r = await db.report.create({ data: { userId, source: 'eml', storageKey: 'k/x', sizeBytes: 1, sha256: 'a'.repeat(64) } });
  return r.id;
}

async function crearIndicador(a: App, s: Sesion, body: Record<string, unknown>): Promise<string> {
  const res = await proponer(a, s, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return Indicator.parse(res.body).id;
}

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

describe('acceso a /indicators', () => {
  it('401 sin sesión en las 4 rutas; 403 al reportante al decidir (auditado); 403 sin token CSRF', async () => {
    const { app: a } = crearApp(INST);
    expect((await request(a).get('/api/v1/indicators')).status).toBe(401);
    expect((await request(a).post('/api/v1/indicators').send({ type: 'domain', value: 'malo.example' })).status).toBe(401);
    expect((await request(a).post(`/api/v1/indicators/${UUID_INEXISTENTE}/confirm`)).status).toBe(401);
    expect((await request(a).post(`/api/v1/indicators/${UUID_INEXISTENTE}/dismiss`)).status).toBe(401);

    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    expect((await decidir(a, reportante, UUID_INEXISTENTE, 'confirm')).status).toBe(403);
    expect((await decidir(a, reportante, UUID_INEXISTENTE, 'dismiss')).status).toBe(403);
    expect(await db.auditEvent.count({ where: { action: 'authz.denied', actorId: reportante.userId } })).toBe(2);

    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const sinToken = await request(a).post('/api/v1/indicators').set('Cookie', analista.cookie).send({ type: 'domain', value: 'malo.example' });
    expect(sinToken.status).toBe(403);
    expect(await db.indicator.count()).toBe(0);
  });
});

describe('proponer', () => {
  it('reportante: solo desde un reporte suyo (sin reportId 400; ajeno o inexistente 404); 201 normalizado y desactivado', async () => {
    const { app: a } = crearApp(INST);
    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    const otro = await entrarComo(a, 'reporter', 'otro@ejemplo.invalid');
    const suyo = await reporteDe(reportante.userId);
    const ajeno = await reporteDe(otro.userId);

    const sinReporte = await proponer(a, reportante, { type: 'domain', value: 'malo.example' });
    expect(sinReporte.status).toBe(400);
    expect(sinReporte.body).toMatchObject({ code: 'validation_error', details: [{ field: 'reportId' }] });
    for (const reportId of [ajeno, UUID_INEXISTENTE]) {
      const res = await proponer(a, reportante, { type: 'domain', value: 'malo.example', reportId });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'not_found', message: 'El reporte no existe.' });
    }

    const res = await proponer(a, reportante, { type: 'url', value: 'HTTPS://Universidad-Ejernplo.Example/verificar?ref=a1#x', reportId: suyo, note: 'llegó a todo el grupo' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const ind = Indicator.parse(res.body);
    expect(ind).toMatchObject({
      type: 'url',
      displayValue: 'hxxps://universidad-ejernplo[.]example/verificar',
      status: 'proposed',
      reportId: suyo,
      proposedBy: { id: reportante.userId, displayName: 'Persona reporter' },
      decidedBy: null,
      decidedAt: null,
    });
    // Se guarda normalizado; la respuesta nunca trae el valor crudo ni la nota.
    expect((await db.indicator.findUniqueOrThrow({ where: { id: ind.id } })).value).toBe('https://universidad-ejernplo.example/verificar');
    expect(JSON.stringify(res.body)).not.toMatch(/https:\/\/|grupo/);
  });

  it('analista y administrador pueden omitir reportId; el reporte borrado deja el indicador con reportId nulo', async () => {
    const { app: a } = crearApp(INST);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    await crearIndicador(a, analista, { type: 'sha256', value: SHA.toUpperCase() });
    const reportId = await reporteDe(admin.userId);
    const id = await crearIndicador(a, admin, { type: 'sender', value: 'Soporte@Universidad-Ejernplo.Example', reportId });
    await request(a).delete(`/api/v1/reports/${reportId}`).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf).expect(204);
    expect(Indicator.parse((await listar(a, admin).expect(200)).body.items.find((i: { id: string }) => i.id === id))).toMatchObject({
      reportId: null,
      displayValue: 'soporte@universidad-ejernplo[.]example',
    });
  });

  it('400 con cuerpo o valor inválido para el tipo, sin repetir el valor', async () => {
    const { app: a } = crearApp(INST);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    for (const body of [{}, { type: 'ip', value: '203.0.113.7' }, { type: 'domain', value: '' }, { type: 'domain', value: 'a'.repeat(2049) }, { type: 'domain', value: 'malo.example', note: 'n'.repeat(501) }, { type: 'domain', value: 'malo.example', reportId: 'no-es-uuid' }]) {
      const res = await proponer(a, analista, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.code).toBe('validation_error');
    }
    const hostiles: [string, string][] = [
      ['url', 'javascript:alert(1)'],
      ['url', 'https://usuario:clave@malo.example/'],
      ['domain', 'http://malo.example/'],
      ['domain', '<img src=x>.example'],
      ['sha256', 'no-es-hash'],
      ['sender', 'Nombre <a@malo.example>'],
    ];
    for (const [type, value] of hostiles) {
      const res = await proponer(a, analista, { type, value });
      expect(res.status, value).toBe(400);
      expect(res.body).toMatchObject({ code: 'validation_error', details: [{ field: 'value' }] });
      expect(JSON.stringify(res.body)).not.toContain(value);
    }
    expect(await db.indicator.count()).toBe(0);
  });

  it('P-11: 409 si el dominio, el host de la URL o el dominio del remitente caen en la lista de exclusión (y sus subdominios)', async () => {
    const { app: a } = crearApp(INST);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await request(a).post('/api/v1/exclusions').set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf).send({ domain: 'nube-compartida.example' }).expect(201);
    const excluidos: [string, string][] = [
      ['domain', 'universidad-ejemplo.example'],
      ['domain', 'Portal.Universidad-Ejemplo.Example.'],
      ['url', 'https://portal.universidad-ejemplo.example/aviso'],
      ['sender', 'servicios@universidad-ejemplo.example'],
      ['domain', 'nube-compartida.example'],
      ['url', 'https://docs.nube-compartida.example/f/1'],
    ];
    for (const [type, value] of excluidos) {
      const res = await proponer(a, analista, { type, value });
      expect(res.status, value).toBe(409);
      expect(res.body).toMatchObject({ code: 'conflict', message: 'El dominio está en la lista de exclusión: no puede ser indicador.' });
    }
    // Frontera de etiqueta y dominio parecido: no están excluidos.
    await crearIndicador(a, analista, { type: 'domain', value: 'universidad-ejernplo.example' });
    await crearIndicador(a, analista, { type: 'domain', value: 'xnube-compartida.example' });
    expect(await db.indicator.count()).toBe(2);
  });

  it('409 si ya existe uno igual (tras normalizar) propuesto o confirmado; descartado libera el valor', async () => {
    const { app: a } = crearApp(INST);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIndicador(a, analista, { type: 'domain', value: 'malo.example' });
    const repetido = await proponer(a, analista, { type: 'domain', value: ' MALO.example. ' });
    expect(repetido.status).toBe(409);
    expect(repetido.body).toMatchObject({ code: 'conflict', message: 'Ese indicador ya existe.' });
    await decidir(a, analista, id, 'confirm').expect(200);
    expect((await proponer(a, analista, { type: 'domain', value: 'malo.example' })).status).toBe(409);

    const otro = await crearIndicador(a, analista, { type: 'domain', value: 'otro-malo.example' });
    await decidir(a, analista, otro, 'dismiss').expect(200);
    await crearIndicador(a, analista, { type: 'domain', value: 'otro-malo.example' });
  });
});

describe('listar', () => {
  it('el reportante ve solo los suyos; analista todos; filtros status y type; paginación; 400 con filtro inválido', async () => {
    const { app: a } = crearApp(INST);
    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const suyo = await crearIndicador(a, reportante, { type: 'domain', value: 'malo.example', reportId: await reporteDe(reportante.userId) });
    const conf = await crearIndicador(a, analista, { type: 'sha256', value: SHA });
    await crearIndicador(a, analista, { type: 'sender', value: 'rh@nomina-avisos.example' });
    await decidir(a, analista, conf, 'confirm').expect(200);

    const propios = IndicatorList.parse((await listar(a, reportante).expect(200)).body);
    expect(propios.items.map((i) => i.id)).toEqual([suyo]);
    expect(propios.total).toBe(1);

    const todos = IndicatorList.parse((await listar(a, analista).expect(200)).body);
    expect(todos.total).toBe(3);
    // Los más recientes primero.
    expect(todos.items.map((i) => i.type)).toEqual(['sender', 'sha256', 'domain']);

    expect(IndicatorList.parse((await listar(a, analista, '?status=confirmed').expect(200)).body).items.map((i) => i.id)).toEqual([conf]);
    expect(IndicatorList.parse((await listar(a, analista, '?type=domain').expect(200)).body).items.map((i) => i.id)).toEqual([suyo]);
    const pagina = IndicatorList.parse((await listar(a, analista, '?page=2&pageSize=2').expect(200)).body);
    expect(pagina).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(pagina.items).toHaveLength(1);

    for (const q of ['?status=abierto', '?type=ip', '?pageSize=101', '?page=0']) {
      expect((await listar(a, analista, q)).status, q).toBe(400);
    }
  });
});

describe('confirmar y descartar', () => {
  it('200 con quien decidió; ya decidido 409; inexistente o mal formado 404', async () => {
    const { app: a } = crearApp(INST);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    const id = await crearIndicador(a, analista, { type: 'domain', value: 'malo.example' });
    const res = await decidir(a, admin, id, 'confirm');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const conf = Indicator.parse(res.body);
    expect(conf).toMatchObject({ status: 'confirmed', decidedBy: { id: admin.userId, displayName: 'Persona admin' }, displayValue: 'malo[.]example' });
    expect(conf.decidedAt).not.toBeNull();

    for (const accion of ['confirm', 'dismiss'] as const) {
      const otra = await decidir(a, analista, id, accion);
      expect(otra.status).toBe(409);
      expect(otra.body).toMatchObject({ code: 'conflict', message: 'El indicador ya fue decidido.' });
    }
    const desc = await crearIndicador(a, analista, { type: 'domain', value: 'otro-malo.example' });
    expect(Indicator.parse((await decidir(a, analista, desc, 'dismiss').expect(200)).body).status).toBe('dismissed');
    expect((await decidir(a, analista, desc, 'confirm')).status).toBe(409);

    for (const malo of [UUID_INEXISTENTE, 'no-es-uuid']) {
      const r = await decidir(a, analista, malo, 'confirm');
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ code: 'not_found', message: 'El indicador no existe.' });
    }
  });

  it('P-11 al confirmar: si el dominio se excluyó después de proponerlo, 409 y sigue propuesto; descartarlo sí se puede', async () => {
    const { app: a } = crearApp(INST);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const url = await crearIndicador(a, analista, { type: 'url', value: 'https://docs.nube-compartida.example/f/1' });
    const sender = await crearIndicador(a, analista, { type: 'sender', value: 'aviso@nube-compartida.example' });
    await request(a).post('/api/v1/exclusions').set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf).send({ domain: 'nube-compartida.example' }).expect(201);
    for (const id of [url, sender]) {
      const res = await decidir(a, analista, id, 'confirm');
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('El dominio está en la lista de exclusión: no puede ser indicador.');
      expect((await db.indicator.findUniqueOrThrow({ where: { id } })).status).toBe('proposed');
    }
    await decidir(a, analista, url, 'dismiss').expect(200);
  });
});

describe('auditoría y registros', () => {
  it('éxitos y rechazos (404 y 409) quedan en la auditoría sin el valor; los registros tampoco lo tienen', async () => {
    const { app: a, lineas } = crearApp(INST);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIndicador(a, analista, { type: 'domain', value: 'malo-secreto.example', note: 'nota-privada' });
    await proponer(a, analista, { type: 'domain', value: 'malo-secreto.example' }).expect(409);
    await proponer(a, analista, { type: 'domain', value: 'universidad-ejemplo.example' }).expect(409);
    await proponer(a, analista, { type: 'domain', value: 'malo2.example', reportId: UUID_INEXISTENTE }).expect(404);
    await decidir(a, analista, id, 'confirm').expect(200);
    await decidir(a, analista, id, 'dismiss').expect(409);
    await decidir(a, analista, UUID_INEXISTENTE, 'confirm').expect(404);
    await decidir(a, analista, 'no-es-uuid', 'dismiss').expect(404);

    const eventos = await db.auditEvent.findMany({ where: { action: { startsWith: 'indicator.' } }, orderBy: { createdAt: 'asc' } });
    expect(eventos.map((e) => [e.action, e.result, e.targetId, (e.metadata as { reason?: string }).reason ?? null])).toEqual([
      ['indicator.propose', 'success', id, null],
      ['indicator.propose', 'failure', null, 'duplicate'],
      ['indicator.propose', 'failure', null, 'excluded'],
      ['indicator.propose', 'failure', null, 'report_not_found'],
      ['indicator.confirm', 'success', id, null],
      ['indicator.dismiss', 'failure', id, 'already_decided'],
      ['indicator.confirm', 'failure', UUID_INEXISTENTE, 'not_found'],
      ['indicator.dismiss', 'failure', null, 'not_found'],
    ]);
    for (const e of eventos) {
      expect(e).toMatchObject({ targetType: 'indicator', actorId: analista.userId });
      expect(e.requestId).toBeTruthy();
      expect(Object.keys(e.metadata as object).every((k) => ['type', 'reportId', 'reason'].includes(k))).toBe(true);
    }
    const texto = JSON.stringify(eventos);
    expect(texto).not.toContain('no-es-uuid');
    // El registro de acceso sí lleva la ruta de la URL (como en todas las rutas); nunca el cuerpo.
    for (const prohibido of ['malo-secreto', 'universidad-ejemplo', 'malo2', 'nota-privada']) {
      expect(texto).not.toContain(prohibido);
      expect(lineas.join('\n')).not.toContain(prohibido);
    }
  });
});
