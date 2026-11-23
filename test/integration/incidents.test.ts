import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Comment, IncidentDetail, IncidentList, IncidentStatus } from '../../src/contract/schemas/incidents.js';
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

type Tipo = 'reports' | 'indicators';
const asociar = (a: App, s: Sesion, id: string, tipo: Tipo, body: Record<string, unknown>) =>
  request(a).post(`/api/v1/incidents/${id}/${tipo}`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
const quitar = (a: App, s: Sesion, id: string, tipo: Tipo, targetId: string) =>
  request(a).delete(`/api/v1/incidents/${id}/${tipo}/${targetId}`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
const comentar = (a: App, s: Sesion, id: string, body: string) =>
  request(a).post(`/api/v1/incidents/${id}/comments`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send({ body });
const campo = (tipo: Tipo) => (tipo === 'reports' ? 'reportId' : 'indicatorId');

/** Reporte mínimo con un hallazgo (directo en la base: aquí no importa el análisis). */
async function reporteDe(userId: string): Promise<string> {
  const r = await db.report.create({ data: { userId, source: 'eml', storageKey: 'k/x', sizeBytes: 1, sha256: 'a'.repeat(64), subject: 'Asunto del correo' } });
  await db.finding.create({ data: { reportId: r.id, ruleId: 'R1', ruleName: 'Reply-To', summary: 's', evidence: [], rulesVersion: 'v' } });
  return r.id;
}

async function indicadorDe(userId: string, value = 'malo.example', status: 'proposed' | 'confirmed' | 'dismissed' = 'proposed'): Promise<string> {
  const decidido = status === 'proposed' ? {} : { decidedById: userId, decidedAt: new Date() };
  return (await db.indicator.create({ data: { type: 'domain', value, status, proposedById: userId, ...decidido } })).id;
}

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

describe('asociar y quitar reportes e indicadores', () => {
  it('asociar devuelve el detalle con el reporte como en GET /reports y el indicador desactivado, en orden de asociación', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    const r1 = await reporteDe(reportante.userId);
    const r2 = await reporteDe(analista.userId);
    // Cualquier estado de indicador se puede asociar.
    const i1 = await indicadorDe(analista.userId, 'malo.example', 'confirmed');
    const i2 = await indicadorDe(analista.userId, 'otro-malo.example', 'dismissed');

    await asociar(a, analista, id, 'reports', { reportId: r2 }).expect(200);
    await asociar(a, analista, id, 'reports', { reportId: r1 }).expect(200);
    await asociar(a, analista, id, 'indicators', { indicatorId: i2 }).expect(200);
    const res = await asociar(a, analista, id, 'indicators', { indicatorId: i1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const inc = IncidentDetail.parse(res.body);
    expect(inc).toMatchObject({ reportsCount: 2, indicatorsCount: 2 });
    expect(inc.reports.map((r) => r.id)).toEqual([r2, r1]);
    expect(inc.indicators.map((i) => i.id)).toEqual([i2, i1]);
    // Mismo resumen que GET /reports.
    const lista = (await request(a).get('/api/v1/reports').set('Cookie', analista.cookie).expect(200)).body.items as { id: string }[];
    expect(inc.reports[1]).toEqual(lista.find((r) => r.id === r1));
    expect(inc.reports[1]).toMatchObject({ findingsCount: 1, subject: 'Asunto del correo' });
    expect(inc.indicators[1]).toMatchObject({ displayValue: 'malo[.]example', status: 'confirmed' });
    expect(JSON.stringify(res.body)).not.toContain('malo.example');

    const resumen = IncidentList.parse((await listar(a, analista).expect(200)).body).items[0];
    expect(resumen).toMatchObject({ id, reportsCount: 2, indicatorsCount: 2 });
  });

  it.each(['reports', 'indicators'] as const)('%s: 400 sin ID o mal formado; 404 incidente u objetivo inexistente; 409 ya asociado', async (tipo) => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    const objetivo = tipo === 'reports' ? await reporteDe(analista.userId) : await indicadorDe(analista.userId);
    const genero = tipo === 'reports' ? 'El reporte' : 'El indicador';

    for (const body of [{}, { [campo(tipo)]: 'no-es-uuid' }, { [campo(tipo)]: 5 }]) {
      const res = await asociar(a, analista, id, tipo, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatchObject({ code: 'validation_error' });
    }
    // 400 antes que 404.
    expect((await asociar(a, analista, UUID_INEXISTENTE, tipo, {})).status).toBe(400);
    for (const malo of [UUID_INEXISTENTE, 'no-es-uuid']) {
      const res = await asociar(a, analista, malo, tipo, { [campo(tipo)]: objetivo });
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('El incidente no existe.');
    }
    const noExiste = await asociar(a, analista, id, tipo, { [campo(tipo)]: UUID_INEXISTENTE });
    expect(noExiste.status).toBe(404);
    expect(noExiste.body.message).toBe(`${genero} no existe.`);

    await asociar(a, analista, id, tipo, { [campo(tipo)]: objetivo }).expect(200);
    const otraVez = await asociar(a, analista, id, tipo, { [campo(tipo)]: objetivo });
    expect(otraVez.status).toBe(409);
    expect(otraVez.body).toMatchObject({ code: 'conflict', message: `${genero} ya está asociado al incidente.` });
  });

  it.each(['reports', 'indicators'] as const)('%s: quitar 204 y baja el conteo; 404 si el incidente no existe o no estaba asociado', async (tipo) => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    const objetivo = tipo === 'reports' ? await reporteDe(analista.userId) : await indicadorDe(analista.userId);
    const genero = tipo === 'reports' ? 'El reporte' : 'El indicador';
    await asociar(a, analista, id, tipo, { [campo(tipo)]: objetivo }).expect(200);

    for (const malo of [UUID_INEXISTENTE, 'no-es-uuid']) {
      const res = await quitar(a, analista, malo, tipo, objetivo);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('El incidente no existe.');
    }
    for (const malo of [UUID_INEXISTENTE, 'no-es-uuid']) {
      const res = await quitar(a, analista, id, tipo, malo);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe(`${genero} no está asociado al incidente.`);
    }
    await quitar(a, analista, id, tipo, objetivo).expect(204);
    expect((await quitar(a, analista, id, tipo, objetivo)).status).toBe(404);
    const inc = IncidentDetail.parse((await ver(a, analista, id).expect(200)).body);
    expect(inc.reportsCount + inc.indicatorsCount).toBe(0);
    // Quitar no borra el reporte ni el indicador.
    expect(tipo === 'reports' ? await db.report.count() : await db.indicator.count()).toBe(1);
  });

  it('cada cambio sube updatedAt; auditoría con IDs', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    const reportId = await reporteDe(analista.userId);
    const indicatorId = await indicadorDe(analista.userId);
    let anterior = (await db.incident.findUniqueOrThrow({ where: { id } })).updatedAt;
    const pasos = [
      () => asociar(a, analista, id, 'reports', { reportId }).expect(200),
      () => asociar(a, analista, id, 'indicators', { indicatorId }).expect(200),
      () => quitar(a, analista, id, 'reports', reportId).expect(204),
      () => quitar(a, analista, id, 'indicators', indicatorId).expect(204),
    ];
    for (const paso of pasos) {
      await paso();
      const ahora = (await db.incident.findUniqueOrThrow({ where: { id } })).updatedAt;
      expect(ahora.getTime()).toBeGreaterThan(anterior.getTime());
      anterior = ahora;
    }
    const eventos = await db.auditEvent.findMany({ where: { action: { startsWith: 'incident.' }, NOT: { action: 'incident.create' } }, orderBy: { createdAt: 'asc' } });
    expect(eventos.map((e) => [e.action, e.result, e.targetId, e.metadata])).toEqual([
      ['incident.report_add', 'success', id, { reportId }],
      ['incident.indicator_add', 'success', id, { indicatorId }],
      ['incident.report_remove', 'success', id, { reportId }],
      ['incident.indicator_remove', 'success', id, { indicatorId }],
    ]);
  });

  it.each(['closed', 'false_positive'] as const)('incidente %s: asociar y quitar son 409 y nada cambia', async (final) => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    const reportId = await reporteDe(analista.userId);
    const otroReporte = await reporteDe(analista.userId);
    const indicatorId = await indicadorDe(analista.userId);
    const otroIndicador = await indicadorDe(analista.userId, 'otro-malo.example');
    await asociar(a, analista, id, 'reports', { reportId }).expect(200);
    await asociar(a, analista, id, 'indicators', { indicatorId }).expect(200);
    await db.incident.update({ where: { id }, data: { status: final } });
    const antes = await db.incident.findUniqueOrThrow({ where: { id } });

    for (const res of [
      await asociar(a, analista, id, 'reports', { reportId: otroReporte }),
      await asociar(a, analista, id, 'indicators', { indicatorId: otroIndicador }),
      await quitar(a, analista, id, 'reports', reportId),
      await quitar(a, analista, id, 'indicators', indicatorId),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'conflict', message: FINAL });
    }
    const despues = IncidentDetail.parse((await ver(a, analista, id).expect(200)).body);
    expect(despues).toMatchObject({ reportsCount: 1, indicatorsCount: 1, updatedAt: antes.updatedAt.toISOString() });
  });

  it('borrar un reporte asociado (retención o borrado manual) lo quita del incidente; el incidente queda y el conteo baja', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    const r1 = await reporteDe(reportante.userId);
    const r2 = await reporteDe(reportante.userId);
    await asociar(a, analista, id, 'reports', { reportId: r1 }).expect(200);
    await asociar(a, analista, id, 'reports', { reportId: r2 }).expect(200);

    await request(a).delete(`/api/v1/reports/${r1}`).set('Cookie', reportante.cookie).set('X-CSRF-Token', reportante.csrf).expect(204);
    const inc = IncidentDetail.parse((await ver(a, analista, id).expect(200)).body);
    expect(inc.reportsCount).toBe(1);
    expect(inc.reports.map((r) => r.id)).toEqual([r2]);
    expect(IncidentList.parse((await listar(a, analista).expect(200)).body).items[0]).toMatchObject({ id, reportsCount: 1 });
  });
});

