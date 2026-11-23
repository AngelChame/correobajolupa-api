/**
 * Interfaz de correo (D-007): esquema neutral para que la sincronización no dependa de IMAP.
 * Listar, bajar, insertar (APPEND, para la entrega simulada), revisar un UID y mover (M7).
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

/** Dónde quedó un mensaje movido, tal como lo informa el servidor (COPYUID de UIDPLUS). */
export type MoveResult = { uid: number; uidValidity: number };

/**
 * Lo que hay hoy en un UID de una carpeta. uidValidity siempre viene (aunque el UID ya no
 * exista): así quien llama distingue "cambió el UIDVALIDITY" de "el mensaje ya no está" (D-008).
 */
export type InspectResult = {
  uidValidity: number;
  /** false: ese UID ya no existe en la carpeta. */
  found: boolean;
  /** Message-ID que anuncia el servidor para ese UID, o null si no trae (o no existe). */
  messageId: string | null;
};

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
  /** Revisa un UID sin bajar el cuerpo: UIDVALIDITY actual de la carpeta y Message-ID (M7, D-008). */
  inspect(location: MailLocation, uid: number): Promise<InspectResult>;
  /**
   * Mueve un mensaje de una carpeta a otra (IMAP UID MOVE; sin MOVE, COPY + borrado, D-008) y
   * devuelve su UID nuevo y el UIDVALIDITY del destino tal como los informa el servidor. Sin esa
   * evidencia lanza MoveUnconfirmedError: nunca se adivina el UID. Un corte o un fallo del
   * servidor también es MoveUnconfirmedError (no se sabe si alcanzó a moverse).
   */
  move(from: MailLocation, to: MailLocation, uid: number): Promise<MoveResult>;
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

/**
 * No hay evidencia de que el mensaje se haya movido (el servidor no devolvió el UID nuevo, o la
 * orden falló o se cortó a medias). Puede haberse movido o no: la sincronización lo reconcilia.
 * Mensaje fijo.
 */
export class MoveUnconfirmedError extends Error {
  constructor() {
    super('no se pudo confirmar el movimiento del mensaje');
    this.name = 'MoveUnconfirmedError';
  }
}
