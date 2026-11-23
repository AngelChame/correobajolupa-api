import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { labImapUser, LAB_SERVICE_USER } from '../src/mail/imap.js';

// ACL de Cuarentena (M7, decisión nº 2) contra el Dovecot REAL. Solo con IMAP_LAB_SMOKE=1; se corre
// dentro de imap-net con npm run test:imap:docker. El dueño del buzón no puede leer Cuarentena ni
// meter o sacar mensajes de ella; el usuario de servicio de la API sí. INBOX sigue igual.
const activa = process.env.IMAP_LAB_SMOKE === '1';
const host = process.env.IMAP_LAB_HOST || 'imap';
const port = Number(process.env.IMAP_LAB_PORT || 143);
const password = process.env.IMAP_LAB_PASSWORD ?? '';
const BUZON = 'staff@lab.example';
const CRLF = String.fromCharCode(13, 10);

async function entrar(user: string, pass = password): Promise<ImapFlow> {
  const imap = new ImapFlow({ host, port, secure: false, doSTARTTLS: false, auth: { user, pass }, logger: false });
  imap.on('error', () => {});
  await imap.connect();
  return imap;
}

/** true si el servidor deja abrir la carpeta (SELECT o EXAMINE). */
async function puedeAbrir(imap: ImapFlow, carpeta: string, readOnly: boolean): Promise<boolean> {
  try {
    const lock = await imap.getMailboxLock(carpeta, { readOnly });
    lock.release();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!activa)('ACL de Cuarentena en el laboratorio real (prueba de humo)', () => {
  it('el dueño no puede abrir Cuarentena ni mover mensajes a ella; INBOX le sigue funcionando', async () => {
    const dueno = await entrar(BUZON);
    try {
      expect(await puedeAbrir(dueno, 'INBOX', false)).toBe(true);
      expect(await puedeAbrir(dueno, 'Cuarentena', true)).toBe(false);
      expect(await puedeAbrir(dueno, 'Cuarentena', false)).toBe(false);
      // STATUS tampoco le da el contenido.
      await expect(dueno.status('Cuarentena', { messages: true })).rejects.toBeTruthy();
      // APPEND directo a Cuarentena: rechazado.
      const raw = Buffer.from(['From: x@lab.example', `Message-ID: <acl-${randomUUID()}@lab.example>`, 'Subject: ACL', '', 'x', ''].join(CRLF));
      await expect(dueno.append('Cuarentena', raw)).rejects.toBeTruthy();
    } finally {
      await dueno.logout();
    }
  });

  it('el usuario de servicio sí: mete un mensaje en Cuarentena, el dueño no lo ve ni lo saca, y la API lo devuelve', async () => {
    const messageId = `<acl-smoke-${randomUUID()}@lab.example>`;
    const raw = Buffer.from(['From: Prueba <smoke@lab.example>', `To: ${BUZON}`, 'Subject: Prueba de ACL', `Message-ID: ${messageId}`, 'Date: Mon, 23 Nov 2026 12:00:00 -0600', '', 'Mensaje sintético.', ''].join(CRLF));
    const servicio = await entrar(labImapUser(BUZON));
    try {
      const enInbox = await servicio.append('INBOX', raw);
      expect(enInbox && enInbox.uid).toBeTruthy();
      const lock = await servicio.getMailboxLock('INBOX');
      let nuevoUid: number | undefined;
      try {
        const r = await servicio.messageMove(String(enInbox && enInbox.uid), 'Cuarentena', { uid: true });
        nuevoUid = r ? r.uidMap?.get(enInbox && enInbox.uid ? enInbox.uid : 0) : undefined;
      } finally {
        lock.release();
      }
      expect(nuevoUid).toBeGreaterThan(0);

      // El dueño, con su propia sesión, no puede leerlo ni sacarlo.
      const dueno = await entrar(BUZON);
      try {
        expect(await puedeAbrir(dueno, 'Cuarentena', false)).toBe(false);
        const enSuInbox = await dueno.getMailboxLock('INBOX');
        try {
          const uids = await dueno.search({ header: { 'message-id': messageId } }, { uid: true });
          expect(uids).toEqual([]);
        } finally {
          enSuInbox.release();
        }
      } finally {
        await dueno.logout();
      }

      // El servicio lo devuelve a INBOX.
      const q = await servicio.getMailboxLock('Cuarentena');
      try {
        const r = await servicio.messageMove(String(nuevoUid), 'INBOX', { uid: true });
        expect(r && r.uidMap?.get(nuevoUid!)).toBeGreaterThan(0);
      } finally {
        q.release();
      }
    } finally {
      for (const carpeta of ['INBOX', 'Cuarentena']) {
        const lock = await servicio.getMailboxLock(carpeta);
        try {
          const uids = await servicio.search({ header: { 'message-id': messageId } }, { uid: true });
          if (uids && uids.length > 0) await servicio.messageDelete(uids, { uid: true });
        } finally {
          lock.release();
        }
      }
      await servicio.logout();
    }
  });

  it('el usuario de servicio no entra por sí solo ni con otra contraseña', async () => {
    await expect(entrar(LAB_SERVICE_USER)).rejects.toBeTruthy();
    await expect(entrar(labImapUser(BUZON), `${password}-otra`)).rejects.toBeTruthy();
  }, 30_000); // Dovecot espera unos segundos antes de responder a cada intento fallido.
});
