import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditList } from '../../src/contract/schemas/audit.js';
import { IncidentDetail } from '../../src/contract/schemas/incidents.js';
import { ReportSummary } from '../../src/contract/schemas/reports.js';
import { ActionList, QuarantineResponse, RestoreResponse } from '../../src/contract/schemas/response.js';
import { dedupeKey } from '../../src/lab/index-message.js';
import { createLogger } from '../../src/logger.js';
import { runCleanup } from '../../src/queue/cleanup.js';
import { FakeServer } from './fake-mail.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// M7 de punta a punta por la API, con los casos del documento de requerimientos: P-12
// (UIDVALIDITY distinto), P-13 (acción repetida), P-14 (corte a medio lote), P-15 (restaurar con
// reverificación), P-18 (registros y auditoría sin cuerpos ni direcciones) y P-21 (borrado a los
// 7 días con un incidente). Proveedor de correo en memoria; el Dovecot real va en las pruebas de humo.
type App = Parameters<typeof request>[0];
const LAB = new URL('../fixtures/lab/', import.meta.url);
type LabMessage = { id: string; file: string; mailbox: string; messageId: string };
const manifest = JSON.parse(readFileSync(new URL('manifest.json', LAB), 'utf8')) as { messages: LabMessage[] };
const rawOf = (file: string) => readFileSync(new URL(file, LAB));
const fixture = (id: string) => manifest.messages.find((m) => m.id === id)!;

function app() {
  const mapa = new Map<string, FakeServer>();
  for (const address of ['student@lab.example', 'teacher@lab.example', 'staff@lab.example']) {
    const s = new FakeServer();
    for (const m of manifest.messages.filter((x) => x.mailbox === address)) s.add(rawOf(m.file));
    mapa.set(address, s);
  }
  const creada = crearApp({ INSTITUTIONAL_DOMAINS: 'universidad-ejemplo.example' }, { openMailProvider: (address) => mapa.get(address)!.open() });
  return { ...creada, mapa };
}

