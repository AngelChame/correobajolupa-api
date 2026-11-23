import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { dedupeKey } from '../../src/lab/index-message.js';
import { syncMailbox } from '../../src/lab/sync.js';
import { createLogger } from '../../src/logger.js';
import { MailUnavailableError } from '../../src/mail/provider.js';
import {
  ActionNotFoundError,
  DETAIL,
  IncidentNotFoundError,
  IncidentStateError,
  quarantineMessages,
  RESTORE_DETAIL,
  restoreAction,
  type QuarantineDeps,
} from '../../src/quarantine/service.js';
import { FakeServer } from './fake-mail.js';
import { testDatabaseUrl } from './test-db.js';

// Servicio de cuarentena y restauración (M7) contra PostgreSQL real, con un proveedor de correo en
// memoria por buzón (sin Dovecot). Las rutas se prueban aparte.
const db = createDb(testDatabaseUrl());
const LAB = new URL('../fixtures/lab/', import.meta.url);
const INST = ['universidad-ejemplo.example'];
const CRLF = String.fromCharCode(13, 10);

type LabMessage = { id: string; file: string; mailbox: string; messageId: string };
const manifest = JSON.parse(readFileSync(new URL('manifest.json', LAB), 'utf8')) as { messages: LabMessage[] };
const rawOf = (file: string) => readFileSync(new URL(file, LAB));
const fixture = (id: string) => manifest.messages.find((m) => m.id === id)!;

let lines: string[] = [];
let servers: Record<string, FakeServer> = {};

function deps(extra: Partial<QuarantineDeps> = {}): QuarantineDeps {
  const logger = createLogger('info', { write: (l: string) => void lines.push(l) });
  return {
    db,
    logger,
    maxEmlBytes: 10 * 1024 * 1024,
    budgetMs: 20_000,
    openProvider: (address) => servers[address]!.open(),
    ...extra,
  };
}

async function seedAndSync(): Promise<void> {
  servers = {};
  for (const label of ['student', 'teacher', 'staff'] as const) {
    const address = `${label}@lab.example`;
    const server = new FakeServer();
    for (const m of manifest.messages.filter((x) => x.mailbox === address)) server.add(rawOf(m.file));
    servers[address] = server;
    const mailbox = await db.mailbox.findUniqueOrThrow({ where: { label } });
    await syncMailbox({ db, logger: createLogger('silent'), institutionalDomains: INST, maxEmlBytes: 10 * 1024 * 1024, maxMessages: 500, budgetMs: 20_000, openProvider: (a) => servers[a]!.open() }, mailbox.id);
  }
}

const indexed = (id: string) => db.indexedMessage.findFirstOrThrow({ where: { dedupeKey: dedupeKey(fixture(id).messageId)! } });

let actorId = '';
async function incident(status: 'received' | 'analyzing' | 'contained' | 'closed' | 'false_positive' = 'analyzing') {
  return db.incident.create({ data: { title: 'Campaña de prueba', status, createdById: actorId } });
}

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  lines = [];
  await db.$executeRawUnsafe(
    'TRUNCATE quarantine_actions, incident_comments, incident_indicators, incident_reports, incidents, indicators, exclusions, attachments, report_links, findings, reports, audit_events, sessions, users',
  );
  await db.$executeRawUnsafe('TRUNCATE indexed_message_attachments, indexed_message_links, indexed_messages');
  await db.$executeRawUnsafe(`UPDATE mailboxes SET last_sync_at = NULL, last_sync_status = 'never', sync_started_at = NULL`);
  actorId = (await db.user.create({ data: { email: 'analista@ejemplo.invalid', displayName: 'Analista', passwordHash: 'x', role: 'analyst' } })).id;
  await seedAndSync();
  await db.auditEvent.deleteMany();
});

