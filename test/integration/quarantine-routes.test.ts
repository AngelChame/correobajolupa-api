import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { ActionList, QuarantineResponse, RestoreResponse } from '../../src/contract/schemas/response.js';
import { dedupeKey } from '../../src/lab/index-message.js';
import { FakeServer } from './fake-mail.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Rutas de M7 (cuarentena, acciones y restauración) de punta a punta: base real y un proveedor
// de correo en memoria por buzón (sin Dovecot).
type App = Parameters<typeof request>[0];
const LAB = new URL('../fixtures/lab/', import.meta.url);
type LabMessage = { id: string; file: string; mailbox: string; messageId: string };
const manifest = JSON.parse(readFileSync(new URL('manifest.json', LAB), 'utf8')) as { messages: LabMessage[] };
const rawOf = (file: string) => readFileSync(new URL(file, LAB));
const fixture = (id: string) => manifest.messages.find((m) => m.id === id)!;
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

function servidores(): Map<string, FakeServer> {
  const mapa = new Map<string, FakeServer>();
  for (const address of ['student@lab.example', 'teacher@lab.example', 'staff@lab.example']) {
    const s = new FakeServer();
    for (const m of manifest.messages.filter((x) => x.mailbox === address)) s.add(rawOf(m.file));
    mapa.set(address, s);
  }
  return mapa;
}

function app() {
  const mapa = servidores();
  const creada = crearApp({ INSTITUTIONAL_DOMAINS: 'universidad-ejemplo.example' }, { openMailProvider: (address) => mapa.get(address)!.open() });
  return { ...creada, mapa };
}

const post = (a: App, s: Sesion, ruta: string, body: unknown) => request(a).post(ruta).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body as object);
const get = (a: App, s: Sesion, ruta: string) => request(a).get(ruta).set('Cookie', s.cookie);

async function sincronizarTodo(a: App, s: Sesion): Promise<void> {
  for (const b of await db.mailbox.findMany()) expect((await post(a, s, `/api/v1/mailboxes/${b.id}/sync`, {})).status).toBe(200);
}

const indexado = (id: string) => db.indexedMessage.findFirstOrThrow({ where: { dedupeKey: dedupeKey(fixture(id).messageId)! } });

async function incidente(s: Sesion, status: 'received' | 'analyzing' | 'contained' | 'closed' | 'false_positive' = 'analyzing') {
  return db.incident.create({ data: { title: 'Campaña', status, createdById: s.userId } });
}

const cuarentena = (a: App, s: Sesion, incidentId: string, messageIds: unknown, confirm: unknown = true) =>
  post(a, s, `/api/v1/incidents/${incidentId}/quarantine`, { messageIds, confirm });
const restaurar = (a: App, s: Sesion, actionId: string, body: unknown = { confirm: true }) => post(a, s, `/api/v1/actions/${actionId}/restore`, body);

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

describe('acceso a las rutas de M7', () => {
  it('401 sin sesión, 403 al reportante (auditado) y 200 a analista y administrador', async () => {
    const { app: a } = app();
    const rutas = [
      ['post', `/api/v1/incidents/${UUID_INEXISTENTE}/quarantine`],
      ['get', `/api/v1/incidents/${UUID_INEXISTENTE}/actions`],
      ['post', `/api/v1/actions/${UUID_INEXISTENTE}/restore`],
    ] as const;
    for (const [metodo, ruta] of rutas) {
      const sin = await request(a)[metodo](ruta);
      // En POST sin sesión el csrfGuard responde antes (403); en GET, 401.
      expect(metodo === 'get' ? [401] : [401, 403], `${metodo} ${ruta}`).toContain(sin.status);
    }
    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    for (const [metodo, ruta] of rutas) {
      const res = await request(a)[metodo](ruta).set('Cookie', reportante.cookie).set('X-CSRF-Token', reportante.csrf).send({ confirm: true, messageIds: [UUID_INEXISTENTE] });
      expect(res.status, `${metodo} ${ruta}`).toBe(403);
      expect(res.body.code).toBe('forbidden');
    }
    expect(await db.auditEvent.count({ where: { action: 'authz.denied', actorId: reportante.userId } })).toBe(3);

    for (const rol of ['analyst', 'admin'] as const) {
      const s = await entrarComo(a, rol, `${rol}@ejemplo.invalid`);
      const inc = await incidente(s);
      expect((await cuarentena(a, s, inc.id, [UUID_INEXISTENTE])).status, rol).toBe(200);
      expect((await get(a, s, `/api/v1/incidents/${inc.id}/actions`)).status, rol).toBe(200);
    }
  });

  it('sin token CSRF: 403 y nada se mueve', async () => {
    const { app: a, mapa } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await sincronizarTodo(a, s);
    const inc = await incidente(s);
    const a1 = await indexado('A1');
    const res = await request(a).post(`/api/v1/incidents/${inc.id}/quarantine`).set('Cookie', s.cookie).send({ messageIds: [a1.id], confirm: true });
    expect(res.status).toBe(403);
    expect(mapa.get('student@lab.example')!.moved).toBe(0);
  });
});