const post = (a: App, s: Sesion, ruta: string, body: object = {}) => request(a).post(`/api/v1${ruta}`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
const get = (a: App, s: Sesion, ruta: string) => request(a).get(`/api/v1${ruta}`).set('Cookie', s.cookie);
const indexado = (id: string) => db.indexedMessage.findFirstOrThrow({ where: { dedupeKey: dedupeKey(fixture(id).messageId)! } });

/** Sincroniza los 3 buzones y crea un incidente en analyzing por la API. */
async function preparar(a: App, s: Sesion): Promise<string> {
  for (const b of await db.mailbox.findMany()) expect((await post(a, s, `/mailboxes/${b.id}/sync`)).status).toBe(200);
  const inc = await post(a, s, '/incidents', { title: 'Campaña de becas' });
  expect(inc.status).toBe(201);
  expect((await request(a).patch(`/api/v1/incidents/${inc.body.id}`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send({ status: 'analyzing' })).status).toBe(200);
  return inc.body.id as string;
}

const cuarentena = async (a: App, s: Sesion, incidentId: string, messageIds: string[]) => {
  const res = await post(a, s, `/incidents/${incidentId}/quarantine`, { messageIds, confirm: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return QuarantineResponse.parse(res.body).results;
};

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

describe('M7 de punta a punta', () => {
  it('P-12: UIDVALIDITY distinto → uidvalidity_mismatch, no se mueve y tras sincronizar se puede', async () => {
    const { app: a, mapa } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const inc = await preparar(a, s);
    const a1 = await indexado('A1');
    mapa.get('student@lab.example')!.resetUidValidity('inbox', 1999999999);

    const [r] = await cuarentena(a, s, inc, [a1.id]);
    expect(r!.outcome).toBe('uidvalidity_mismatch');
    expect(mapa.get('student@lab.example')!.moved).toBe(0);
    const buzones = (await get(a, s, '/mailboxes')).body.items as { id: string; lastSyncStatus: string }[];
    expect(buzones.find((b) => b.id === a1.mailboxId)!.lastSyncStatus).toBe('error');

    const sync = await post(a, s, `/mailboxes/${a1.mailboxId}/sync`);
    expect(sync.body.uidValidityChanged).toBe(true);
    const [otra] = await cuarentena(a, s, inc, [(await indexado('A1')).id]);
    expect(otra!.outcome).toBe('quarantined');
  });

  it('P-13: repetir la cuarentena y la restauración no mueve nada', async () => {
    const { app: a, mapa } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const inc = await preparar(a, s);
    const a1 = await indexado('A1');
    const [q1] = await cuarentena(a, s, inc, [a1.id]);
    const [q2] = await cuarentena(a, s, inc, [a1.id]);
    expect([q1!.outcome, q2!.outcome]).toEqual(['quarantined', 'already_quarantined']);
    expect(q2!.actionId).toBe(q1!.actionId);
    const r1 = RestoreResponse.parse((await post(a, s, `/actions/${q1!.actionId}/restore`, { confirm: true })).body);
    const r2 = RestoreResponse.parse((await post(a, s, `/actions/${q1!.actionId}/restore`, { confirm: true })).body);
    expect([r1.outcome, r2.outcome]).toEqual(['restored', 'already_restored']);
    expect(r2.restoreActionId).toBe(r1.restoreActionId);
    expect(mapa.get('student@lab.example')!.moved).toBe(2);
    expect(ActionList.parse((await get(a, s, `/incidents/${inc}/actions`)).body).items).toHaveLength(2);
  });

  it('P-14: corte de conexión a medio lote → resultado por mensaje; los no movidos salen error y nada queda a medias', async () => {
    const { app: a, mapa } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const inc = await preparar(a, s);
    const ids = [(await indexado('A1')).id, (await indexado('B3')).id, (await indexado('A3')).id];
    mapa.get('student@lab.example')!.cutAfterMoves = 1;
    const r = await cuarentena(a, s, inc, ids);
    expect(r.map((x) => x.outcome)).toEqual(['quarantined', 'error', 'quarantined']);
    // El índice dice lo mismo que el servidor para cada mensaje.
    for (const id of ['A1', 'B3', 'A3']) {
      const fila = await indexado(id);
      const servidor = mapa.get(fixture(id).mailbox)!.find(fixture(id).messageId);
      expect(fila.location, id).toBe(servidor.location);
      expect(Number(fila.uid), id).toBe(servidor.stored.uid);
    }
    // Reintento con la conexión sana: B3 reutiliza su acción fallida.
    mapa.get('student@lab.example')!.cutAfterMoves = null;
    const [otra] = await cuarentena(a, s, inc, [ids[1]!]);
    expect(otra).toMatchObject({ outcome: 'quarantined', actionId: r[1]!.actionId });
  });

  it('P-15: restaurar reverifica antes de mover; si el mensaje cambió no actúa', async () => {
    const { app: a, mapa } = app();
    const s = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    const inc = await preparar(a, s);
    const [a1, b3] = [await indexado('A1'), await indexado('B3')];
    const [q1, q2] = await cuarentena(a, s, inc, [a1.id, b3.id]);
    const student = mapa.get('student@lab.example')!;

    // B3 desapareció de Cuarentena: not_found, sin mover.
    student.remove(fixture('B3').messageId);
    const r2 = RestoreResponse.parse((await post(a, s, `/actions/${q2!.actionId}/restore`, { confirm: true })).body);
    expect(r2.outcome).toBe('not_found');

    const r1 = RestoreResponse.parse((await post(a, s, `/actions/${q1!.actionId}/restore`, { confirm: true })).body);
    expect(r1.outcome).toBe('restored');
    expect(student.find(fixture('A1').messageId).location).toBe('inbox');
    expect(student.moved).toBe(3);
    const detalle = await get(a, s, `/messages/${a1.id}`);
    expect(detalle.body).toMatchObject({ location: 'inbox', quarantined: false, uid: student.find(fixture('A1').messageId).stored.uid });
  });

  it('P-18: ni los registros de pino ni GET /audit llevan asuntos, remitentes, direcciones, Message-ID, UID ni cuerpos', async () => {
    const { app: a, lineas } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const inc = await preparar(a, s);
    const a1 = await indexado('A1');
    const [q] = await cuarentena(a, s, inc, [a1.id]);
    await post(a, s, `/actions/${q!.actionId}/restore`, { confirm: true });
    const auditoria = await get(a, s, '/audit?pageSize=100');
    const eventos = AuditList.parse(auditoria.body).items.filter((e) => e.action.startsWith('quarantine.'));
    expect(eventos.map((e) => e.action).sort()).toEqual(['quarantine.execute', 'quarantine.restore']);

    const cuerpo = rawOf(fixture('A1').file).toString('utf8');
    const linea = cuerpo.split(/\r?\n\r?\n/)[1]!.split(/\r?\n/).find((l) => l.trim().length > 20)!.trim();
    for (const texto of [lineas.join('\n'), JSON.stringify(auditoria.body)]) {
      expect(texto).not.toContain('@lab.example');
      expect(texto.toLowerCase()).not.toContain(fixture('A1').messageId.toLowerCase());
      expect(texto).not.toContain(a1.subject!);
      if (a1.fromAddress) expect(texto).not.toContain(a1.fromAddress);
      expect(texto).not.toContain(linea);
      expect(texto).not.toMatch(/"uid(Validity)?"/i);
    }
  });

  it('P-21: un reporte vencido asociado a un incidente se borra, el incidente se queda sin él y la limpieza queda auditada solo con conteos', async () => {
    const { app: a, storage } = app();
    const s = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const eml = readFileSync(new URL('../fixtures/emails/L03-texto-plano-simple.eml', import.meta.url));
    const subido = await request(a).post('/api/v1/reports').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).attach('file', eml, { filename: 'correo.eml' });
    const reportId = ReportSummary.parse(subido.body).id;
    const inc = await post(a, s, '/incidents', { title: 'Con reporte' });
    expect((await post(a, s, `/incidents/${inc.body.id}/reports`, { reportId })).status).toBe(200);
    await db.$executeRaw`UPDATE reports SET expires_at = now() - interval '1 minute' WHERE id = ${reportId}::uuid`;

    const counts = await runCleanup({ db, storage, logger: createLogger('silent') });
    expect(counts).toMatchObject({ expiredReports: 1, folderErrors: 0 });
    expect(await db.report.count({ where: { id: reportId } })).toBe(0);
    const detalle = IncidentDetail.parse((await get(a, s, `/incidents/${inc.body.id}`)).body);
    expect(detalle.reports).toEqual([]);
    expect(detalle.reportsCount).toBe(0);

    const limpieza = AuditList.parse((await get(a, s, '/audit?action=system.cleanup')).body);
    expect(limpieza.total).toBe(1);
    expect(limpieza.items[0]).toMatchObject({ actor: null, requestId: null, result: 'success' });
    expect(Object.keys(limpieza.items[0]!.metadata).sort()).toEqual(['expiredReports', 'expiredSessions', 'folderErrors', 'orphanFolders']);
  });

  it('permisos por rol en las 4 rutas: reportante 403, analista y administrador sí', async () => {
    const { app: a } = app();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const inc = await preparar(a, analista);
    const [q] = await cuarentena(a, analista, inc, [(await indexado('A1')).id]);
    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    const llamadas = [
      (s: Sesion) => post(a, s, `/incidents/${inc}/quarantine`, { messageIds: [q!.messageId], confirm: true }),
      (s: Sesion) => get(a, s, `/incidents/${inc}/actions`),
      (s: Sesion) => post(a, s, `/actions/${q!.actionId}/restore`, { confirm: true }),
      (s: Sesion) => get(a, s, '/audit'),
    ];
    for (const llamar of llamadas) expect((await llamar(reportante)).status).toBe(403);
    for (const llamar of llamadas) expect((await llamar(admin)).status).toBe(200);
  });
});
