import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { dedupeKey } from '../../src/lab/index-message.js';
import { MailboxNotFoundError, MailUnavailableError, SyncInProgressError, SyncTimeoutError, syncMailbox, type SyncDeps } from '../../src/lab/sync.js';
import { createLogger } from '../../src/logger.js';
import type { FolderListing, MailLocation, MailProvider } from '../../src/mail/provider.js';
import { testDatabaseUrl } from './test-db.js';

// Sincronización de un buzón del laboratorio contra PostgreSQL real, con un proveedor de correo
// en memoria que simula INBOX y Cuarentena (sin Dovecot).
const db = createDb(testDatabaseUrl());
const LAB = new URL('../fixtures/lab/', import.meta.url);
const INST = ['universidad-ejemplo.example'];

type LabMessage = { id: string; file: string; mailbox: string; messageId: string; expectedRules: string[] };
const manifest = JSON.parse(readFileSync(new URL('manifest.json', LAB), 'utf8')) as { messages: LabMessage[] };
const rawOf = (file: string) => readFileSync(new URL(file, LAB));

// ---- Proveedor falso ----

type Stored = { uid: number; raw: Buffer };
type Folder = { uidValidity: number; nextUid: number; messages: Stored[] };

const messageIdOf = (raw: Buffer) => /^Message-ID:\s*(\S+)\s*$/im.exec(raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('utf8'))?.[1] ?? null;

class FakeServer {
  folders: Record<MailLocation, Folder> = {
    inbox: { uidValidity: 1795424849, nextUid: 1, messages: [] },
    quarantine: { uidValidity: 1795424850, nextUid: 1, messages: [] },
  };
  delayMs = 0;
  failOpen = false;
  failList = false;
  opened = 0;

  add(raw: Buffer, location: MailLocation = 'inbox'): number {
    const f = this.folders[location];
    const uid = f.nextUid++;
    f.messages.push({ uid, raw });
    return uid;
  }
  find(messageId: string): { location: MailLocation; stored: Stored } {
    for (const location of ['inbox', 'quarantine'] as const) {
      const stored = this.folders[location].messages.find((m) => messageIdOf(m.raw) === messageId);
      if (stored) return { location, stored };
    }
    throw new Error('no está');
  }
  /** Como UID MOVE: sale de su carpeta y entra a la otra con un UID nuevo. */
  move(messageId: string, to: MailLocation): number {
    const { location, stored } = this.find(messageId);
    this.folders[location].messages = this.folders[location].messages.filter((m) => m !== stored);
    return this.add(stored.raw, to);
  }
  remove(messageId: string): void {
    const { location, stored } = this.find(messageId);
    this.folders[location].messages = this.folders[location].messages.filter((m) => m !== stored);
  }
  /** Nuevo UIDVALIDITY: el servidor renumera todos los UID de la carpeta. */
  resetUidValidity(location: MailLocation, uidValidity: number): void {
    const f = this.folders[location];
    f.uidValidity = uidValidity;
    f.nextUid = 1000;
    f.messages = f.messages.map((m) => ({ uid: f.nextUid++, raw: m.raw }));
  }
  provider(): MailProvider {
    const server = this;
    const wait = () => new Promise((r) => setTimeout(r, server.delayMs));
    return {
      async listFolder(location): Promise<FolderListing> {
        if (server.failList) throw new MailUnavailableError();
        const f = server.folders[location];
        return { uidValidity: f.uidValidity, messages: f.messages.map((m) => ({ uid: m.uid, messageId: messageIdOf(m.raw), size: m.raw.length })) };
      },
      async fetchRaw(location, uid, maxBytes) {
        await wait();
        const m = server.folders[location].messages.find((x) => x.uid === uid);
        return m && m.raw.length <= maxBytes ? Buffer.from(m.raw) : null;
      },
      async close() {},
    };
  }
}

// ---- Utilidades ----

let lines: string[] = [];
function deps(server: FakeServer, extra: Partial<SyncDeps> = {}): SyncDeps {
  const logger = createLogger('info', { write: (l: string) => void lines.push(l) });
  return {
    db,
    logger,
    institutionalDomains: INST,
    maxEmlBytes: 10 * 1024 * 1024,
    maxMessages: 500,
    budgetMs: 20_000,
    openProvider: async () => {
      if (server.failOpen) throw new MailUnavailableError();
      server.opened++;
      return server.provider();
    },
    ...extra,
  };
}

