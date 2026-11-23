import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Mailbox, MailboxList, MessageDetail, MessageList, SimulatedDeliveryResult, SyncResult } from '../../src/contract/schemas/lab.js';
import { ReportSummary } from '../../src/contract/schemas/reports.js';
import { dedupeKey } from '../../src/lab/index-message.js';
import { FakeServer } from './fake-mail.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Rutas del laboratorio IMAP (M4) de punta a punta: base real y un proveedor de correo en memoria
// inyectado en la app (sin Dovecot).
type App = Parameters<typeof request>[0];
const LAB = new URL('../fixtures/lab/', import.meta.url);
type LabMessage = { id: string; file: string; mailbox: string; messageId: string; expectedRules: string[] };
const manifest = JSON.parse(readFileSync(new URL('manifest.json', LAB), 'utf8')) as { messages: LabMessage[] };
const rawOf = (file: string) => readFileSync(new URL(file, LAB));
const INST = { INSTITUTIONAL_DOMAINS: 'universidad-ejemplo.example' };
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

/** Un servidor falso por buzón, sembrado con sus 7 mensajes del laboratorio. */
function servidores(): Map<string, FakeServer> {
  const mapa = new Map<string, FakeServer>();
  for (const address of ['student@lab.example', 'teacher@lab.example', 'staff@lab.example']) {
    const s = new FakeServer();
    for (const m of manifest.messages.filter((x) => x.mailbox === address)) s.add(rawOf(m.file));
    mapa.set(address, s);
  }
  return mapa;
}

function app(mapa = servidores()) {
  const creada = crearApp(INST, { openMailProvider: (address) => mapa.get(address)!.open() });
  return { ...creada, mapa };
}

const buzon = async (label: 'student' | 'teacher' | 'staff') => db.mailbox.findUniqueOrThrow({ where: { label } });

