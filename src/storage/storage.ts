/**
 * Almacenamiento de los archivos de un reporte (D-038): el .eml o el texto pegado tal como llegó.
 * El resto del código solo conoce esta interfaz; hoy la implementación es un volumen de Docker
 * (src/storage/disk.ts) y se podría cambiar sin tocar quien la usa.
 *
 * La clave que devuelve save() es opaca: se guarda en reports.storage_key y se pasa tal cual a
 * read(). Nunca contiene el nombre del adjunto ni nada que venga del correo.
 */
export interface ReportStorage {
  /** Guarda los bytes en la carpeta del reporte con un nombre aleatorio y devuelve la clave. */
  save(reportId: string, bytes: Uint8Array): Promise<string>;
  /** Lee los bytes de una clave devuelta por save(). Rechaza claves con otra forma. */
  read(storageKey: string): Promise<Buffer>;
  /** Borra la carpeta del reporte con todo su contenido. No falla si ya no existe. */
  deleteReport(reportId: string): Promise<void>;
  /**
   * Carpetas de reportes que hay en el almacenamiento, con su última modificación. Solo las que
   * tienen nombre de reportId (UUID); cualquier otra cosa se ignora. Para la reconciliación (D-038).
   */
  listReports(): Promise<{ reportId: string; modifiedAt: Date }[]>;
}

/** Error de una clave o un reportId con forma inválida (posible intento de salir de la carpeta). */
export class InvalidStorageKeyError extends Error {
  constructor() {
    // Sin la clave en el mensaje: puede venir de fuera y no debe acabar en los registros.
    super('Clave de almacenamiento inválida.');
    this.name = 'InvalidStorageKeyError';
  }
}
