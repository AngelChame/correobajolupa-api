import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiskStorage } from '../src/storage/disk.js';
import { InvalidStorageKeyError, type ReportStorage } from '../src/storage/storage.js';

let root: string;
let storage: ReportStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cbl-storage-'));
  storage = createDiskStorage(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = new TextEncoder().encode('Contenido sintético de prueba\r\n');

describe('almacenamiento en disco (D-038)', () => {
  it('guarda, lee y borra sin dejar nada', async () => {
    const reportId = randomUUID();
    const key = await storage.save(reportId, bytes);

    expect(key).toMatch(new RegExp(`^${reportId}/[0-9a-f]{32}$`));
    expect(await storage.read(key)).toEqual(Buffer.from(bytes));

    await storage.deleteReport(reportId);
    expect(await readdir(root)).toEqual([]);
    await expect(storage.read(key)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('usa una carpeta por reporte y un nombre aleatorio distinto cada vez', async () => {
    const reportId = randomUUID();
    const a = await storage.save(reportId, bytes);
    const b = await storage.save(reportId, bytes);
    const otro = await storage.save(randomUUID(), bytes);

    expect(a).not.toBe(b);
    expect((await readdir(root)).sort()).toEqual([reportId, otro.split('/')[0]].sort());
    expect(await readdir(join(root, reportId))).toHaveLength(2);
  });

  it('borrar un reporte que no existe no falla', async () => {
    await expect(storage.deleteReport(randomUUID())).resolves.toBeUndefined();
  });

  it('rechaza claves que intentan salir de STORAGE_DIR', async () => {
    const id = randomUUID();
    const claves = [
      `../${id}/${'a'.repeat(32)}`,
      `${id}/../../etc/passwd`,
      `${id}/..`,
      `${id}\\..\\..\\${'a'.repeat(32)}`,
      `/${id}/${'a'.repeat(32)}`,
      `${id}/${'a'.repeat(32)}/extra`,
      `${id}/factura.pdf.exe`,
      `${id}`,
      '',
    ];
    for (const clave of claves) {
      await expect(storage.read(clave), clave).rejects.toBeInstanceOf(InvalidStorageKeyError);
    }
  });

  it('rechaza un reportId que no es UUID al guardar o borrar', async () => {
    for (const reportId of ['..', '../otro', 'a/b', 'factura.pdf', randomUUID().toUpperCase()]) {
      await expect(storage.save(reportId, bytes), reportId).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.deleteReport(reportId), reportId).rejects.toBeInstanceOf(InvalidStorageKeyError);
    }
    expect(await readdir(root)).toEqual([]);
  });
});