const sync = (a: App, s: Sesion, id: string) => request(a).post(`/api/v1/mailboxes/${id}/sync`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
const entregar = (a: App, s: Sesion, id: string, reportId: unknown) =>
  request(a).post(`/api/v1/mailboxes/${id}/simulated-delivery`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send({ reportId });

async function subirEml(a: App, s: Sesion, eml: Buffer): Promise<string> {
  const res = await request(a).post('/api/v1/reports').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).attach('file', eml, { filename: 'correo.eml' });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return ReportSummary.parse(res.body).id;
}

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

describe('acceso a las rutas del laboratorio', () => {
  it('401 sin sesión y 403 al reportante en las 5 rutas', async () => {
    const { app: a } = app();
    const { id } = await buzon('student');
    const rutas = [
      ['get', '/api/v1/mailboxes'],
      ['post', `/api/v1/mailboxes/${id}/sync`],
      ['get', '/api/v1/messages'],
      ['get', `/api/v1/messages/${UUID_INEXISTENTE}`],
      ['post', `/api/v1/mailboxes/${id}/simulated-delivery`],
    ] as const;
    for (const [metodo, ruta] of rutas) {
      const sin = await request(a)[metodo](ruta);
      // Sin sesión: 401 en GET; en POST el csrfGuard responde antes (403 forbidden) si falta el token.
      expect([401, 403], `${metodo} ${ruta}`).toContain(sin.status);
    }
    for (const [metodo, ruta] of rutas.filter(([m]) => m === 'get')) {
      expect((await request(a)[metodo](ruta)).status, `${metodo} ${ruta}`).toBe(401);
    }
    const reportante = await entrarComo(a, 'reporter', 'reportante@ejemplo.invalid');
    for (const [metodo, ruta] of rutas) {
      const res = await request(a)[metodo](ruta).set('Cookie', reportante.cookie).set('X-CSRF-Token', reportante.csrf).send({ reportId: UUID_INEXISTENTE });
      expect(res.status, `${metodo} ${ruta}`).toBe(403);
      expect(res.body.code).toBe('forbidden');
    }
  });

  it('el administrador también puede (analista o administrador)', async () => {
    const { app: a } = app();
    const admin = await entrarComo(a, 'admin', 'admin@ejemplo.invalid');
    expect((await request(a).get('/api/v1/mailboxes').set('Cookie', admin.cookie)).status).toBe(200);
  });
});

describe('buzones y sincronización', () => {
  it('lista los 3 buzones con sus conteos; sync → 200 con SyncResult y la segunda no cambia nada', async () => {
    const { app: a } = app();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');

    let lista = MailboxList.parse((await request(a).get('/api/v1/mailboxes').set('Cookie', analista.cookie).expect(200)).body);
    expect(lista.items.map((b) => [b.label, b.address, b.messageCount, b.lastSyncStatus, b.lastSyncAt])).toEqual([
      ['student', 'student@lab.example', 0, 'never', null],
      ['teacher', 'teacher@lab.example', 0, 'never', null],
      ['staff', 'staff@lab.example', 0, 'never', null],
    ]);

    for (const b of lista.items) {
      const primera = await sync(a, analista, b.id);
      expect(primera.status, JSON.stringify(primera.body)).toBe(200);
      expect(SyncResult.parse(primera.body)).toMatchObject({ mailboxId: b.id, fetched: 7, added: 7, updated: 0, uidValidityChanged: false });
      const segunda = SyncResult.parse((await sync(a, analista, b.id).expect(200)).body);
      expect(segunda).toMatchObject({ fetched: 0, added: 0, updated: 0 });
    }

    lista = MailboxList.parse((await request(a).get('/api/v1/mailboxes').set('Cookie', analista.cookie).expect(200)).body);
    for (const b of lista.items) {
      expect(Mailbox.parse(b)).toMatchObject({ messageCount: 7, lastSyncStatus: 'ok' });
      expect(b.lastSyncAt).not.toBeNull();
    }
    // Las reglas guardadas coinciden con el manifiesto (no salen por la API: se miran en la base).
    for (const m of manifest.messages) {
      const fila = await db.indexedMessage.findFirstOrThrow({ where: { dedupeKey: dedupeKey(m.messageId)! } });
      expect(fila.ruleIds, m.id).toEqual(m.expectedRules);
    }
    const auditoria = await db.auditEvent.findMany({ where: { action: 'mailbox.sync' } });
    expect(auditoria).toHaveLength(6);
    expect(auditoria.every((e) => e.actorId === analista.userId && e.requestId)).toBe(true);
  });

  it('sync con el arriendo tomado → 409; buzón inexistente o id mal formado → 404', async () => {
    const { app: a } = app();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const { id } = await buzon('teacher');
    await db.$executeRaw`UPDATE mailboxes SET sync_started_at = now() WHERE id = ${id}::uuid`;
    const ocupado = await sync(a, analista, id);
    expect(ocupado.status).toBe(409);
    expect(ocupado.body).toMatchObject({ code: 'conflict' });

    expect((await sync(a, analista, UUID_INEXISTENTE)).status).toBe(404);
    const mal = await sync(a, analista, 'no-es-uuid');
    expect(mal.status).toBe(404);
    expect(mal.body.code).toBe('not_found');
  });

  it('proveedor caído → 503 con mensaje fijo, sin datos internos; el estado queda error', async () => {
    const mapa = servidores();
    for (const s of mapa.values()) s.failOpen = true;
    const { app: a } = app(mapa);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const { id } = await buzon('staff');
    const res = await sync(a, analista, id);
    expect(res.status).toBe(503);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'message', 'requestId']);
    expect(res.body).toMatchObject({ code: 'service_unavailable', message: 'El servidor IMAP del laboratorio no responde. Intenta más tarde.' });
    expect(JSON.stringify(res.body)).not.toMatch(/@|imap:|143|stack|Error/);
    expect((await db.mailbox.findUniqueOrThrow({ where: { id } })).lastSyncStatus).toBe('error');
  });

  it('sin contraseña del laboratorio (proveedor IMAP real por defecto) → 503 y el resto de la API sigue', async () => {
    const { app: a } = crearApp({ ...INST, IMAP_LAB_PASSWORD: '' });
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const { id } = await buzon('student');
    const res = await sync(a, analista, id);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('service_unavailable');
    expect((await request(a).get('/api/v1/reports').set('Cookie', analista.cookie)).status).toBe(200);
  });
});

