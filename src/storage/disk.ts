import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { InvalidStorageKeyError, type ReportStorage } from './storage.js';

/** reportId: UUID en minúsculas (lo genera la API, nunca viene del correo). */
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Nombre del archivo: 32 caracteres hexadecimales aleatorios (128 bits). */
const FILE_NAME = /^[0-9a-f]{32}$/;

/**
 * Implementación en disco bajo STORAGE_DIR (D-038): una carpeta por reporte, archivos con
 * nombre aleatorio. La clave es "<reportId>/<nombre>".
 *
 * Dos defensas contra salir de la carpeta (path traversal):
 *  1. la clave y el reportId deben tener exactamente la forma esperada (sin "/", "\\" ni "..");
 *  2. la ruta resuelta debe quedar dentro de STORAGE_DIR, aunque la primera fallara.
 */
export function createDiskStorage(storageDir: string): ReportStorage {
  const root = resolve(storageDir);

  /** Ruta absoluta dentro de root, o error si saldría de ella. */
  function inside(...parts: string[]): string {
    const target = resolve(root, ...parts);
    const rel = relative(root, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new InvalidStorageKeyError();
    }
    return target;
  }

  function reportDir(reportId: string): string {
    if (!REPORT_ID.test(reportId)) throw new InvalidStorageKeyError();
    return inside(reportId);
  }

  function keyPath(storageKey: string): string {
    const [reportId, fileName, ...rest] = storageKey.split('/');
    if (rest.length > 0 || !reportId || !fileName || !REPORT_ID.test(reportId) || !FILE_NAME.test(fileName)) {
      throw new InvalidStorageKeyError();
    }
    return inside(reportId, fileName);
  }

  return {
    async save(reportId, bytes) {
      const dir = reportDir(reportId);
      // 0o700 / 0o600: solo el usuario del proceso (node en el contenedor) puede leerlos.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const fileName = randomBytes(16).toString('hex');
      // flag "wx": falla si el archivo ya existe, nunca sobrescribe.
      await writeFile(`${dir}${sep}${fileName}`, bytes, { flag: 'wx', mode: 0o600 });
      return `${reportId}/${fileName}`;
    },

    async read(storageKey) {
      return readFile(keyPath(storageKey));
    },

    async deleteReport(reportId) {
      await rm(reportDir(reportId), { recursive: true, force: true });
    },

    async listReports() {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') return [];
        throw error;
      }
      const found: { reportId: string; modifiedAt: Date }[] = [];
      for (const entry of entries) {
        // Solo carpetas reales con nombre UUID: ni enlaces simbólicos ni otros archivos.
        if (!entry.isDirectory() || !REPORT_ID.test(entry.name)) continue;
        try {
          found.push({ reportId: entry.name, modifiedAt: (await stat(reportDir(entry.name))).mtime });
        } catch {
          // Se borró entre readdir y stat: ya no hay nada que reconciliar.
        }
      }
      return found;
    },
  };
}
