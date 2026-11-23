import { ImapFlow } from 'imapflow';
import { MailUnavailableError, type FolderListing, type FolderMessage, type MailLocation, type MailProvider } from './provider.js';

/** Nombre de cada carpeta neutral en el Dovecot del laboratorio (docker/imap/dovecot.conf). */
const FOLDERS: Record<MailLocation, string> = { inbox: 'INBOX', quarantine: 'Cuarentena' };

export type ImapOptions = {
  host: string;
  port: number;
  /** Dirección del buzón (student@lab.example...). */
  user: string;
  /** IMAP_LAB_PASSWORD. Nunca se registra ni va en un mensaje de error. */
  password: string;
  /** Tiempo máximo para conectar y para cada respuesta del servidor (ms). */
  timeoutMs?: number;
};

/**
 * Abre una conexión IMAP al laboratorio: sin TLS (solo dentro de imap-net, ver docker/imap/README.md)
 * y sin registros de imapflow (escribirían órdenes y respuestas del servidor).
 * Cualquier fallo de conexión o de acceso se convierte en MailUnavailableError.
 */
export async function openImapProvider(options: ImapOptions): Promise<MailProvider> {
  const timeout = options.timeoutMs ?? 15_000;
  const imap = new ImapFlow({
    host: options.host,
    port: options.port,
    secure: false,
    doSTARTTLS: false,
    auth: { user: options.user, pass: options.password },
    logger: false,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  });
  // Sin este oyente, un error de socket en segundo plano tumbaría el proceso.
  imap.on('error', () => {});
  try {
    await imap.connect();
  } catch {
    imap.close();
    throw new MailUnavailableError();
  }
  return new ImapProvider(imap);
}

class ImapProvider implements MailProvider {
  constructor(private readonly imap: ImapFlow) {}

  async listFolder(location: MailLocation): Promise<FolderListing> {
    return this.inFolder(location, async () => {
      const mailbox = this.imap.mailbox;
      if (!mailbox) throw new MailUnavailableError();
      const messages: FolderMessage[] = [];
      if (mailbox.exists > 0) {
        for await (const m of this.imap.fetch('1:*', { uid: true, envelope: true, size: true })) {
          messages.push({ uid: m.uid, messageId: m.envelope?.messageId?.trim() || null, size: m.size ?? 0 });
        }
      }
      return { uidValidity: Number(mailbox.uidValidity), messages };
    });
  }

  async fetchRaw(location: MailLocation, uid: number, maxBytes: number): Promise<Buffer | null> {
    return this.inFolder(location, async () => {
      // Primero el tamaño: un mensaje que pasa del tope no se baja.
      const meta = await this.imap.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
      if (!meta || meta.size === undefined || meta.size > maxBytes) return null;
      const full = await this.imap.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!full || !full.source || full.source.length > maxBytes) return null;
      return full.source;
    });
  }

  async close(): Promise<void> {
    try {
      await this.imap.logout();
    } catch {
      this.imap.close();
    }
  }

  /** Abre la carpeta en solo lectura y traduce cualquier fallo del servidor a MailUnavailableError. */
  private async inFolder<T>(location: MailLocation, fn: () => Promise<T>): Promise<T> {
    let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>;
    try {
      lock = await this.imap.getMailboxLock(FOLDERS[location], { readOnly: true });
    } catch {
      throw new MailUnavailableError();
    }
    try {
      return await fn();
    } catch (error) {
      if (error instanceof MailUnavailableError) throw error;
      throw new MailUnavailableError();
    } finally {
      lock.release();
    }
  }
}
