import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IncidentDetail, IncidentList } from '../../src/contract/schemas/incidents.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Incidentes (M6): crear, listar, ver, actualizar, asociar y comentar. Solo analista y administrador.
type App = Parameters<typeof request>[0];
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

const crear = (a: App, s: Sesion, body: Record<string, unknown>) =>
  request(a).post('/api/v1/incidents').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
const ver = (a: App, s: Sesion, id: string) => request(a).get(`/api/v1/incidents/${id}`).set('Cookie', s.cookie);
const listar = (a: App, s: Sesion, query = '') => request(a).get(`/api/v1/incidents${query}`).set('Cookie', s.cookie);

async function crearIncidente(a: App, s: Sesion, body: Record<string, unknown> = { title: 'Campaña de becas' }): Promise<string> {
  const res = await crear(a, s, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return IncidentDetail.parse(res.body).id;
}

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

describe('crear, listar y ver', () => {
  it('201 con estado received, sin asociaciones ni comentarios, y creador como UserRef', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const res = await crear(a, analista, { title: 'Campaña de becas', description: 'Varios reportes iguales' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const inc = IncidentDetail.parse(res.body);
    expect(inc).toMatchObject({
      title: 'Campaña de becas',
      description: 'Varios reportes iguales',
      status: 'received',
      reportsCount: 0,
      indicatorsCount: 0,
      createdBy: { id: analista.userId, displayName: 'Persona analyst' },
      reports: [],
      indicators: [],
      comments: [],
    });
    expect(inc.createdAt).toBe(inc.updatedAt);
    // Sin descripción: null.
    const sinDesc = IncidentDetail.parse((await crear(a, analista, { title: 'Otro' }).expect(201)).body);
    expect(sinDesc.description).toBeNull();
    // El texto se guarda tal cual (el front lo escapa).
    const hostil = IncidentDetail.parse((await crear(a, analista, { title: '<script>alert(1)</script>' }).expect(201)).body);
    expect(hostil.title).toBe('<script>alert(1)</script>');
  });

  it('400 con título vacío, demasiado largo, descripción de más de 2000 o cuerpo vacío', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    for (const body of [{}, { title: '' }, { title: 't'.repeat(121) }, { title: 't', description: 'd'.repeat(2001) }, { title: 5 }]) {
      const res = await crear(a, analista, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(res.body.code).toBe('validation_error');
    }
    // Límites exactos: sí.
    await crear(a, analista, { title: 't'.repeat(120), description: 'd'.repeat(2000) }).expect(201);
    expect(await db.incident.count()).toBe(1);
  });

  it('lista por updatedAt descendente, filtro status, paginación y 400 con filtro inválido', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    const primero = await crearIncidente(a, analista, { title: 'Primero' });
    const segundo = await crearIncidente(a, admin, { title: 'Segundo' });
    const tercero = await crearIncidente(a, analista, { title: 'Tercero' });
    // Mover el primero lo pone arriba.
    await db.incident.update({ where: { id: primero }, data: { status: 'analyzing', updatedAt: new Date(Date.now() + 1000) } });

    const todos = IncidentList.parse((await listar(a, admin).expect(200)).body);
    expect(todos.items.map((i) => i.id)).toEqual([primero, tercero, segundo]);
    expect(todos.total).toBe(3);
    expect(todos.items[0]).toMatchObject({ title: 'Primero', status: 'analyzing', reportsCount: 0, indicatorsCount: 0 });

    expect(IncidentList.parse((await listar(a, analista, '?status=analyzing').expect(200)).body).items.map((i) => i.id)).toEqual([primero]);
    expect(IncidentList.parse((await listar(a, analista, '?status=closed').expect(200)).body).total).toBe(0);
    const pagina = IncidentList.parse((await listar(a, analista, '?page=2&pageSize=2').expect(200)).body);
    expect(pagina).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(pagina.items.map((i) => i.id)).toEqual([segundo]);

    for (const q of ['?status=abierto', '?pageSize=101', '?page=0', '?pageSize=x']) {
      expect((await listar(a, analista, q)).status, q).toBe(400);
    }
  });

  it('ver: 200 con el detalle; 404 si no existe o el ID está mal formado', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    expect(IncidentDetail.parse((await ver(a, analista, id).expect(200)).body).id).toBe(id);
    for (const malo of [UUID_INEXISTENTE, 'no-es-uuid']) {
      const res = await ver(a, analista, malo);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'not_found', message: 'El incidente no existe.' });
    }
  });

  it('auditoría incident.create con el ID y sin título ni descripción; 400 auditado', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista, { title: 'titulo-secreto', description: 'descripcion-secreta' });
    await crear(a, analista, { title: '' }).expect(400);
    const eventos = await db.auditEvent.findMany({ where: { action: 'incident.create' }, orderBy: { createdAt: 'asc' } });
    expect(eventos.map((e) => [e.result, e.targetId, e.metadata])).toEqual([
      ['success', id, null],
      ['failure', null, { reason: 'invalid_body' }],
    ]);
    expect(JSON.stringify(eventos)).not.toMatch(/secret/);
  });
});