describe('POST /incidents/{incidentId}/quarantine', () => {
  it('200: un resultado por mensaje en el orden recibido, con la forma del contrato', async () => {
    const { app: a, mapa } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await sincronizarTodo(a, s);
    const inc = await incidente(s);
    const ids = [(await indexado('A2')).id, UUID_INEXISTENTE, (await indexado('A1')).id];

    const res = await cuarentena(a, s, inc.id, ids);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = QuarantineResponse.parse(res.body);
    expect(body.incidentId).toBe(inc.id);
    expect(body.results.map((r) => [r.messageId, r.outcome])).toEqual([
      [ids[0], 'quarantined'],
      [ids[1], 'not_found'],
      [ids[2], 'quarantined'],
    ]);
    expect(mapa.get('student@lab.example')!.moved + mapa.get('teacher@lab.example')!.moved).toBe(2);

    // P-13: repetir no mueve nada.
    const otra = QuarantineResponse.parse((await cuarentena(a, s, inc.id, [ids[2]])).body);
    expect(otra.results[0]).toMatchObject({ outcome: 'already_quarantined', actionId: body.results[2]!.actionId });
    expect(mapa.get('student@lab.example')!.moved).toBe(1);

    // GET /messages refleja la Cuarentena.
    const msg = await get(a, s, `/api/v1/messages/${ids[2]}`);
    expect(msg.body).toMatchObject({ location: 'quarantine', quarantined: true });
  });

  it('400 con cuerpo inválido (confirm, ids repetidos, vacíos, más de 50, no UUID), auditado sin texto del cliente', async () => {
    const { app: a } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const inc = await incidente(s);
    const muchos = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const malos: [unknown, unknown][] = [
      [[UUID_INEXISTENTE], false],
      [[UUID_INEXISTENTE], 'true'],
      [[UUID_INEXISTENTE], undefined],
      [[UUID_INEXISTENTE, UUID_INEXISTENTE], true],
      [[], true],
      [muchos, true],
      [['MARCADOR-no-uuid'], true],
      ['MARCADOR', true],
    ];
    for (const [ids, confirm] of malos) {
      const res = await post(a, s, `/api/v1/incidents/${inc.id}/quarantine`, confirm === undefined ? { messageIds: ids } : { messageIds: ids, confirm });
      expect(res.status, JSON.stringify([ids, confirm]).slice(0, 80)).toBe(400);
      expect(ErrorResponse.parse(res.body).code).toBe('validation_error');
      expect(JSON.stringify(res.body)).not.toContain('MARCADOR');
    }
    const eventos = await db.auditEvent.findMany({ where: { action: 'quarantine.execute' } });
    expect(eventos).toHaveLength(malos.length);
    for (const e of eventos) {
      expect(e).toMatchObject({ result: 'failure', targetType: 'incident', targetId: inc.id, metadata: { reason: 'invalid_body' } });
    }
    expect(JSON.stringify(eventos)).not.toContain('MARCADOR');
  });

  it('404 con incidente inexistente o mal formado y 409 si no está en analyzing ni contained (también los finales)', async () => {
    const { app: a, mapa } = app();
    const s = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    await sincronizarTodo(a, s);
    const a1 = await indexado('A1');

    expect((await cuarentena(a, s, UUID_INEXISTENTE, [a1.id])).status).toBe(404);
    const mal = await cuarentena(a, s, 'MARCADOR', [a1.id]);
    expect(mal.status).toBe(404);
    for (const status of ['received', 'closed', 'false_positive'] as const) {
      const inc = await incidente(s, status);
      const res = await cuarentena(a, s, inc.id, [a1.id]);
      expect(res.status, status).toBe(409);
      expect(res.body.code).toBe('conflict');
    }
    expect(mapa.get('student@lab.example')!.moved).toBe(0);
    const eventos = await db.auditEvent.findMany({ where: { action: 'quarantine.execute' }, orderBy: { createdAt: 'asc' } });
    expect(eventos.map((e) => (e.metadata as { reason: string }).reason)).toEqual(['not_found', 'not_found', 'invalid_status', 'invalid_status', 'invalid_status']);
    expect(eventos[1]!.targetId).toBeNull();
    expect(JSON.stringify(eventos)).not.toContain('MARCADOR');
  });

  it('503 si el IMAP no responde y no se intentó nada; 503 sin IMAP_LAB_PASSWORD configurada', async () => {
    const { app: a, mapa } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await sincronizarTodo(a, s);
    const inc = await incidente(s);
    const a1 = await indexado('A1');
    mapa.get('student@lab.example')!.failOpen = true;
    const res = await cuarentena(a, s, inc.id, [a1.id]);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('service_unavailable');

    // App con el proveedor real y sin contraseña: no hay laboratorio.
    const { app: sinLab } = crearApp({ IMAP_LAB_PASSWORD: '' });
    const s2 = await entrarComo(sinLab, 'analyst', 'analista2@ejemplo.invalid');
    expect((await cuarentena(sinLab, s2, inc.id, [a1.id])).status).toBe(503);
  });
});

