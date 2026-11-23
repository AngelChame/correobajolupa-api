import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { dedupeKey, indexMessage, LAB_SCAN_DETAIL } from '../../src/lab/index-message.js';
import { testDatabaseUrl } from './test-db.js';

// Indexado de un mensaje del laboratorio contra PostgreSQL real (sin IMAP).
const db = createDb(testDatabaseUrl());
const LAB = new URL('../fixtures/lab/', import.meta.url);
const INST = ['universidad-ejemplo.example'];

afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE indexed_message_attachments, indexed_message_links, indexed_messages');
});

async function indexar(file: string, messageId: string, uid = 1) {
  const { id: mailboxId } = await db.mailbox.findUniqueOrThrow({ where: { label: 'teacher' } });
  const raw = readFileSync(new URL(file, LAB));
  const id = await indexMessage(db, { mailboxId, location: 'inbox', uid, uidValidity: 1795424849, dedupeKey: dedupeKey(messageId)!, raw, institutionalDomains: INST });
  return db.indexedMessage.findUniqueOrThrow({ where: { id }, include: { links: true, attachments: true } });
}

describe('indexMessage', () => {
  it('B1: guarda remitente, fecha, reglas y el adjunto como unsupported, sin sus bytes', async () => {
    const m = await indexar('B1-factura.eml', '<b1.factura@lab.example>');
    expect(m).toMatchObject({
      dedupeKey: '<b1.factura@lab.example>',
      location: 'inbox',
      uid: 1n,
      uidValidity: 1795424849n,
      fromAddress: 'facturacion@proveedor-pagos.example',
      replyTo: [],
      hasAttachments: true,
      linksCount: 0,
      ruleIds: ['R7'],
      priority: 'medium',
    });
    expect(m.date?.toISOString()).toBe('2026-11-18T16:02:00.000Z');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({
      position: 0,
      fileName: 'factura-0042.pdf.exe',
      sha256: 'e1ebcaeb1816296896173ffd4d783a7c5b7c9c23d73e610c805d4f9afabdf7db',
      scanStatus: 'unsupported',
      scanDetail: LAB_SCAN_DETAIL,
      scannedAt: null,
    });
    // Ninguna columna guarda el contenido del adjunto.
    expect(JSON.stringify(m, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('NO EJECUTABLE');
  });

  it('A1: guarda Reply-To y los enlaces crudos (URL normalizada y dominio) además del desactivado', async () => {
    const m = await indexar('A1-vence-correo.eml', '<a1.vence-correo@lab.example>');
    expect(m.replyTo).toEqual(['ayuda@buzon-respuestas.example']);
    expect(m.ruleIds).toEqual(['R1', 'R2', 'R3']);
    expect(m.links).toHaveLength(1);
    expect(m.links[0]).toMatchObject({
      position: 0,
      normalizedUrl: 'https://universidad-ejernplo.example/verificar',
      domain: 'universidad-ejernplo.example',
      displayText: 'https://universidad-ejemplo.example/correo',
    });
    expect(m.links[0]!.defangedUrl).not.toMatch(/^https?:\/\//);
    expect(m.linksCount).toBe(1);
  });
});
