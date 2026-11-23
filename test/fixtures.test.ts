import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LimitedReason, ReportSource, ReportStatus, RuleId } from '../src/contract/schemas/reports.js';

// Coherencia de los correos de prueba de M1 con su `expected.json` y con el contrato.
// No lee el contenido de los correos: solo nombres de archivo y metadatos del caso.

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

// Carpeta de cada tipo de entrada. Al ser un Record sobre ReportSource, si el contrato agrega
// otra fuente, este mapa deja de compilar hasta que se le asigne carpeta.
const FOLDER_BY_INPUT: Record<z.infer<typeof ReportSource>, string> = { eml: 'emails', paste: 'paste' };

// Solo se validan los campos que esta prueba necesita; el resto del caso se deja pasar.
const Case = z.looseObject({
  id: z.string().min(1),
  input: ReportSource,
  file: z.string().min(1),
  expectedRules: z.array(RuleId),
  status: ReportStatus,
  limitedReason: LimitedReason.nullable(),
});
const Expected = z.looseObject({ cases: z.array(Case).min(1) });

const raw: unknown = JSON.parse(readFileSync(`${FIXTURES_DIR}expected.json`, 'utf8'));
const parsed = Expected.safeParse(raw);

// Si el JSON no cumple la forma, las demás pruebas fallan en vez de pasar sobre una lista vacía.
function validCases(): z.infer<typeof Case>[] {
  expect(parsed.success, 'expected.json no cumple la forma; ver la primera prueba').toBe(true);
  return parsed.success ? parsed.data.cases : [];
}

describe('fixtures de M1 (test/fixtures/expected.json)', () => {
  it('cumple la forma esperada con los enums del contrato (RuleId, ReportStatus, LimitedReason)', () => {
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('los ids son únicos', () => {
    const ids = validCases().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cada `file` es una ruta relativa dentro de fixtures y el archivo existe', () => {
    for (const c of validCases()) {
      const normalized = posix.normalize(c.file);
      expect(normalized, c.id).toBe(c.file);
      expect(normalized.startsWith('../') || posix.isAbsolute(normalized), c.id).toBe(false);
      expect(existsSync(`${FIXTURES_DIR}${c.file}`), `${c.id}: falta ${c.file}`).toBe(true);
    }
  });

  it('`input` concuerda con la carpeta del archivo', () => {
    for (const c of validCases()) {
      expect(posix.dirname(c.file), c.id).toBe(FOLDER_BY_INPUT[c.input]);
    }
  });

  it('todo archivo en emails/ y paste/ tiene su caso', () => {
    const declared = new Set(validCases().map((c) => c.file));
    const onDisk = Object.values(FOLDER_BY_INPUT).flatMap((folder) =>
      readdirSync(`${FIXTURES_DIR}${folder}`).map((name) => `${folder}/${name}`),
    );
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk.filter((file) => !declared.has(file))).toEqual([]);
  });

  it('status es `limited` si y solo si hay limitedReason', () => {
    for (const c of validCases()) {
      expect(c.status === 'limited', c.id).toBe(c.limitedReason !== null);
    }
  });

  it('expectedRules no repite reglas', () => {
    for (const c of validCases()) {
      expect(new Set(c.expectedRules).size, c.id).toBe(c.expectedRules.length);
    }
  });
});
