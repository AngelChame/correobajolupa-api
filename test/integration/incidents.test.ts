import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IncidentDetail, IncidentList, IncidentStatus } from '../../src/contract/schemas/incidents.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Incidentes (M6): crear, listar, ver, actualizar, asociar y comentar. Solo analista y administrador.
type App = Parameters<typeof request>[0];
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

const crear = (a: App, s: Sesion, body: Record<string, unknown>) =>
  request(a).post('/api/v1/incidents').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
const ver = (a: App, s: Sesion, id: string) => request(a).get(`/api/v1/incidents/${id}`).set('Cookie', s.cookie);
const listar = (a: App, s: Sesion, query = '') => request(a).get(`/api/v1/incidents${query}`).set('Cookie', s.cookie);
const actualizar = (a: App, s: Sesion, id: string, body: Record<string, unknown>) =>
  request(a).patch(`/api/v1/incidents/${id}`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);

const FINAL = 'El incidente ya está cerrado o marcado como falso positivo: es de solo lectura.';
const TRANSICION = 'Ese cambio de estado no está permitido desde el estado actual.';
const CARRERA = 'Otra persona cambió el incidente al mismo tiempo. Vuelve a cargarlo e intenta de nuevo.';
const VALIDAS = new Set(['received>analyzing', 'analyzing>contained', 'contained>closed', 'received>false_positive', 'analyzing>false_positive', 'contained>false_positive']);
const FINALES = new Set(['closed', 'false_positive']);

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

