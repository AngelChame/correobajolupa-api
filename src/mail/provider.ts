/**
 * Interfaz de correo (D-007): esquema neutral para que la sincronización no dependa de IMAP.
 * Listar, bajar e insertar (APPEND, para la entrega simulada); MOVE llega en M7.
 */

/** Carpeta neutral: inbox = INBOX; quarantine = la carpeta de cuarentena del proveedor. */
export type MailLocation = 'inbox' | 'quarantine';

export const MAIL_LOCATIONS: readonly MailLocation[] = ['inbox', 'quarantine'];

export type FolderMessage = {
  /** UID del mensaje en la carpeta (32 bits sin signo, > 0). */
  uid: number;
  /** Message-ID tal como lo anuncia el servidor, o null si el mensaje no trae. */
  messageId: string | null;
  /** Tamaño en bytes según el servidor. */
  size: number;
};

export type FolderListing = {
  /** UIDVALIDITY actual de la carpeta: si cambia, los UID anteriores ya no significan nada (D-008). */
  uidValidity: number;
  messages: FolderMessage[];
};

export type AppendResult = { uid: number; uidValidity: number };

export interface MailProvider {
  /** Lista los mensajes de una carpeta (sin cuerpos). */
  listFolder(location: MailLocation): Promise<FolderListing>;
  /** Baja el mensaje crudo. null si pasa de maxBytes o ya no existe. */
  fetchRaw(location: MailLocation, uid: number, maxBytes: number): Promise<Buffer | null>;
  /**
   * Inserta un mensaje crudo en la carpeta (IMAP APPEND, D-006) con la fecha interna dada y
   * devuelve su UID y el UIDVALIDITY de la carpeta tal como los informa el servidor (UIDPLUS).
   * Si el servidor no los devuelve, falla con MailUnavailableError: nunca se adivina el UID.
   */
  append(location: MailLocation, raw: Buffer, internalDate: Date | null): Promise<AppendResult>;
  close(): Promise<void>;
}

/**
 * El servidor de correo no responde, rechaza el acceso o falló una orden. El mensaje es fijo:
 * nunca lleva contraseñas, direcciones ni contenido de correos.
 */
export class MailUnavailableError extends Error {
  constructor(message = 'el servidor de correo del laboratorio no está disponible') {
    super(message);
    this.name = 'MailUnavailableError';
  }
}