describe('mensajes indexados', () => {
  it('GET /messages con filtros y paginación; detalle con enlaces desactivados, adjuntos unsupported y sin rule_ids', async () => {
    const { app: a } = app();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    for (const label of ['student', 'teacher', 'staff'] as const) await sync(a, analista, (await buzon(label)).id).expect(200);
    const teacher = await buzon('teacher');

    const todo = MessageList.parse((await request(a).get('/api/v1/messages?pageSize=100').set('Cookie', analista.cookie).expect(200)).body);
    expect(todo.total).toBe(21);
    expect(todo.items).toHaveLength(21);
    // Por fecha descendente.
    const fechas = todo.items.map((m) => m.date!);
    expect([...fechas].sort().reverse()).toEqual(fechas);

    const pagina = MessageList.parse((await request(a).get(`/api/v1/messages?mailboxId=${teacher.id}&page=2&pageSize=5`).set('Cookie', analista.cookie).expect(200)).body);
    expect(pagina).toMatchObject({ page: 2, pageSize: 5, total: 7 });
    expect(pagina.items).toHaveLength(2);
    expect(pagina.items.every((m) => m.mailboxId === teacher.id && m.location === 'inbox' && !m.quarantined)).toBe(true);

    expect(MessageList.parse((await request(a).get('/api/v1/messages?location=quarantine').set('Cookie', analista.cookie).expect(200)).body).total).toBe(0);
    expect((await request(a).get('/api/v1/messages?location=papelera').set('Cookie', analista.cookie)).status).toBe(400);
    expect((await request(a).get('/api/v1/messages?mailboxId=no-uuid').set('Cookie', analista.cookie)).status).toBe(400);
    expect((await request(a).get('/api/v1/messages?pageSize=101').set('Cookie', analista.cookie)).status).toBe(400);

    // Detalle de B1 (adjunto) y de A1 (enlace engañoso).
    const b1 = await db.indexedMessage.findFirstOrThrow({ where: { dedupeKey: '<b1.factura@lab.example>' } });
    const detB1 = await request(a).get(`/api/v1/messages/${b1.id}`).set('Cookie', analista.cookie).expect(200);
    const b1Dto = MessageDetail.parse(detB1.body);
    expect(b1Dto.attachments).toHaveLength(1);
    expect(b1Dto.attachments[0]).toMatchObject({ fileName: 'factura-0042.pdf.exe', scanStatus: 'unsupported', scanDetail: 'No se escanea al sincronizar el laboratorio.', scannedAt: null });
    expect(b1Dto).toMatchObject({ uid: Number(b1.uid), uidValidity: Number(b1.uidValidity), hasAttachments: true, quarantined: false });
    for (const prohibido of ['ruleIds', 'rule_ids', 'dedupeKey', 'replyTo', 'priority', 'rulesVersion']) expect(detB1.body).not.toHaveProperty(prohibido);

    const a1 = await db.indexedMessage.findFirstOrThrow({ where: { dedupeKey: '<a1.vence-correo@lab.example>' } });
    const a1Dto = MessageDetail.parse((await request(a).get(`/api/v1/messages/${a1.id}`).set('Cookie', analista.cookie).expect(200)).body);
    expect(a1Dto.links).toHaveLength(1);
    expect(a1Dto.links[0]!.defangedUrl).toMatch(/^hxxps:\/\/universidad-ejernplo\[\.\]example/);
    expect(a1Dto.links[0]!.domain).toBe('universidad-ejernplo[.]example');
    expect(a1Dto.links[0]!.displayText).not.toContain('https://');
    expect(JSON.stringify(a1Dto)).not.toMatch(/https?:\/\//);

    expect((await request(a).get(`/api/v1/messages/${UUID_INEXISTENTE}`).set('Cookie', analista.cookie)).status).toBe(404);
    expect((await request(a).get('/api/v1/messages/no-es-uuid').set('Cookie', analista.cookie)).status).toBe(404);
  });
});

describe('entrega simulada', () => {
  it('201 con MessageSummary; repetirla no duplica (sin otro APPEND); se audita; una sincronización después no cambia nada', async () => {
    const { app: a, mapa } = app();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const student = await buzon('student');
    await sync(a, analista, student.id).expect(200);

    // Un reporte .eml del analista con un correo que el buzón no tiene (B1, del buzón teacher).
    const reportId = await subirEml(a, analista, rawOf('B1-factura.eml'));
    const primera = await entregar(a, analista, student.id, reportId);
    expect(primera.status, JSON.stringify(primera.body)).toBe(201);
    const { message } = SimulatedDeliveryResult.parse(primera.body);
    expect(message).toMatchObject({ mailboxId: student.id, location: 'inbox', hasAttachments: true, quarantined: false, fromAddress: 'facturacion@proveedor-pagos.example' });
    const servidor = mapa.get('student@lab.example')!;
    expect(servidor.appended).toBe(1);
    expect(servidor.folders.inbox.messages).toHaveLength(8);

    const fila = await db.indexedMessage.findUniqueOrThrow({ where: { id: message.id }, include: { attachments: true } });
    expect(fila.ruleIds).toEqual(['R7']);
    expect(fila.attachments[0]!.scanStatus).toBe('unsupported');
    expect(Number(fila.uid)).toBe(message.uid);

    const segunda = await entregar(a, analista, student.id, reportId);
    expect(segunda.status).toBe(201);
    expect(SimulatedDeliveryResult.parse(segunda.body).message.id).toBe(message.id);
    expect(servidor.appended).toBe(1);
    expect(await db.indexedMessage.count({ where: { mailboxId: student.id } })).toBe(8);

    // La sincronización reconoce el mensaje entregado (misma clave, mismo UID): nada que cambiar.
    expect(SyncResult.parse((await sync(a, analista, student.id).expect(200)).body)).toMatchObject({ fetched: 0, added: 0, updated: 0 });

    const auditoria = await db.auditEvent.findMany({ where: { action: 'mailbox.simulated_delivery' }, orderBy: { createdAt: 'asc' } });
    expect(auditoria.map((e) => [e.result, e.targetType, e.targetId, e.actorId])).toEqual([
      ['success', 'mailbox', student.id, analista.userId],
      ['success', 'mailbox', student.id, analista.userId],
    ]);
    expect(auditoria.map((e) => e.metadata)).toEqual([
      { reportId, appended: 1 },
      { reportId, appended: 0 },
    ]);
  });

  it('reporte pegado → 400; inexistente → 404; cuerpo inválido → 400; buzón inexistente → 404; arriendo tomado → 409; IMAP caído → 503', async () => {
    const mapa = servidores();
    const { app: a } = app(mapa);
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const staff = await buzon('staff');

    const pegado = await request(a).post('/api/v1/reports/paste').set('Cookie', analista.cookie).set('X-CSRF-Token', analista.csrf).send({ text: 'From: a@ejemplo.invalid\nSubject: hola\n\ncuerpo' });
    expect(pegado.status).toBe(202);
    const noEml = await entregar(a, analista, staff.id, ReportSummary.parse(pegado.body).id);
    expect(noEml.status).toBe(400);
    expect(noEml.body).toMatchObject({ code: 'validation_error', details: [{ field: 'reportId' }] });

    expect((await entregar(a, analista, staff.id, UUID_INEXISTENTE)).status).toBe(404);
    expect((await entregar(a, analista, staff.id, 'no-es-uuid')).status).toBe(400);
    expect((await entregar(a, analista, staff.id, undefined)).status).toBe(400);

    const reportId = await subirEml(a, analista, rawOf('LD1-personal.eml'));
    expect((await entregar(a, analista, UUID_INEXISTENTE, reportId)).status).toBe(404);
    expect((await entregar(a, analista, 'no-es-uuid', reportId)).status).toBe(404);

    await db.$executeRaw`UPDATE mailboxes SET sync_started_at = now() WHERE id = ${staff.id}::uuid`;
    const ocupado = await entregar(a, analista, staff.id, reportId);
    expect(ocupado.status).toBe(409);
    expect(ocupado.body.code).toBe('conflict');
    await db.$executeRaw`UPDATE mailboxes SET sync_started_at = NULL WHERE id = ${staff.id}::uuid`;

    mapa.get('staff@lab.example')!.failAppend = true;
    const caido = await entregar(a, analista, staff.id, reportId);
    expect(caido.status).toBe(503);
    expect(caido.body).toMatchObject({ code: 'service_unavailable', message: 'El servidor IMAP del laboratorio no responde. Intenta más tarde.' });
    expect(await db.indexedMessage.count({ where: { mailboxId: staff.id } })).toBe(0);
    // El arriendo siempre se suelta.
    expect((await db.mailbox.findUniqueOrThrow({ where: { id: staff.id } })).syncStartedAt).toBeNull();
    const fallos = await db.auditEvent.findMany({ where: { action: 'mailbox.simulated_delivery', result: 'failure' } });
    expect(fallos.map((e) => (e.metadata as { reason: string }).reason).sort()).toEqual(['in_progress', 'mail_unavailable']);
  });
});

describe('P-18 en las rutas del laboratorio', () => {
  it('los registros no contienen asuntos, direcciones ni Message-ID', async () => {
    const { app: a, lineas } = app();
    const analista = await entrarComo(a, 'analyst', 'analista@ejemplo.invalid');
    const teacher = await buzon('teacher');
    await sync(a, analista, teacher.id).expect(200);
    const lista = MessageList.parse((await request(a).get('/api/v1/messages?pageSize=100').set('Cookie', analista.cookie).expect(200)).body);
    await request(a).get(`/api/v1/messages/${lista.items[0]!.id}`).set('Cookie', analista.cookie).expect(200);
    const reportId = await subirEml(a, analista, rawOf('C1-beca.eml'));
    await entregar(a, analista, teacher.id, reportId).expect(201);

    const todo = lineas.join('\n');
    expect(todo).toContain(teacher.id);
    // Solo el correo de la cuenta de prueba (registros de M0 ya existentes) puede aparecer con @.
    const sinCuenta = todo.replaceAll('analista@ejemplo.invalid', '');
    expect(sinCuenta).not.toContain('@');
    for (const m of manifest.messages) {
      const subject = /^Subject:\s*(.+)$/im.exec(rawOf(m.file).toString('utf8'))?.[1]?.trim();
      if (subject) expect(todo, m.id).not.toContain(subject);
      expect(todo, m.id).not.toContain(m.messageId.slice(1, -1));
    }
    for (const texto of ['universidad-ejernplo', 'nube-compartida', 'factura-0042', 'apoyo-becas', '203.0.113']) expect(todo).not.toContain(texto);
  });
});