describe('GET /incidents/{incidentId}/actions', () => {
  it('acciones de cuarentena y restauración, de la más reciente a la más vieja, con la forma del contrato', async () => {
    const { app: a } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await sincronizarTodo(a, s);
    const inc = await incidente(s);
    const [a1, b3] = [await indexado('A1'), await indexado('B3')];
    const q = QuarantineResponse.parse((await cuarentena(a, s, inc.id, [a1.id])).body);
    await cuarentena(a, s, inc.id, [b3.id]);
    const r = RestoreResponse.parse((await restaurar(a, s, q.results[0]!.actionId!)).body);

    const res = await get(a, s, `/api/v1/incidents/${inc.id}/actions`);
    expect(res.status).toBe(200);
    const lista = ActionList.parse(res.body);
    expect(lista.items.map((x) => [x.type, x.messageId])).toEqual([
      ['restore', a1.id],
      ['quarantine', b3.id],
      ['quarantine', a1.id],
    ]);
    expect(lista.items[0]).toMatchObject({ id: r.restoreActionId, status: 'done', originalLocation: { folder: 'quarantine' }, newLocation: { folder: 'inbox' }, actor: { id: s.userId, displayName: 'Persona analyst' } });
    expect(lista.items[2]).toMatchObject({ originalLocation: { folder: 'inbox', uid: Number(a1.uid), uidValidity: Number(a1.uidValidity) }, newLocation: { folder: 'quarantine' } });

    expect((await get(a, s, `/api/v1/incidents/${UUID_INEXISTENTE}/actions`)).status).toBe(404);
    expect((await get(a, s, '/api/v1/incidents/no-es-uuid/actions')).status).toBe(404);
    const vacio = await incidente(s);
    expect((await get(a, s, `/api/v1/incidents/${vacio.id}/actions`)).body).toEqual({ items: [] });
  });
});

