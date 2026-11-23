import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { testDatabaseUrl } from './test-db.js';

// Migración del laboratorio (M4): las 3 filas de buzones, restricciones y borrado en cascada.
const db = createDb(testDatabaseUrl());

afterAll(async () => {
  await db.$disconnect();
});

// Los buzones los crea la migración: no se truncan, solo se vacían sus mensajes.
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE indexed_message_attachments, indexed_message_links, indexed_messages');
});

const SHA = 'a'.repeat(64);

async function buzon(label: 'student' | 'teacher' | 'staff') {
  return db.mailbox.findUniqueOrThrow({ where: { label } });
}

function mensaje(mailboxId: string, extra: Partial<{ uid: bigint; uidValidity: bigint; dedupeKey: string }> = {}) {
  return db.indexedMessage.create({
    data: {
      mailboxId,
      dedupeKey: extra.dedupeKey ?? '<m1@lab.example>',
      location: 'inbox',
      uid: extra.uid ?? 1n,
      uidValidity: extra.uidValidity ?? 1795424849n,
      hasAttachments: false,
      linksCount: 0,
      rulesVersion: 'm2-2026.11',
      priority: 'low',
    },
  });
}

describe('migración del laboratorio', () => {
  it('crea los 3 buzones, con estado never por defecto', async () => {
    // Solo etiqueta y dirección: otras pruebas (lab-sync) cambian el estado de sincronización.
    const filas = await db.mailbox.findMany({ orderBy: { address: 'asc' } });
    expect(filas.map((f) => [f.label, f.address])).toEqual([
      ['staff', 'staff@lab.example'],
      ['student', 'student@lab.example'],
      ['teacher', 'teacher@lab.example'],
    ]);
    const [columna] = await db.$queryRaw<{ column_default: string }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'mailboxes' AND column_name = 'last_sync_status'`;
    expect(columna?.column_default).toBe("'never'::sync_status");
  });

  it('un mensaje nuevo trae listas vacías y acepta un UIDVALIDITY de 32 bits sin signo', async () => {
    const { id } = await buzon('student');
    const m = await mensaje(id, { uidValidity: 4294967295n });
    expect(m.replyTo).toEqual([]);
    expect(m.ruleIds).toEqual([]);
    expect(m.uidValidity).toBe(4294967295n);
  });

  it('rechaza claves repetidas en el mismo buzón, pero no en otro', async () => {
    const student = await buzon('student');
    const teacher = await buzon('teacher');
    await mensaje(student.id);
    await expect(mensaje(student.id, { uid: 2n })).rejects.toMatchObject({ code: 'P2002' });
    await expect(mensaje(teacher.id)).resolves.toBeTruthy();
  });

  it('rechaza el mismo UID dos veces en la misma carpeta y UIDVALIDITY', async () => {
    const { id } = await buzon('student');
    await mensaje(id);
    await expect(mensaje(id, { dedupeKey: '<otro@lab.example>' })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('CHECK: uid y uid_validity mayores que 0 y de 32 bits; sha256 hexadecimal de 64', async () => {
    const { id } = await buzon('student');
    await expect(mensaje(id, { uid: 0n })).rejects.toThrow();
    await expect(mensaje(id, { uidValidity: 0n })).rejects.toThrow();
    await expect(mensaje(id, { uidValidity: 4294967296n })).rejects.toThrow();
    const m = await mensaje(id);
    const adjunto = (sha256: string) =>
      db.indexedMessageAttachment.create({ data: { messageId: m.id, position: 0, sizeBytes: 1, sha256, scanStatus: 'unsupported' } });
    await expect(adjunto('Z'.repeat(64))).rejects.toThrow();
    await expect(adjunto('a'.repeat(63))).rejects.toThrow();
    await expect(adjunto(SHA)).resolves.toBeTruthy();
  });

  it('borrar un mensaje borra sus enlaces y adjuntos', async () => {
    const { id } = await buzon('student');
    const m = await mensaje(id);
    await db.indexedMessageLink.create({ data: { messageId: m.id, position: 0, normalizedUrl: 'https://a.example/', defangedUrl: 'hxxps://a[.]example/', domain: 'a.example' } });
    await db.indexedMessageAttachment.create({ data: { messageId: m.id, position: 0, sizeBytes: 1, sha256: SHA, scanStatus: 'unsupported' } });
    await db.indexedMessage.delete({ where: { id: m.id } });
    expect(await db.indexedMessageLink.count()).toBe(0);
    expect(await db.indexedMessageAttachment.count()).toBe(0);
  });
});