describe('quarantineMessages', () => {
  it('aprobado: mueve de INBOX a Cuarentena con el UID del servidor, actualiza el índice y deja acción done y auditoría', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    const student = servers['student@lab.example']!;

    const [r] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId, requestId: 'req-1' });
    expect(r).toMatchObject({ messageId: a1.id, outcome: 'quarantined', detail: null });
    expect(r!.actionId).toEqual(expect.any(String));

    // En el servidor: ya no está en INBOX y está en Cuarentena.
    const { location, stored } = student.find(fixture('A1').messageId);
    expect(location).toBe('quarantine');
    expect(student.moved).toBe(1);

    const fila = await db.indexedMessage.findUniqueOrThrow({ where: { id: a1.id } });
    expect(fila).toMatchObject({ location: 'quarantine', uid: BigInt(stored.uid), uidValidity: BigInt(student.folders.quarantine.uidValidity) });

    const accion = await db.quarantineAction.findUniqueOrThrow({ where: { id: r!.actionId! } });
    expect(accion).toMatchObject({
      incidentId: inc.id,
      messageId: a1.id,
      mailboxId: a1.mailboxId,
      dedupeKey: a1.dedupeKey,
      type: 'quarantine',
      status: 'done',
      originalLocation: 'inbox',
      originalUid: a1.uid,
      originalUidValidity: a1.uidValidity,
      newLocation: 'quarantine',
      newUid: BigInt(stored.uid),
      newUidValidity: BigInt(student.folders.quarantine.uidValidity),
      failureCode: null,
      actorId,
    });

    const eventos = await db.auditEvent.findMany();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ action: 'quarantine.execute', result: 'success', targetType: 'message', targetId: a1.id, actorId, requestId: 'req-1' });
    expect(eventos[0]!.metadata).toEqual({ incidentId: inc.id, actionId: r!.actionId, outcome: 'quarantined', mailboxId: a1.mailboxId });
  });

  it('repetido (P-13): already_quarantined con la misma acción y sin tocar el IMAP', async () => {
    const inc = await incident('contained');
    const a1 = await indexed('A1');
    const [primera] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    const abiertas = servers['student@lab.example']!.opened;
    const [segunda] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    expect(segunda).toEqual({ messageId: a1.id, outcome: 'already_quarantined', actionId: primera!.actionId, detail: null });
    expect(servers['student@lab.example']!.moved).toBe(1);
    expect(servers['student@lab.example']!.opened).toBe(abiertas);
    expect(await db.quarantineAction.count()).toBe(1);

    // En otro incidente también es already_quarantined, pero sin acción propia (null).
    const otro = await incident();
    const [tercera] = await quarantineMessages(deps(), otro.id, [a1.id], { actorId });
    expect(tercera).toEqual({ messageId: a1.id, outcome: 'already_quarantined', actionId: null, detail: null });
  });

  it('UIDVALIDITY distinto (P-12): no actúa, guarda la acción failed y deja el buzón para resincronizar', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    const student = servers['student@lab.example']!;
    student.resetUidValidity('inbox', 1999999999);

    const [r] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    expect(r).toMatchObject({ outcome: 'uidvalidity_mismatch', detail: DETAIL.uidValidity });
    expect(student.moved).toBe(0);
    expect(student.find(fixture('A1').messageId).location).toBe('inbox');
    expect((await db.indexedMessage.findUniqueOrThrow({ where: { id: a1.id } })).location).toBe('inbox');
    const accion = await db.quarantineAction.findUniqueOrThrow({ where: { id: r!.actionId! } });
    expect(accion).toMatchObject({ status: 'failed', failureCode: 'uidvalidity_mismatch', newLocation: null, attempts: 1 });
    expect((await db.mailbox.findUniqueOrThrow({ where: { id: a1.mailboxId } })).lastSyncStatus).toBe('error');

    // Reintento después de resincronizar: reutiliza la misma fila.
    await syncMailbox({ db, logger: createLogger('silent'), institutionalDomains: INST, maxEmlBytes: 1e7, maxMessages: 500, budgetMs: 20_000, openProvider: (a) => servers[a]!.open() }, a1.mailboxId);
    const a1Nuevo = await indexed('A1');
    expect(a1Nuevo.id).not.toBe(a1.id);
    const [otra] = await quarantineMessages(deps(), inc.id, [a1Nuevo.id], { actorId });
    expect(otra!.outcome).toBe('quarantined');
  });

  it('el UID ahora es otro mensaje, o ya no existe: not_found sin mover', async () => {
    const inc = await incident();
    const [a1, b3] = [await indexed('A1'), await indexed('B3')];
    const student = servers['student@lab.example']!;
    // Mismo UID, otro contenido (otro Message-ID).
    const enA1 = student.find(fixture('A1').messageId).stored;
    enA1.raw = rawOf(fixture('C1').file);
    student.remove(fixture('B3').messageId);

    const r = await quarantineMessages(deps(), inc.id, [a1.id, b3.id], { actorId });
    expect(r.map((x) => x.outcome)).toEqual(['not_found', 'not_found']);
    expect(r.every((x) => x.detail === DETAIL.notOnServer)).toBe(true);
    expect(student.moved).toBe(0);
  });

  it('mensaje sin Message-ID: compara el SHA-256 del crudo antes de mover', async () => {
    const inc = await incident();
    const student = servers['student@lab.example']!;
    const sinId = Buffer.from(['From: Prueba <x@lab.example>', 'To: student@lab.example', 'Subject: Sin identificador', 'Date: Mon, 23 Nov 2026 12:00:00 -0600', '', 'Hola.', ''].join(CRLF));
    student.add(sinId);
    const mailbox = await db.mailbox.findUniqueOrThrow({ where: { label: 'student' } });
    await syncMailbox({ db, logger: createLogger('silent'), institutionalDomains: INST, maxEmlBytes: 1e7, maxMessages: 500, budgetMs: 20_000, openProvider: (a) => servers[a]!.open() }, mailbox.id);
    const fila = await db.indexedMessage.findFirstOrThrow({ where: { dedupeKey: dedupeKey(null, sinId)! } });

    const [r] = await quarantineMessages(deps(), inc.id, [fila.id], { actorId });
    expect(r!.outcome).toBe('quarantined');
    expect(student.folders.quarantine.messages.some((m) => m.raw.equals(sinId))).toBe(true);
  });

  it('corte de conexión a medio lote (P-14): un resultado por mensaje, en orden, y los demás buzones siguen', async () => {
    const inc = await incident();
    const ids = [await indexed('A1'), await indexed('A2'), await indexed('B3'), await indexed('C1')].map((m) => m.id);
    servers['student@lab.example']!.cutAfterMoves = 1;

    const r = await quarantineMessages(deps(), inc.id, ids, { actorId });
    expect(r.map((x) => x.messageId)).toEqual(ids);
    // student: A1 se movió; B3 encontró la conexión cortada; C1 ya no se intentó. teacher (A2) siguió.
    expect(r.map((x) => x.outcome)).toEqual(['quarantined', 'quarantined', 'error', 'error']);
    expect(r[2]!.detail).toBe(DETAIL.unavailable);
    expect(r[3]).toEqual({ messageId: ids[3], outcome: 'error', actionId: null, detail: DETAIL.unavailable });
    expect(await db.quarantineAction.findUniqueOrThrow({ where: { id: r[2]!.actionId! } })).toMatchObject({ status: 'failed', failureCode: 'mail_unavailable' });
    // Ninguno de los no movidos cambió en el índice ni en el servidor.
    expect((await indexed('B3')).location).toBe('inbox');
    expect((await indexed('C1')).location).toBe('inbox');
    expect(servers['student@lab.example']!.find(fixture('C1').messageId).location).toBe('inbox');
    // Cada mensaje quedó auditado.
    const eventos = await db.auditEvent.findMany({ where: { action: 'quarantine.execute' } });
    expect(eventos.map((e) => e.targetId).sort()).toEqual([...ids].sort());
  });

  it('buzón ocupado (sincronización en curso): error "buzón ocupado" sin tocar el IMAP', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    await db.mailbox.update({ where: { id: a1.mailboxId }, data: { syncStartedAt: new Date() } });
    const abiertas = servers['student@lab.example']!.opened;
    const [r] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    expect(r).toEqual({ messageId: a1.id, outcome: 'error', actionId: null, detail: DETAIL.busy });
    expect(servers['student@lab.example']!.opened).toBe(abiertas);
    expect(await db.quarantineAction.count()).toBe(0);
  });

  it('tiempo agotado: los que no alcanzan salen "tiempo agotado; no se movió" y el arriendo se suelta', async () => {
    const inc = await incident();
    const ids = [await indexed('A1'), await indexed('B3'), await indexed('C1')].map((m) => m.id);
    servers['student@lab.example']!.delayMs = 150;
    const r = await quarantineMessages(deps({ budgetMs: 200 }), inc.id, ids, { actorId });
    expect(r.every((x) => x.outcome === 'error')).toBe(true);
    // El primero quedó a medias (movido o no, no se sabe): se dice "no se pudo confirmar".
    expect(r[0]!.detail).toBe(DETAIL.unconfirmed);
    expect(r[1]).toEqual({ messageId: ids[1], outcome: 'error', actionId: null, detail: DETAIL.timeout });
    expect(r[2]).toEqual({ messageId: ids[2], outcome: 'error', actionId: null, detail: DETAIL.timeout });
    expect((await db.mailbox.findFirstOrThrow({ where: { label: 'student' } })).syncStartedAt).toBeNull();
    expect((await indexed('A1')).location).toBe('inbox');
  });

  it('tiempo agotado antes de empezar un buzón: sus mensajes no se intentan', async () => {
    const inc = await incident();
    const ids = [await indexed('A1'), await indexed('A2')].map((m) => m.id);
    servers['student@lab.example']!.delayMs = 120;
    const r = await quarantineMessages(deps({ budgetMs: 100 }), inc.id, ids, { actorId });
    expect(r[1]).toEqual({ messageId: ids[1], outcome: 'error', actionId: null, detail: DETAIL.timeout });
    expect(servers['teacher@lab.example']!.opened).toBe(1); // solo la sincronización inicial
  });

  it('fallo de la base después de mover: error "Movido; resincroniza el buzón" y el buzón queda para resincronizar', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    const student = servers['student@lab.example']!;
    // Justo después del MOVE, alguien cambia la fila: la transacción condicional no la encuentra.
    student.onMove = async () => {
      await db.indexedMessage.update({ where: { id: a1.id }, data: { uid: 4000000000n } });
    };
    const [r] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    expect(r).toEqual({ messageId: a1.id, outcome: 'error', actionId: null, detail: DETAIL.dbAfterMove });
    expect(student.find(fixture('A1').messageId).location).toBe('quarantine');
    expect(await db.quarantineAction.count({ where: { status: 'done' } })).toBe(0);
    expect((await db.mailbox.findUniqueOrThrow({ where: { id: a1.mailboxId } })).lastSyncStatus).toBe('error');
    expect(await db.auditEvent.count({ where: { action: 'quarantine.execute', result: 'failure', targetId: a1.id } })).toBe(1);
    expect(lines.join('\n')).toContain('db_after_move');
  });

  it('sin evidencia del UID nuevo: error "no se pudo confirmar", sin acción done ni índice cambiado', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    servers['student@lab.example']!.moveWithoutEvidence = true;
    const [r] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    expect(r).toMatchObject({ outcome: 'error', detail: DETAIL.unconfirmed });
    expect(await db.quarantineAction.findUniqueOrThrow({ where: { id: r!.actionId! } })).toMatchObject({ status: 'failed', failureCode: 'unconfirmed' });
    expect((await db.indexedMessage.findUniqueOrThrow({ where: { id: a1.id } })).location).toBe('inbox');
  });

  it('mensaje que no está en el índice: not_found; incidente inexistente o en otro estado: error', async () => {
    const inc = await incident();
    const [r] = await quarantineMessages(deps(), inc.id, ['00000000-0000-4000-8000-000000000000'], { actorId });
    expect(r).toEqual({ messageId: '00000000-0000-4000-8000-000000000000', outcome: 'not_found', actionId: null, detail: DETAIL.notIndexed });

    const a1 = await indexed('A1');
    await expect(quarantineMessages(deps(), '00000000-0000-4000-8000-000000000000', [a1.id], { actorId })).rejects.toBeInstanceOf(IncidentNotFoundError);
    for (const status of ['received', 'closed', 'false_positive'] as const) {
      const otro = await incident(status);
      await expect(quarantineMessages(deps(), otro.id, [a1.id], { actorId })).rejects.toBeInstanceOf(IncidentStateError);
    }
    expect(servers['student@lab.example']!.moved).toBe(0);
  });

  it('ningún buzón responde y no se intentó nada: MailUnavailableError (503)', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    servers['student@lab.example']!.failOpen = true;
    await expect(quarantineMessages(deps(), inc.id, [a1.id], { actorId })).rejects.toBeInstanceOf(MailUnavailableError);
    expect((await db.mailbox.findUniqueOrThrow({ where: { id: a1.mailboxId } })).syncStartedAt).toBeNull();
  });

  it('registros sin asuntos, direcciones, Message-ID ni UID', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    const texto = lines.join('\n');
    expect(texto).not.toContain('@lab.example');
    expect(texto.toLowerCase()).not.toContain(fixture('A1').messageId.toLowerCase());
    expect(texto).not.toMatch(/"uid/i);
    expect(texto).not.toContain(a1.subject ?? 'sin-asunto');
  });
});

