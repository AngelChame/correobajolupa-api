/**
 * Interfaz de correo (D-007): esquema neutral para que la sincronización no dependa de IMAP.
 * Hoy solo lo que necesita sincronizar (listar y bajar); APPEND y MOVE llegan en el paso 4 y en M7.
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

export interface MailProvider {
  /** Lista los mensajes de una carpeta (sin cuerpos). */
  listFolder(location: MailLocation): Promise<FolderListing>;
  /** Baja el mensaje crudo. null si pasa de maxBytes o ya no existe. */
  fetchRaw(location: MailLocation, uid: number, maxBytes: number): Promise<Buffer | null>;
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