const mailboxId = async (label: 'student' | 'teacher' | 'staff') => (await db.mailbox.findUniqueOrThrow({ where: { label } })).id;

function seeded(address: string): FakeServer {
  const server = new FakeServer();
  for (const m of manifest.messages.filter((x) => x.mailbox === address)) server.add(rawOf(m.file));
  return server;
}

const rows = (id: string) => db.indexedMessage.findMany({ where: { mailboxId: id }, orderBy: { dedupeKey: 'asc' } });

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  lines = [];
  await db.$executeRawUnsafe('TRUNCATE indexed_message_attachments, indexed_message_links, indexed_messages, audit_events');
  await db.$executeRawUnsafe(`UPDATE mailboxes SET last_sync_at = NULL, last_sync_status = 'never', sync_started_at = NULL`);
});

// ---- Pruebas ----

describe('syncMailbox', () => {
  it('primera sincronización: indexa los 21 mensajes (7 por buzón) con las reglas del manifiesto; la segunda no cambia nada', async () => {
    for (const label of ['student', 'teacher', 'staff'] as const) {
      const id = await mailboxId(label);
      const server = seeded(`${label}@lab.example`);
      const primera = await syncMailbox(deps(server), id, { requestId: 'req-prueba' });
      expect(primera).toMatchObject({ mailboxId: id, fetched: 7, added: 7, updated: 0, uidValidityChanged: false });
      expect(primera.finishedAt).toBeInstanceOf(Date);
      const segunda = await syncMailbox(deps(server), id);
      expect(segunda).toMatchObject({ fetched: 0, added: 0, updated: 0, uidValidityChanged: false });
    }
    expect(await db.indexedMessage.count()).toBe(21);

    for (const m of manifest.messages) {
      const row = await db.indexedMessage.findFirstOrThrow({ where: { dedupeKey: dedupeKey(m.messageId)! }, include: { mailbox: true } });
      expect(row.mailbox.address, m.id).toBe(m.mailbox);
      expect(row.ruleIds, m.id).toEqual(m.expectedRules);
      expect(row.location, m.id).toBe('inbox');
    }

    const buzones = await db.mailbox.findMany();
    for (const b of buzones) {
      expect(b.lastSyncStatus).toBe('ok');
      expect(b.lastSyncAt).not.toBeNull();
      expect(b.syncStartedAt).toBeNull();
    }
    const auditoria = await db.auditEvent.findMany({ where: { action: 'mailbox.sync' }, orderBy: { createdAt: 'asc' } });
    expect(auditoria).toHaveLength(6);
    expect(auditoria[0]).toMatchObject({ result: 'success', targetType: 'mailbox', requestId: 'req-prueba', actorId: null });
    expect(auditoria[0]!.metadata).toMatchObject({ fetched: 7, added: 7, updated: 0, deleted: 0, uidValidityChanged: false });
  });

  it('un mensaje movido a Cuarentena actualiza la misma fila (location y UID nuevos) y cuenta updated', async () => {
    const id = await mailboxId('teacher');
    const server = seeded('teacher@lab.example');
    await syncMailbox(deps(server), id);
    const key = dedupeKey('<b1.factura@lab.example>')!;
    const antes = await db.indexedMessage.findUniqueOrThrow({ where: { mailboxId_dedupeKey: { mailboxId: id, dedupeKey: key } } });

    const nuevoUid = server.move('<b1.factura@lab.example>', 'quarantine');
    const r = await syncMailbox(deps(server), id);
    expect(r).toMatchObject({ fetched: 0, added: 0, updated: 1, uidValidityChanged: false });

    const despues = await db.indexedMessage.findUniqueOrThrow({ where: { mailboxId_dedupeKey: { mailboxId: id, dedupeKey: key } } });
    expect(despues.id).toBe(antes.id);
    expect(despues.location).toBe('quarantine');
    expect(despues.uid).toBe(BigInt(nuevoUid));
    expect(despues.uidValidity).toBe(1795424850n);
    expect(await db.indexedMessage.count({ where: { mailboxId: id } })).toBe(7);
  });

  it('UIDVALIDITY distinto: uidValidityChanged, borra las filas viejas de la carpeta y reindexa sin duplicar', async () => {
    const id = await mailboxId('staff');
    const server = seeded('staff@lab.example');
    await syncMailbox(deps(server), id);

    server.resetUidValidity('inbox', 1900000000);
    const r = await syncMailbox(deps(server), id);
    expect(r).toMatchObject({ uidValidityChanged: true, added: 7, fetched: 7, updated: 0 });
    const filas = await rows(id);
    expect(filas).toHaveLength(7);
    for (const f of filas) {
      expect(f.uidValidity).toBe(1900000000n);
      expect(f.uid).toBeGreaterThanOrEqual(1000n);
    }
    // Y una tercera corrida ya no ve cambio.
    expect(await syncMailbox(deps(server), id)).toMatchObject({ uidValidityChanged: false, added: 0, updated: 0 });
  });

  it('un mensaje borrado del servidor sale del índice', async () => {
    const id = await mailboxId('student');
    const server = seeded('student@lab.example');
    await syncMailbox(deps(server), id);
    server.remove('<ld1.personal@lab.example>');
    await syncMailbox(deps(server), id);
    const filas = await rows(id);
    expect(filas).toHaveLength(6);
    expect(filas.map((f) => f.dedupeKey)).not.toContain('<ld1.personal@lab.example>');
    const ultima = await db.auditEvent.findFirstOrThrow({ where: { action: 'mailbox.sync' }, orderBy: { createdAt: 'desc' } });
    expect(ultima.metadata).toMatchObject({ deleted: 1 });
  });

  it('sin Message-ID usa sha256: y no se duplica en una segunda corrida', async () => {
    const id = await mailboxId('student');
    const server = new FakeServer();
    server.add(Buffer.from('From: Sin ID <alguien@correo-personal.example>\r\nTo: student@lab.example\r\nSubject: Sin identificador\r\nDate: Sun, 22 Nov 2026 10:00:00 -0600\r\n\r\nHola.\r\n'));
    const primera = await syncMailbox(deps(server), id);
    expect(primera).toMatchObject({ fetched: 1, added: 1 });
    const segunda = await syncMailbox(deps(server), id);
    // Hay que bajarlo de nuevo para calcular su clave, pero no se agrega otra vez.
    expect(segunda).toMatchObject({ fetched: 1, added: 0, updated: 0 });
    const filas = await rows(id);
    expect(filas).toHaveLength(1);
    expect(filas[0]!.dedupeKey).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('un .eml sobre el tope no se indexa y no rompe el resto', async () => {
    const id = await mailboxId('teacher');
    const server = seeded('teacher@lab.example');
    const grande = Buffer.concat([
      Buffer.from('From: x@correo-personal.example\r\nMessage-ID: <grande@lab.example>\r\nDate: Sun, 22 Nov 2026 10:00:00 -0600\r\n\r\n'),
      Buffer.alloc(8 * 1024, 'a'),
    ]);
    server.add(grande);
    const r = await syncMailbox(deps(server, { maxEmlBytes: 4 * 1024 }), id);
    expect(r).toMatchObject({ added: 7, fetched: 7 });
    expect((await rows(id)).map((f) => f.dedupeKey)).not.toContain('<grande@lab.example>');
    const ultima = await db.auditEvent.findFirstOrThrow({ where: { action: 'mailbox.sync' }, orderBy: { createdAt: 'desc' } });
    expect(ultima.metadata).toMatchObject({ tooLarge: 1 });
  });

  it('SYNC_MAX_MESSAGES: lo que pasa del tope se ignora y se cuenta', async () => {
    const id = await mailboxId('teacher');
    const server = seeded('teacher@lab.example');
    const r = await syncMailbox(deps(server, { maxMessages: 5 }), id);
    expect(r.added).toBe(5);
    const ultima = await db.auditEvent.findFirstOrThrow({ where: { action: 'mailbox.sync' }, orderBy: { createdAt: 'desc' } });
    expect(ultima.metadata).toMatchObject({ ignored: 2, deleted: 0 });
    // Con el tope completo llegan los otros 2, sin borrar ni duplicar los 5.
    expect(await syncMailbox(deps(server), id)).toMatchObject({ added: 2 });
    expect(await rows(id)).toHaveLength(7);
  });

  it('una segunda sincronización mientras la primera corre → SyncInProgressError; un arriendo vencido se retoma', async () => {
    const id = await mailboxId('student');
    const server = seeded('student@lab.example');
    server.delayMs = 60;
    const primera = syncMailbox(deps(server), id);
    // Espera a que la primera tome el arriendo.
    for (let i = 0; i < 100 && server.opened === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await expect(syncMailbox(deps(server), id)).rejects.toBeInstanceOf(SyncInProgressError);
    await expect(primera).resolves.toMatchObject({ added: 7 });
    expect((await db.mailbox.findUniqueOrThrow({ where: { id } })).syncStartedAt).toBeNull();

    // Un proceso que murió dejó el arriendo tomado hace 2 minutos: se puede retomar.
    await db.$executeRaw`UPDATE mailboxes SET sync_started_at = now() - interval '2 minutes' WHERE id = ${id}::uuid`;
    server.delayMs = 0;
    await expect(syncMailbox(deps(server), id)).resolves.toMatchObject({ added: 0 });
    // Uno reciente, no.
    await db.$executeRaw`UPDATE mailboxes SET sync_started_at = now() WHERE id = ${id}::uuid`;
    await expect(syncMailbox(deps(server), id)).rejects.toBeInstanceOf(SyncInProgressError);
  });

  it('proveedor que falla → MailUnavailableError, estado error y last_sync_at sin cambiar', async () => {
    const id = await mailboxId('staff');
    const server = seeded('staff@lab.example');
    await syncMailbox(deps(server), id);
    const antes = await db.mailbox.findUniqueOrThrow({ where: { id } });

    server.failOpen = true;
    await expect(syncMailbox(deps(server), id)).rejects.toBeInstanceOf(MailUnavailableError);
    let b = await db.mailbox.findUniqueOrThrow({ where: { id } });
    expect(b.lastSyncStatus).toBe('error');
    expect(b.lastSyncAt).toEqual(antes.lastSyncAt);
    expect(b.syncStartedAt).toBeNull();

    server.failOpen = false;
    server.failList = true;
    await expect(syncMailbox(deps(server), id)).rejects.toBeInstanceOf(MailUnavailableError);
    b = await db.mailbox.findUniqueOrThrow({ where: { id } });
    expect(b.lastSyncStatus).toBe('error');
    // El índice no se tocó.
    expect(await rows(id)).toHaveLength(7);
    const fallo = await db.auditEvent.findFirstOrThrow({ where: { action: 'mailbox.sync', result: 'failure' } });
    expect(fallo.metadata).toMatchObject({ reason: 'mail_unavailable' });
  });

  it('presupuesto agotado → SyncTimeoutError, estado error y se conserva lo ya indexado', async () => {
    const id = await mailboxId('teacher');
    const server = seeded('teacher@lab.example');
    server.delayMs = 150;
    await expect(syncMailbox(deps(server, { budgetMs: 500 }), id)).rejects.toBeInstanceOf(SyncTimeoutError);
    const indexados = await db.indexedMessage.count({ where: { mailboxId: id } });
    expect(indexados).toBeGreaterThan(0);
    expect(indexados).toBeLessThan(7);
    const b = await db.mailbox.findUniqueOrThrow({ where: { id } });
    expect(b.lastSyncStatus).toBe('error');
    expect(b.syncStartedAt).toBeNull();

    // La siguiente corrida completa termina el trabajo sin duplicar.
    server.delayMs = 0;
    const r = await syncMailbox(deps(server), id);
    expect(r.added).toBe(7 - indexados);
    expect(await rows(id)).toHaveLength(7);
  });

  it('un buzón que no existe → MailboxNotFoundError', async () => {
    await expect(syncMailbox(deps(new FakeServer()), '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(MailboxNotFoundError);
  });

  it('P-18: los registros solo llevan mailboxId, conteos y tiempos (sin asuntos, direcciones ni Message-ID)', async () => {
    const id = await mailboxId('student');
    const server = seeded('student@lab.example');
    await syncMailbox(deps(server), id);
    server.failOpen = true;
    await syncMailbox(deps(server), id).catch(() => {});

    expect(lines.length).toBeGreaterThan(0);
    const todo = lines.join('\n');
    expect(todo).toContain(id);
    expect(todo).not.toContain('@');
    for (const m of manifest.messages.filter((x) => x.mailbox === 'student@lab.example')) {
      const subject = /^Subject:\s*(.+)$/im.exec(rawOf(m.file).toString('utf8'))?.[1]?.trim();
      if (subject) expect(todo).not.toContain(subject);
      expect(todo).not.toContain(m.messageId.slice(1, -1));
    }
    for (const texto of ['universidad', 'nube-compartida', 'factura', 'beca', 'nomina', 'xn--']) expect(todo.toLowerCase()).not.toContain(texto);
  });
});
