import { ImapFlow } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { LAB_MAILBOXES, loadSeedMessages, seedLab } from '../src/lab/seed.js';

// Prueba de humo de la siembra contra el Dovecot REAL del laboratorio. Solo con IMAP_LAB_SMOKE=1
// (como test/imap-smoke.test.ts); se corre dentro de imap-net con npm run test:imap:docker.
// Deja los buzones sembrados: es el estado que buscan los pasos siguientes.
const activa = process.env.IMAP_LAB_SMOKE === '1';
const host = process.env.IMAP_LAB_HOST || 'imap';
const port = Number(process.env.IMAP_LAB_PORT || 143);
const password = process.env.IMAP_LAB_PASSWORD ?? '';

/** Cuántas veces está cada Message-ID del buzón, sumando INBOX y Cuarentena. */
async function copias(user: string, messageIds: string[]): Promise<number[]> {
  const imap = new ImapFlow({ host, port, secure: false, doSTARTTLS: false, auth: { user, pass: password }, logger: false });
  await imap.connect();
  try {
    const total = messageIds.map(() => 0);
    for (const folder of ['INBOX', 'Cuarentena']) {
      const lock = await imap.getMailboxLock(folder);
      try {
        for (const [i, id] of messageIds.entries()) {
          const uids = await imap.search({ header: { 'message-id': id } }, { uid: true });
          total[i]! += uids ? uids.length : 0;
        }
      } finally {
        lock.release();
      }
    }
    return total;
  } finally {
    await imap.logout();
  }
}

describe.skipIf(!activa)('siembra del laboratorio real (prueba de humo)', () => {
  it('se niega si el destino no es el host configurado o si falta la contraseña', async () => {
    await expect(seedLab({ host: 'otro-host', port, password }, host)).rejects.toThrow(/IMAP_LAB_HOST/);
    await expect(seedLab({ host, port, password: '' }, host)).rejects.toThrow(/IMAP_LAB_PASSWORD/);
  });

  it('sembrar dos veces deja 7 mensajes por buzón y la segunda vez no inserta nada', async () => {
    const primera = await seedLab({ host, port, password }, host);
    const segunda = await seedLab({ host, port, password }, host);

    const mensajes = loadSeedMessages();
    for (const mailbox of LAB_MAILBOXES) {
      // La primera vez inserta lo que falte (7 en un laboratorio nuevo); la segunda, nada.
      expect(primera[mailbox].inserted + primera[mailbox].skipped, mailbox).toBe(7);
      expect(segunda[mailbox], mailbox).toEqual({ inserted: 0, skipped: 7 });
      // Cada mensaje del buzón está exactamente una vez (en INBOX o, si ya se puso en cuarentena, ahí).
      const ids = mensajes.filter((m) => m.mailbox === mailbox).map((m) => m.messageId);
      expect(ids, mailbox).toHaveLength(7);
      expect(await copias(mailbox, ids), mailbox).toEqual([1, 1, 1, 1, 1, 1, 1]);
    }
  });
});
