import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Exclusion, ExclusionList } from '../../src/contract/schemas/indicators.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Lista de exclusión (M5, P-11) de punta a punta.
type App = Parameters<typeof request>[0];
const INST = { INSTITUTIONAL_DOMAINS: 'universidad-ejemplo.example' };
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

const crear = (a: App, s: Sesion, body: unknown) => request(a).post('/api/v1/exclusions').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body as object);
const borrar = (a: App, s: Sesion, id: string) => request(a).delete(`/api/v1/exclusions/${id}`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
const listar = (a: App, s: Sesion) => request(a).get('/api/v1/exclusions').set('Cookie', s.cookie);

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

describe('acceso a /exclusions', () => {
  it('401 sin sesión, 403 al reportante (auditado) y 403 sin token CSRF', async () => {
    const { app: a } = crearApp(INST);
    expect((await request(a).get('/api/v1/exclusions')).status).toBe(401);
    expect((await request(a).post('/api/v1/exclusions').send({ domain: 'x.example' })).status).toBe(401);
    expect((await request(a).delete(`/api/v1/exclusions/${UUID_INEXISTENTE}`)).status).toBe(401);

    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    expect((await listar(a, reportante)).status).toBe(403);
    expect((await crear(a, reportante, { domain: 'x.example' })).status).toBe(403);
    expect((await borrar(a, reportante, UUID_INEXISTENTE)).status).toBe(403);
    expect(await db.auditEvent.count({ where: { action: 'authz.denied', actorId: reportante.userId } })).toBe(3);

    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const sinToken = await request(a).post('/api/v1/exclusions').set('Cookie', analista.cookie).send({ domain: 'x.example' });
    expect(sinToken.status).toBe(403);
    expect(await db.exclusion.count()).toBe(0);
  });
});

describe('lista de exclusión', () => {
  it('lista los institucionales como solo lectura; crea normalizado y desactivado; borra; audita sin el dominio', async () => {
    const { app: a, lineas } = crearApp(INST);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');

    const inicial = ExclusionList.parse((await listar(a, analista).expect(200)).body);
    expect(inicial.items).toEqual([{ id: null, domain: 'universidad-ejemplo[.]example', source: 'config', reason: null, createdAt: null }]);

    const res = await crear(a, analista, { domain: '  Nube-Compartida.EXAMPLE. ', reason: 'servicio de archivos legítimo' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const creada = Exclusion.parse(res.body);
    expect(creada).toMatchObject({ domain: 'nube-compartida[.]example', source: 'manual', reason: 'servicio de archivos legítimo' });
    expect((await db.exclusion.findUniqueOrThrow({ where: { id: creada.id! } })).domain).toBe('nube-compartida.example');

    const lista = ExclusionList.parse((await listar(a, analista).expect(200)).body);
    expect(lista.items.map((e) => [e.source, e.domain])).toEqual([
      ['config', 'universidad-ejemplo[.]example'],
      ['manual', 'nube-compartida[.]example'],
    ]);

    expect((await borrar(a, analista, creada.id!)).status).toBe(204);
    expect(await db.exclusion.count()).toBe(0);
    expect((await borrar(a, analista, creada.id!)).status).toBe(404);

    const eventos = await db.auditEvent.findMany({ where: { action: { startsWith: 'exclusion.' } }, orderBy: { createdAt: 'asc' } });
    expect(eventos.map((e) => [e.action, e.result, e.targetType, e.targetId, e.actorId])).toEqual([
      ['exclusion.create', 'success', 'exclusion', creada.id, analista.userId],
      ['exclusion.delete', 'success', 'exclusion', creada.id, analista.userId],
    ]);
    // Ni la auditoría ni los registros guardan el dominio ni el motivo.
    expect(JSON.stringify(eventos)).not.toMatch(/nube-compartida|archivos/i);
    expect(lineas.join('\n')).not.toMatch(/nube-compartida|archivos/i);
  });

  it('409 si ya está excluido: el mismo, un subdominio de uno excluido o uno institucional', async () => {
    const { app: a } = crearApp(INST);
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    expect((await crear(a, admin, { domain: 'nube-compartida.example' })).status).toBe(201);
    for (const domain of ['nube-compartida.example', 'NUBE-COMPARTIDA.example.', 'docs.nube-compartida.example', 'universidad-ejemplo.example', 'portal.universidad-ejemplo.example']) {
      const res = await crear(a, admin, { domain });
      expect(res.status, domain).toBe(409);
      expect(res.body).toMatchObject({ code: 'conflict', message: 'Ese dominio ya está excluido.' });
    }
    // Frontera de etiqueta: parecido no es subdominio.
    expect((await crear(a, admin, { domain: 'xnube-compartida.example' })).status).toBe(201);
    expect(await db.exclusion.count()).toBe(2);
  });

  it('400 con cuerpo o dominio inválido, sin repetir el valor; 404 con ID inexistente o mal formado', async () => {
    const { app: a } = crearApp(INST);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    for (const body of [{}, { domain: '' }, { domain: 'a'.repeat(254) }, { domain: 'x.example', reason: 'r'.repeat(501) }]) {
      const res = await crear(a, analista, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('validation_error');
    }
    for (const domain of ['https://x.example/', 'no es dominio', 'localhost', '<script>.example']) {
      const res = await crear(a, analista, { domain });
      expect(res.status, domain).toBe(400);
      expect(res.body).toMatchObject({ code: 'validation_error', details: [{ field: 'domain' }] });
      expect(JSON.stringify(res.body)).not.toContain(domain);
    }
    expect((await borrar(a, analista, UUID_INEXISTENTE)).status).toBe(404);
    const malFormado = await borrar(a, analista, 'no-es-uuid');
    expect(malFormado.status).toBe(404);
    expect(malFormado.body).toMatchObject({ code: 'not_found', message: 'La exclusión no existe.' });
    expect(await db.exclusion.count()).toBe(0);
  });
});