describe('restoreAction', () => {
  it('restaura con reverificación (P-15), registra la acción restore y repetir da already_restored', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    const student = servers['student@lab.example']!;
    const [q] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    const enCuarentena = await db.indexedMessage.findUniqueOrThrow({ where: { id: a1.id } });

    const r = await restoreAction(deps(), q!.actionId!, { actorId, requestId: 'req-r' });
    expect(r).toMatchObject({ actionId: q!.actionId, outcome: 'restored', detail: null });
    const { location, stored } = student.find(fixture('A1').messageId);
    expect(location).toBe('inbox');

    const restore = await db.quarantineAction.findUniqueOrThrow({ where: { id: r.restoreActionId! } });
    expect(restore).toMatchObject({
      type: 'restore',
      status: 'done',
      originalLocation: 'quarantine',
      originalUid: enCuarentena.uid,
      originalUidValidity: enCuarentena.uidValidity,
      newLocation: 'inbox',
      newUid: BigInt(stored.uid),
      newUidValidity: BigInt(student.folders.inbox.uidValidity),
    });
    expect(await db.indexedMessage.findUniqueOrThrow({ where: { id: a1.id } })).toMatchObject({ location: 'inbox', uid: BigInt(stored.uid) });

    const otra = await restoreAction(deps(), q!.actionId!, { actorId });
    expect(otra).toEqual({ actionId: q!.actionId, outcome: 'already_restored', restoreActionId: r.restoreActionId, detail: null });
    expect(student.moved).toBe(2);

    // Ya restaurado en este incidente: no se vuelve a poner en cuarentena en el mismo incidente.
    const [denuevo] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    expect(denuevo).toMatchObject({ outcome: 'error', detail: DETAIL.restoredBefore });
    expect(student.moved).toBe(2);

    const eventos = await db.auditEvent.findMany({ where: { action: 'quarantine.restore' }, orderBy: { createdAt: 'asc' } });
    expect(eventos.map((e) => (e.metadata as { outcome: string }).outcome)).toEqual(['restored', 'already_restored']);
    expect(Object.keys(eventos[0]!.metadata as object).sort()).toEqual(['actionId', 'incidentId', 'mailboxId', 'outcome']);
  });

  it('se permite con el incidente cerrado', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    const [q] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    await db.incident.update({ where: { id: inc.id }, data: { status: 'closed' } });
    expect((await restoreAction(deps(), q!.actionId!, { actorId })).outcome).toBe('restored');
  });

  it('UIDVALIDITY de Cuarentena distinto o UID con otro mensaje: no mueve', async () => {
    const inc = await incident();
    const [a1, b3] = [await indexed('A1'), await indexed('B3')];
    const student = servers['student@lab.example']!;
    const [q1, q2] = await quarantineMessages(deps(), inc.id, [a1.id, b3.id], { actorId });

    student.find(fixture('B3').messageId).stored.raw = rawOf(fixture('C1').file);
    const r2 = await restoreAction(deps(), q2!.actionId!, { actorId });
    expect(r2).toMatchObject({ outcome: 'not_found', detail: RESTORE_DETAIL.notOnServer });

    student.resetUidValidity('quarantine', 1888888888);
    const r1 = await restoreAction(deps(), q1!.actionId!, { actorId });
    expect(r1).toMatchObject({ outcome: 'uidvalidity_mismatch', detail: RESTORE_DETAIL.uidValidity });
    expect(await db.quarantineAction.findUniqueOrThrow({ where: { id: r1.restoreActionId! } })).toMatchObject({ status: 'failed', failureCode: 'uidvalidity_mismatch' });
    expect(student.moved).toBe(2);
    expect(student.folders.inbox.messages.some((m) => m.raw.equals(rawOf(fixture('A1').file)))).toBe(false);
  });

  it('acción inexistente, de restauración o fallida: ActionNotFoundError', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    await expect(restoreAction(deps(), '00000000-0000-4000-8000-000000000000', { actorId })).rejects.toBeInstanceOf(ActionNotFoundError);
    servers['student@lab.example']!.failMove = true;
    const [fallida] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    await expect(restoreAction(deps(), fallida!.actionId!, { actorId })).rejects.toBeInstanceOf(ActionNotFoundError);
    servers['student@lab.example']!.failMove = false;
    const [q] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    expect(q!.actionId).toBe(fallida!.actionId); // reintento en la misma fila
    const r = await restoreAction(deps(), q!.actionId!, { actorId });
    await expect(restoreAction(deps(), r.restoreActionId!, { actorId })).rejects.toBeInstanceOf(ActionNotFoundError);
  });

  it('buzón ocupado: error sin mover; IMAP sin respuesta: MailUnavailableError', async () => {
    const inc = await incident();
    const a1 = await indexed('A1');
    const [q] = await quarantineMessages(deps(), inc.id, [a1.id], { actorId });
    await db.mailbox.update({ where: { id: a1.mailboxId }, data: { syncStartedAt: new Date() } });
    expect(await restoreAction(deps(), q!.actionId!, { actorId })).toEqual({ actionId: q!.actionId, outcome: 'error', restoreActionId: null, detail: RESTORE_DETAIL.busy });
    await db.mailbox.update({ where: { id: a1.mailboxId }, data: { syncStartedAt: null } });
    servers['student@lab.example']!.failOpen = true;
    await expect(restoreAction(deps(), q!.actionId!, { actorId })).rejects.toBeInstanceOf(MailUnavailableError);
    expect(servers['student@lab.example']!.moved).toBe(1);
  });
});