describe('actualizar', () => {
  it('título y descripción: null borra la descripción, omitirla no la cambia; auditoría con nombres de campos', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista, { title: 'Antes', description: 'desc-original' });
    const r1 = IncidentDetail.parse((await actualizar(a, analista, id, { title: 'Después' }).expect(200)).body);
    expect(r1).toMatchObject({ title: 'Después', description: 'desc-original', status: 'received' });
    const r2 = IncidentDetail.parse((await actualizar(a, analista, id, { description: null }).expect(200)).body);
    expect(r2.description).toBeNull();
    expect(r2.title).toBe('Después');
    const eventos = await db.auditEvent.findMany({ where: { action: 'incident.update' }, orderBy: { createdAt: 'asc' } });
    expect(eventos.map((e) => [e.result, e.targetId, e.metadata])).toEqual([
      ['success', id, { fields: ['title'] }],
      ['success', id, { fields: ['description'] }],
    ]);
  });

  it('un PATCH sin cambios reales (vacío, mismos valores o mismo estado) responde 200 sin tocar updatedAt ni auditar', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista, { title: 'Igual', description: 'Igual' });
    const antes = await db.incident.findUniqueOrThrow({ where: { id } });
    for (const body of [{}, { title: 'Igual' }, { description: 'Igual' }, { status: 'received' }, { title: 'Igual', status: 'received' }]) {
      const res = await actualizar(a, analista, id, body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(IncidentDetail.parse(res.body).updatedAt).toBe(antes.updatedAt.toISOString());
    }
    expect((await db.incident.findUniqueOrThrow({ where: { id } })).updatedAt).toEqual(antes.updatedAt);
    expect(await db.auditEvent.count({ where: { action: 'incident.update' } })).toBe(0);
  });

  it('cambiar el estado sube updatedAt y audita el estado anterior y el nuevo', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    const antes = await db.incident.findUniqueOrThrow({ where: { id } });
    const res = IncidentDetail.parse((await actualizar(a, analista, id, { status: 'analyzing', title: 'Nuevo' }).expect(200)).body);
    expect(res.status).toBe('analyzing');
    expect(new Date(res.updatedAt).getTime()).toBeGreaterThan(antes.updatedAt.getTime());
    const e = await db.auditEvent.findFirstOrThrow({ where: { action: 'incident.update' } });
    expect(e.metadata).toEqual({ fields: ['title', 'status'], fromStatus: 'received', toStatus: 'analyzing' });
  });

  it('matriz 5 x 5 por HTTP: solo las 6 transiciones válidas; el mismo estado es 200 sin cambio; desde un final, 409', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const probadas: string[] = [];
    for (const from of IncidentStatus.options) {
      for (const to of IncidentStatus.options) {
        const id = await crearIncidente(a, analista, { title: `${from} a ${to}` });
        await db.incident.update({ where: { id }, data: { status: from } });
        const res = await actualizar(a, analista, id, { status: to });
        const caso = `${from}>${to}`;
        if (from === to || VALIDAS.has(caso)) {
          expect(res.status, caso).toBe(200);
          expect(IncidentDetail.parse(res.body).status, caso).toBe(to);
        } else {
          expect(res.status, caso).toBe(409);
          expect(res.body, caso).toMatchObject({ code: 'conflict', message: FINALES.has(from) ? FINAL : TRANSICION });
          expect((await db.incident.findUniqueOrThrow({ where: { id } })).status, caso).toBe(from);
        }
        probadas.push(`${caso}:${res.status}`);
      }
    }
    expect(probadas).toHaveLength(25);
  });

  it('un incidente final no admite cambios de título ni descripción (409); 400 antes que 404 y 404 antes que 409', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista, { title: 'Cerrado' });
    await db.incident.update({ where: { id }, data: { status: 'closed' } });
    for (const body of [{ title: 'Otro' }, { description: 'nueva' }, { description: null, title: 'x' }]) {
      const res = await actualizar(a, analista, id, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.message).toBe(FINAL);
    }
    // Sin cambio real, aun final: 200.
    await actualizar(a, analista, id, { title: 'Cerrado', status: 'closed' }).expect(200);

    // Orden: cuerpo inválido 400 aunque el incidente no exista; luego 404.
    expect((await actualizar(a, analista, UUID_INEXISTENTE, { title: '' })).status).toBe(400);
    expect((await actualizar(a, analista, UUID_INEXISTENTE, { status: 'abierto' })).status).toBe(400);
    expect((await actualizar(a, analista, id, { title: 't'.repeat(121) })).status).toBe(400);
    expect((await actualizar(a, analista, id, { description: 'd'.repeat(2001) })).status).toBe(400);
    for (const malo of [UUID_INEXISTENTE, 'no-es-uuid']) {
      const res = await actualizar(a, analista, malo, { title: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('El incidente no existe.');
    }
  });

  it('carrera: dos PATCH de estado a la vez sobre contained (closed y false_positive): uno gana y el otro 409', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    for (let i = 0; i < 5; i++) {
      const id = await crearIncidente(a, analista, { title: `Carrera ${i}` });
      await db.incident.update({ where: { id }, data: { status: 'contained' } });
      const [r1, r2] = await Promise.all([actualizar(a, analista, id, { status: 'closed' }), actualizar(a, admin, id, { status: 'false_positive' })]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const perdedora = r1.status === 409 ? r1 : r2;
      const ganadora = r1.status === 200 ? r1 : r2;
      // Si llegó cuando la otra ya terminó, el incidente ya era final; si llegaron juntas, lo detecta la actualización condicional.
      expect([FINAL, CARRERA]).toContain(perdedora.body.message);
      expect((await db.incident.findUniqueOrThrow({ where: { id } })).status).toBe(IncidentDetail.parse(ganadora.body).status);
      expect(await db.auditEvent.count({ where: { action: 'incident.update', targetId: id, result: 'success' } })).toBe(1);
    }
  });

  it('carrera forzada: si el estado cambió entre la lectura y la escritura, 409 y nada cambia', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista, { title: 'Forzada' });
    // Simula a otra persona: justo después de la lectura de la ruta, el estado pasa a analyzing.
    const original = db.incident.findUnique.bind(db.incident);
    let interceptado = false;
    const espia = (async (args: { where: { id?: string }; select?: object }) => {
      const fila = await original(args as Parameters<typeof original>[0]);
      if (!interceptado && args.where.id === id && fila && 'status' in fila) {
        interceptado = true;
        await db.$executeRaw`UPDATE incidents SET status = 'analyzing' WHERE id = ${id}::uuid`;
      }
      return fila;
    }) as unknown as typeof original;
    db.incident.findUnique = espia;
    try {
      const res = await actualizar(a, analista, id, { status: 'false_positive' });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe(CARRERA);
    } finally {
      db.incident.findUnique = original;
    }
    expect(interceptado).toBe(true);
    expect((await db.incident.findUniqueOrThrow({ where: { id } })).status).toBe('analyzing');
    const e = await db.auditEvent.findFirstOrThrow({ where: { action: 'incident.update', targetId: id } });
    expect(e).toMatchObject({ result: 'failure', metadata: { reason: 'status_changed' } });
  });
});
