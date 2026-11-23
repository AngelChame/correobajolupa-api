import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openImapProvider } from '../src/mail/imap.js';
import { MailUnavailableError } from '../src/mail/provider.js';
import { loadSeedMessages, seedLab } from '../src/lab/seed.js';

// Prueba de humo del proveedor IMAP (D-007) contra el Dovecot REAL. Solo con IMAP_LAB_SMOKE=1;
// se corre dentro de imap-net con npm run test:imap:docker. Sin base de datos.
const activa = process.env.IMAP_LAB_SMOKE === '1';
const host = process.env.IMAP_LAB_HOST || 'imap';
const port = Number(process.env.IMAP_LAB_PORT || 143);
const password = process.env.IMAP_LAB_PASSWORD ?? '';
const BUZON = 'teacher@lab.example';
const LAB = new URL('./fixtures/lab/', import.meta.url);

describe.skipIf(!activa)('proveedor IMAP contra el laboratorio real (prueba de humo)', () => {
  it('lista INBOX de un buzón sembrado, con UIDVALIDITY estable, y baja el crudo igual al .eml', async () => {
    // Idempotente: si ya estaba sembrado no inserta nada.
    await seedLab({ host, port, password }, host);
    const propios = loadSeedMessages().filter((m) => m.mailbox === BUZON);

    const mail = await openImapProvider({ host, port, user: BUZON, password });
    try {
      const primera = await mail.listFolder('inbox');
      const segunda = await mail.listFolder('inbox');
      expect(primera.uidValidity).toBeGreaterThan(0);
      expect(segunda.uidValidity).toBe(primera.uidValidity);
      expect(segunda.messages).toEqual(primera.messages);
      // Los 7 mensajes del buzón están, cada uno con su Message-ID y un UID válido.
      expect(primera.messages.map((m) => m.messageId).sort()).toEqual(propios.map((m) => m.messageId).sort());
      for (const m of primera.messages) expect(m.uid).toBeGreaterThan(0);

      const objetivo = propios.find((m) => m.id === 'LD2')!;
      const enServidor = primera.messages.find((m) => m.messageId === objetivo.messageId)!;
      const crudo = await mail.fetchRaw('inbox', enServidor.uid, 10 * 1024 * 1024);
      expect(crudo).not.toBeNull();
      expect(Buffer.compare(crudo!, readFileSync(new URL('LD2-personal.eml', LAB)))).toBe(0);
      expect(enServidor.size).toBe(crudo!.length);

      // Sobre el tope, o un UID que no existe: null, sin lanzar.
      expect(await mail.fetchRaw('inbox', enServidor.uid, 10)).toBeNull();
      expect(await mail.fetchRaw('inbox', 4_000_000_000, 10 * 1024 * 1024)).toBeNull();

      // Cuarentena existe (puede estar vacía).
      const cuarentena = await mail.listFolder('quarantine');
      expect(cuarentena.uidValidity).toBeGreaterThan(0);
    } finally {
      await mail.close();
    }
  });

  it('una contraseña incorrecta da MailUnavailableError sin la contraseña en el mensaje', async () => {
    const incorrecta = `${password}-MARCADOR`;
    const error = await openImapProvider({ host, port, user: BUZON, password: incorrecta }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailUnavailableError);
    expect((error as Error).message).not.toContain('MARCADOR');
  });
});
