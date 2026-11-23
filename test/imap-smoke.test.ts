import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, describe, expect, it } from 'vitest';
import { labImapUser } from '../src/mail/imap.js';

// Prueba de humo contra el Dovecot REAL del laboratorio (D-043). Solo corre con IMAP_LAB_SMOKE=1;
// sin ella se salta y el CI sigue igual. El puerto 143 no se publica al host, así que se corre
// dentro de la red imap-net con: npm run test:imap:docker (ver docker/imap/README.md).
const activa = process.env.IMAP_LAB_SMOKE === '1';
const host = process.env.IMAP_LAB_HOST || 'imap';
const port = Number(process.env.IMAP_LAB_PORT || 143);
const password = process.env.IMAP_LAB_PASSWORD ?? '';

const USUARIOS = ['student@lab.example', 'teacher@lab.example', 'staff@lab.example'];
const CUARENTENA = 'Cuarentena';

/** Cliente sin TLS (red interna) y sin registros: imapflow no escribe comandos ni respuestas. */
function cliente(user: string, pass: string): ImapFlow {
  return new ImapFlow({ host, port, secure: false, doSTARTTLS: false, auth: { user, pass }, logger: false });
}

/** Mensaje pequeño y sintético, con finales CRLF (así se compara byte a byte con lo que devuelve IMAP). */
function mensajeSintetico(messageId: string): Buffer {
  return Buffer.from(
    [
      'From: Prueba de humo <smoke@lab.example>',
      'To: Estudiante <student@lab.example>',
      'Subject: Prueba de humo del laboratorio',
      `Message-ID: ${messageId}`,
      'Date: Mon, 23 Nov 2026 10:00:00 -0600',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Mensaje sintético para probar APPEND, FETCH y MOVE.',
      '',
    ].join('\r\n'),
  );
}

describe.skipIf(!activa)('IMAP del laboratorio real (prueba de humo)', () => {
  const messageId = `<smoke-${randomUUID()}@lab.example>`;

  // La prueba no deja basura: borra el mensaje de INBOX y de Cuarentena aunque algo falle.
  afterAll(async () => {
    const imap = cliente(labImapUser(USUARIOS[0]!), password);
    await imap.connect();
    try {
      for (const carpeta of ['INBOX', CUARENTENA]) {
        const lock = await imap.getMailboxLock(carpeta);
        try {
          const uids = await imap.search({ header: { 'message-id': messageId } }, { uid: true });
          if (uids && uids.length > 0) await imap.messageDelete(uids, { uid: true });
          expect(await imap.search({ header: { 'message-id': messageId } }, { uid: true })).toEqual([]);
        } finally {
          lock.release();
        }
      }
    } finally {
      await imap.logout();
    }
  });

  it('tiene la contraseña del laboratorio', () => {
    expect(password.length, 'define IMAP_LAB_PASSWORD').toBeGreaterThanOrEqual(16);
  });

  it.each(USUARIOS)('%s entra con la contraseña correcta; ve INBOX, y el servicio ve INBOX y Cuarentena suscritas', async (user) => {
    const imap = cliente(user, password);
    await imap.connect();
    try {
      expect(imap.authenticated).toBeTruthy();
      const suscritas = (await imap.list()).filter((m) => m.subscribed).map((m) => m.path);
      expect(suscritas).toContain('INBOX');
      // Cuarentena no se le lista al dueño: la ACL le quita hasta el derecho de verla (nº 2).
      expect(suscritas).not.toContain(CUARENTENA);
    } finally {
      await imap.logout();
    }
    const servicio = cliente(labImapUser(user), password);
    await servicio.connect();
    try {
      const suscritas = (await servicio.list()).filter((m) => m.subscribed).map((m) => m.path);
      expect(suscritas).toEqual(expect.arrayContaining(['INBOX', CUARENTENA]));
    } finally {
      await servicio.logout();
    }
  });

  it('una contraseña incorrecta no entra', async () => {
    const imap = cliente(USUARIOS[0]!, `${password}-incorrecta`);
    await expect(imap.connect()).rejects.toMatchObject({ authenticationFailed: true });
    imap.close();
  });

  it('anuncia UIDPLUS y MOVE después de autenticarse (D-043)', async () => {
    const imap = cliente(USUARIOS[0]!, password);
    await imap.connect();
    try {
      expect(imap.capabilities.has('UIDPLUS')).toBe(true);
      expect(imap.capabilities.has('MOVE')).toBe(true);
    } finally {
      await imap.logout();
    }
  });

  it('APPEND devuelve UID y UIDVALIDITY; se lee igual por UID; UID MOVE lo pasa a Cuarentena (usuario de servicio)', async () => {
    const original = mensajeSintetico(messageId);
    const imap = cliente(labImapUser(USUARIOS[0]!), password);
    await imap.connect();
    try {
      // APPEND con APPENDUID (UIDPLUS): uid y uidValidity vienen en la respuesta.
      const insertado = await imap.append('INBOX', original);
      expect(insertado).toBeTruthy();
      const uid = insertado && insertado.uid;
      const uidValidity = insertado && insertado.uidValidity;
      expect(typeof uid).toBe('number');
      expect(uid).toBeGreaterThan(0);
      expect(uidValidity).toBeTruthy();

      let nuevoUid: number | undefined;
      const lock = await imap.getMailboxLock('INBOX');
      try {
        expect(String(imap.mailbox && imap.mailbox.uidValidity)).toBe(String(uidValidity));

        // Lectura por UID: el contenido coincide byte a byte con lo insertado.
        const leido = await imap.fetchOne(String(uid), { source: true }, { uid: true });
        expect(leido && leido.source && Buffer.compare(leido.source, original)).toBe(0);

        // UID MOVE (RFC 6851): sale de INBOX y el servidor informa el UID en Cuarentena (COPYUID).
        const movido = await imap.messageMove(String(uid), CUARENTENA, { uid: true });
        expect(movido).toBeTruthy();
        nuevoUid = movido ? movido.uidMap?.get(uid as number) : undefined;
        expect(typeof nuevoUid).toBe('number');
        expect(await imap.search({ uid: String(uid) }, { uid: true })).toEqual([]);
      } finally {
        lock.release();
      }

      const lockCuarentena = await imap.getMailboxLock(CUARENTENA);
      try {
        const enCuarentena = await imap.fetchOne(String(nuevoUid), { source: true }, { uid: true });
        expect(enCuarentena && enCuarentena.source && Buffer.compare(enCuarentena.source, original)).toBe(0);
      } finally {
        lockCuarentena.release();
      }
    } finally {
      await imap.logout();
    }
  });
});
