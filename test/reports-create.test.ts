import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { createLogger } from '../src/logger.js';
import { createReport } from '../src/reports/create.js';
import { createDiskStorage } from '../src/storage/disk.js';

// Si la base falla después de guardar el archivo, no debe quedar la carpeta huérfana.

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cbl-create-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Base falsa: la cuota está libre pero la transacción falla (como una caída de PostgreSQL). */
function dbQueFalla(): Db {
  return {
    $queryRaw: async () => [{ n: 0 }],
    $transaction: async () => {
      throw new Error('fallo sintético de la base');
    },
  } as unknown as Db;
}

describe('createReport', () => {
  it('borra la carpeta del reporte si la base falla después de guardar el archivo', async () => {
    const lineas: string[] = [];
    const log = createLogger('info', { write: (l: string) => void lineas.push(l) });
    const deps = { db: dbQueFalla(), storage: createDiskStorage(root), reportsPerHour: 30 };
    const input = { userId: crypto.randomUUID(), source: 'eml' as const, bytes: new TextEncoder().encode('MARCADOR_CUERPO'), requestId: 'r1' };

    await expect(createReport(deps, input, log)).rejects.toThrow('fallo sintético de la base');
    expect(await readdir(root)).toEqual([]);
    expect(lineas.join('\n')).not.toContain('MARCADOR_CUERPO');
  });
});
