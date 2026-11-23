import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { testDatabaseUrl } from './test-db.js';

// Migración de M7: acciones de cuarentena y restauración (única, CHECK y sin clave foránea al índice).
const db = createDb(testDatabaseUrl());

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE quarantine_actions, incident_comments, incident_indicators, incident_reports, incidents, indicators, exclusions, attachments, report_links, findings, reports, audit_events, sessions, users',
  );
  await db.$executeRawUnsafe('TRUNCATE indexed_message_attachments, indexed_message_links, indexed_messages');
});

async function base() {
  const u = await db.user.create({ data: { email: 'analista@ejemplo.invalid', displayName: 'Persona', passwordHash: 'x', role: 'analyst' } });
  const i = await db.incident.create({ data: { title: 'Campaña', createdById: u.id, status: 'analyzing' } });
  const m = await db.mailbox.findUniqueOrThrow({ where: { label: 'student' } });
  return { u, i, m };
}

const MSG = '11111111-1111-4111-8111-111111111111';

function accion(ids: { u: { id: string }; i: { id: string }; m: { id: string } }, extra: Record<string, unknown> = {}) {
  return {
    incidentId: ids.i.id,
    messageId: MSG,
    mailboxId: ids.m.id,
    dedupeKey: '<a1@lab.example>',
    type: 'quarantine' as const,
    status: 'done' as const,
    originalLocation: 'inbox' as const,
    originalUid: 7n,
    originalUidValidity: 1795424849n,
    newLocation: 'quarantine' as const,
    newUid: 1n,
    newUidValidity: 1795424850n,
    actorId: ids.u.id,
    ...extra,
  };
}

describe('migración de cuarentena', () => {
  it('una acción hecha se guarda con su ubicación original y nueva; única por (incidente, mensaje, tipo)', async () => {
    const ids = await base();
    const a = await db.quarantineAction.create({ data: accion(ids) });
    expect(a).toMatchObject({ status: 'done', newUid: 1n, attempts: 1, failureCode: null });
    await expect(db.quarantineAction.create({ data: accion(ids) })).rejects.toMatchObject({ code: 'P2002' });
    // Otro tipo para el mismo mensaje sí (la restauración).
    await expect(
      db.quarantineAction.create({
        data: accion(ids, { type: 'restore', originalLocation: 'quarantine', originalUid: 1n, originalUidValidity: 1795424850n, newLocation: 'inbox', newUid: 8n, newUidValidity: 1795424849n }),
      }),
    ).resolves.toBeTruthy();
  });

  it('CHECK: UID y UIDVALIDITY de 1 a 4294967295', async () => {
    const ids = await base();
    for (const malo of [{ originalUid: 0n }, { originalUid: 4294967296n }, { originalUidValidity: 0n }, { newUid: 0n }, { newUidValidity: 4294967296n }]) {
      await expect(db.quarantineAction.create({ data: accion(ids, malo) }), JSON.stringify(malo, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).rejects.toThrow();
    }
    await expect(db.quarantineAction.create({ data: accion(ids, { originalUid: 4294967295n, newUid: 4294967295n }) })).resolves.toBeTruthy();
  });

  it('CHECK: done exige ubicación nueva completa y sin código; failed, código y sin ubicación nueva; dirección según el tipo', async () => {
    const ids = await base();
    const sinNueva = { newLocation: null, newUid: null, newUidValidity: null };
    await expect(db.quarantineAction.create({ data: accion(ids, sinNueva) })).rejects.toThrow();
    await expect(db.quarantineAction.create({ data: accion(ids, { newUid: null }) })).rejects.toThrow();
    await expect(db.quarantineAction.create({ data: accion(ids, { failureCode: 'x' }) })).rejects.toThrow();
    await expect(db.quarantineAction.create({ data: accion(ids, { status: 'failed', failureCode: 'x' }) })).rejects.toThrow();
    await expect(db.quarantineAction.create({ data: accion(ids, { status: 'failed', ...sinNueva }) })).rejects.toThrow();
    // Cuarentena que "sale" de Cuarentena, o que llega a INBOX: no.
    await expect(db.quarantineAction.create({ data: accion(ids, { originalLocation: 'quarantine' }) })).rejects.toThrow();
    await expect(db.quarantineAction.create({ data: accion(ids, { newLocation: 'inbox' }) })).rejects.toThrow();
    await expect(db.quarantineAction.create({ data: accion(ids, { attempts: 0 }) })).rejects.toThrow();
    await expect(db.quarantineAction.create({ data: accion(ids, { status: 'failed', failureCode: 'uidvalidity_mismatch', ...sinNueva }) })).resolves.toBeTruthy();
  });

  it('sin clave foránea al índice: la sincronización puede borrar el mensaje y la acción se conserva', async () => {
    const ids = await base();
    const msg = await db.indexedMessage.create({
      data: { mailboxId: ids.m.id, dedupeKey: '<a1@lab.example>', location: 'quarantine', uid: 1n, uidValidity: 1795424850n, hasAttachments: false, linksCount: 0, rulesVersion: 'm1', priority: 'low' },
    });
    const a = await db.quarantineAction.create({ data: accion(ids, { messageId: msg.id }) });
    await db.indexedMessage.delete({ where: { id: msg.id } });
    expect(await db.quarantineAction.findUnique({ where: { id: a.id } })).not.toBeNull();
  });

  it('Restrict: no se borra el incidente ni la cuenta que tienen acciones', async () => {
    const ids = await base();
    await db.quarantineAction.create({ data: accion(ids) });
    await expect(db.incident.delete({ where: { id: ids.i.id } })).rejects.toThrow();
    await expect(db.user.delete({ where: { id: ids.u.id } })).rejects.toThrow();
  });
});
