import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ImapFlow } from 'imapflow';
import { z } from 'zod';
import { loadImapLabConfig } from '../config.js';

/**
 * Siembra de los buzones del laboratorio IMAP (M4): copia los mensajes sintéticos de
 * test/fixtures/lab a INBOX con APPEND, usando la fecha del encabezado Date como fecha interna.
 *
 * Idempotente: antes de insertar busca el Message-ID en INBOX y en Cuarentena; si ya está, lo salta.
 * Solo imprime conteos por buzón. Nunca imprime la contraseña ni el contenido de los mensajes.
 * Se corre dentro de Docker (el 143 no se publica): npm run lab:seed.
 */

export const LAB_MAILBOXES = ['student@lab.example', 'teacher@lab.example', 'staff@lab.example'] as const;
type Mailbox = (typeof LAB_MAILBOXES)[number];

/** Carpetas donde puede estar un mensaje ya sembrado (la cuarentena lo mueve, no lo borra). */
const FOLDERS = ['INBOX', 'Cuarentena'] as const;

export const DEFAULT_LAB_DIR = new URL('../../test/fixtures/lab/', import.meta.url);

/** Lo único que la siembra necesita del manifiesto. Nombres de archivo planos: nunca una ruta. */
const SeedManifest = z.looseObject({
  messages: z
    .array(
      z.looseObject({
        id: z.string().min(1),
        file: z.string().regex(/^[A-Za-z0-9-]+\.eml$/),
        mailbox: z.enum(LAB_MAILBOXES),
        messageId: z.string().regex(/^<[^<>\s]+@lab\.example>$/),
      }),
    )
    .min(1),
});

type SeedMessage = { id: string; mailbox: Mailbox; messageId: string; bytes: Buffer; date: Date };

export type SeedTarget = { host: string; port: number; password: string };
export type SeedCounts = Record<Mailbox, { inserted: number; skipped: number }>;

/** Lee y valida el manifiesto y todos los .eml antes de conectarse a nada. */
export function loadSeedMessages(dir: URL = DEFAULT_LAB_DIR): SeedMessage[] {
  const manifest = SeedManifest.parse(JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')));
  const vistos = new Set<string>();
  return manifest.messages.map((m) => {
    if (vistos.has(m.messageId)) throw new Error(`Message-ID repetido en el manifiesto (${m.id})`);
    vistos.add(m.messageId);
    let bytes: Buffer;
    try {
      bytes = readFileSync(new URL(m.file, dir));
    } catch {
      throw new Error(`no existe el archivo del mensaje ${m.id}`);
    }
    const headers = bytes.subarray(0, Math.max(0, bytes.indexOf('\r\n\r\n'))).toString('utf8');
    const messageId = /^Message-ID:\s*(\S+)\s*$/im.exec(headers)?.[1];
    if (messageId !== m.messageId) throw new Error(`el Message-ID del archivo no coincide con el manifiesto (${m.id})`);
    const date = new Date(/^Date:\s*(.+?)\s*$/im.exec(headers)?.[1] ?? '');
    if (Number.isNaN(date.getTime())) throw new Error(`el mensaje ${m.id} no tiene una fecha válida`);
    return { id: m.id, mailbox: m.mailbox, messageId: m.messageId, bytes, date };
  });
}

/**
 * Siembra los tres buzones. Se niega si el destino no es el host del laboratorio configurado
 * (IMAP_LAB_HOST) o si falta la contraseña.
 */
export async function seedLab(target: SeedTarget, expectedHost: string, dir: URL = DEFAULT_LAB_DIR): Promise<SeedCounts> {
  if (target.host !== expectedHost) throw new Error('el destino no es el IMAP del laboratorio configurado (IMAP_LAB_HOST)');
  if (!target.password) throw new Error('falta IMAP_LAB_PASSWORD');

  const messages = loadSeedMessages(dir);
  const counts = Object.fromEntries(LAB_MAILBOXES.map((m) => [m, { inserted: 0, skipped: 0 }])) as SeedCounts;

  for (const mailbox of LAB_MAILBOXES) {
    const own = messages.filter((m) => m.mailbox === mailbox);
    if (own.length === 0) continue;
    const imap = new ImapFlow({
      host: target.host,
      port: target.port,
      secure: false,
      doSTARTTLS: false,
      auth: { user: mailbox, pass: target.password },
      // Sin registros de imapflow: escribirían comandos y respuestas del servidor.
      logger: false,
    });
    try {
      await imap.connect();
    } catch {
      throw new Error(`no se pudo entrar al buzón ${mailbox}`);
    }
    try {
      for (const m of own) {
        if (await alreadyThere(imap, m.messageId)) {
          counts[mailbox].skipped++;
          continue;
        }
        const result = await imap.append('INBOX', m.bytes, [], m.date);
        if (!result) throw new Error(`el servidor no aceptó el mensaje ${m.id}`);
        counts[mailbox].inserted++;
      }
    } finally {
      await imap.logout();
    }
  }
  return counts;
}

async function alreadyThere(imap: ImapFlow, messageId: string): Promise<boolean> {
  for (const folder of FOLDERS) {
    const lock = await imap.getMailboxLock(folder);
    try {
      const uids = await imap.search({ header: { 'message-id': messageId } }, { uid: true });
      if (uids && uids.length > 0) return true;
    } finally {
      lock.release();
    }
  }
  return false;
}

async function main(): Promise<void> {
  const config = loadImapLabConfig();
  if (!config.IMAP_LAB_PASSWORD) throw new Error('falta IMAP_LAB_PASSWORD');
  const counts = await seedLab(
    { host: config.IMAP_LAB_HOST, port: config.IMAP_LAB_PORT, password: config.IMAP_LAB_PASSWORD },
    config.IMAP_LAB_HOST,
  );
  for (const [mailbox, c] of Object.entries(counts)) {
    console.log(`${mailbox}: insertados ${c.inserted}, saltados ${c.skipped}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Los mensajes de error de este archivo y de loadImapLabConfig nunca incluyen valores.
    console.error(`siembra: ${error instanceof Error ? error.message : 'error desconocido'}`);
    process.exitCode = 1;
  });
}