describe('POST /actions/{actionId}/restore', () => {
  it('200 restored y luego already_restored (P-13, P-15); en cualquier estado del incidente', async () => {
    const { app: a, mapa } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await sincronizarTodo(a, s);
    const inc = await incidente(s);
    const a1 = await indexado('A1');
    const q = QuarantineResponse.parse((await cuarentena(a, s, inc.id, [a1.id])).body);
    await db.incident.update({ where: { id: inc.id }, data: { status: 'false_positive' } });

    const res = await restaurar(a, s, q.results[0]!.actionId!);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = RestoreResponse.parse(res.body);
    expect(r).toMatchObject({ actionId: q.results[0]!.actionId, outcome: 'restored', detail: null });
    expect(mapa.get('student@lab.example')!.find(fixture('A1').messageId).location).toBe('inbox');

    const otra = RestoreResponse.parse((await restaurar(a, s, q.results[0]!.actionId!)).body);
    expect(otra).toEqual({ actionId: q.results[0]!.actionId, outcome: 'already_restored', restoreActionId: r.restoreActionId, detail: null });
    expect(mapa.get('student@lab.example')!.moved).toBe(2);
  });

  it('400 sin confirm; 404 con acción inexistente, mal formada o de restauración; 503 sin IMAP', async () => {
    const { app: a, mapa } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await sincronizarTodo(a, s);
    const inc = await incidente(s);
    const a1 = await indexado('A1');
    const q = QuarantineResponse.parse((await cuarentena(a, s, inc.id, [a1.id])).body);
    const actionId = q.results[0]!.actionId!;

    for (const body of [{}, { confirm: false }, { confirm: 'MARCADOR' }]) expect((await restaurar(a, s, actionId, body)).status).toBe(400);
    expect((await restaurar(a, s, UUID_INEXISTENTE)).status).toBe(404);
    expect((await restaurar(a, s, 'MARCADOR')).status).toBe(404);

    mapa.get('student@lab.example')!.failOpen = true;
    expect((await restaurar(a, s, actionId)).status).toBe(503);
    mapa.get('student@lab.example')!.failOpen = false;

    const r = RestoreResponse.parse((await restaurar(a, s, actionId)).body);
    const deRestauracion = await restaurar(a, s, r.restoreActionId!);
    expect(deRestauracion.status).toBe(404);

    const rechazos = await db.auditEvent.findMany({ where: { action: 'quarantine.restore', result: 'failure', targetType: 'action' }, orderBy: { createdAt: 'asc' } });
    expect(rechazos.map((e) => (e.metadata as { reason: string }).reason)).toEqual(['invalid_body', 'invalid_body', 'invalid_body', 'not_found', 'not_found', 'mail_unavailable', 'not_found']);
    expect(JSON.stringify(rechazos)).not.toContain('MARCADOR');
  });
});

describe('registros y auditoría de M7 (P-18)', () => {
  it('ni los registros de pino ni la auditoría llevan asuntos, direcciones, Message-ID ni UID', async () => {
    const { app: a, lineas } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    await sincronizarTodo(a, s);
    const inc = await incidente(s);
    const a1 = await indexado('A1');
    lineas.length = 0;
    const q = QuarantineResponse.parse((await cuarentena(a, s, inc.id, [a1.id, UUID_INEXISTENTE])).body);
    await restaurar(a, s, q.results[0]!.actionId!);
    await get(a, s, `/api/v1/incidents/${inc.id}/actions`);

    const eventos = await db.auditEvent.findMany({ where: { action: { startsWith: 'quarantine.' } } });
    for (const texto of [lineas.join('\n'), JSON.stringify(eventos)]) {
      expect(texto).not.toContain('@lab.example');
      expect(texto.toLowerCase()).not.toContain(fixture('A1').messageId.toLowerCase());
      expect(texto).not.toContain(a1.subject!);
      expect(texto).not.toMatch(/"uid/i);
    }
    for (const e of eventos) expect(Object.keys(e.metadata as object).sort()).toEqual(e.targetType === 'message' ? expect.arrayContaining(['incidentId', 'actionId', 'outcome']) : ['reason']);
  });
});