describe('comentarios', () => {
  it('201 con autor; el detalle los trae en orden cronológico; sube updatedAt; auditoría solo con la longitud', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    const antes = (await db.incident.findUniqueOrThrow({ where: { id } })).updatedAt;

    const r1 = await comentar(a, analista, id, 'Primer <b>comentario</b>');
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const c1 = Comment.parse(r1.body);
    expect(c1).toMatchObject({ body: 'Primer <b>comentario</b>', author: { id: analista.userId, displayName: 'Persona analyst' } });
    const c2 = Comment.parse((await comentar(a, admin, id, 'Segundo').expect(201)).body);
    expect((await db.incident.findUniqueOrThrow({ where: { id } })).updatedAt.getTime()).toBeGreaterThan(antes.getTime());

    const inc = IncidentDetail.parse((await ver(a, analista, id).expect(200)).body);
    expect(inc.comments.map((c) => c.id)).toEqual([c1.id, c2.id]);
    expect(inc.comments[1]!.author).toEqual({ id: admin.userId, displayName: 'Persona admin' });

    const e = await db.auditEvent.findFirstOrThrow({ where: { action: 'incident.comment', actorId: analista.userId } });
    expect(e).toMatchObject({ result: 'success', targetType: 'incident', targetId: id, metadata: { commentId: c1.id, length: 'Primer <b>comentario</b>'.length } });
  });

  it('400 con cuerpo vacío o de más de 2000; 404 incidente inexistente o mal formado; 409 si es final', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    for (const body of [{}, { body: '' }, { body: 'c'.repeat(2001) }, { body: 3 }]) {
      const res = await request(a).post(`/api/v1/incidents/${id}/comments`).set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf).send(body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    await comentar(a, analista, id, 'c'.repeat(2000)).expect(201);
    for (const malo of [UUID_INEXISTENTE, 'no-es-uuid']) {
      const res = await comentar(a, analista, malo, 'hola');
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('El incidente no existe.');
    }
    for (const final of ['closed', 'false_positive'] as const) {
      await db.incident.update({ where: { id }, data: { status: final } });
      const res = await comentar(a, analista, id, 'tarde');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'conflict', message: FINAL });
    }
    expect(await db.incidentComment.count()).toBe(1);
  });

  it('no existen rutas para editar ni borrar comentarios (404)', async () => {
    const { app: a } = crearApp();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const id = await crearIncidente(a, analista);
    const c = Comment.parse((await comentar(a, analista, id, 'original').expect(201)).body);
    const base = `/api/v1/incidents/${id}/comments`;
    for (const res of [
      await request(a).patch(`${base}/${c.id}`).set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf).send({ body: 'cambiado' }),
      await request(a).put(`${base}/${c.id}`).set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf).send({ body: 'cambiado' }),
      await request(a).delete(`${base}/${c.id}`).set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf),
      await request(a).delete(base).set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf),
      await request(a).get(`${base}/${c.id}`).set('Cookie', analista.cookie),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await db.incidentComment.findUniqueOrThrow({ where: { id: c.id } })).body).toBe('original');
  });
});
