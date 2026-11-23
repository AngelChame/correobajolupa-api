import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { analyze } from '../src/analysis/index.js';

// El analizador contra test/fixtures/expected.json (referencia, no verdad: si discrepan, se decide).
//
// Desde M2 se comprueban las ocho reglas salvo R8 (indicadores confirmados, al final).

const Case = z.looseObject({
  id: z.string(),
  input: z.enum(['eml', 'paste']),
  file: z.string(),
  expectedRules: z.array(z.string()),
  status: z.string(),
  limitedReason: z.string().nullable(),
  evidence: z.array(z.string()).optional(),
  decodedText: z.array(z.string()).optional(),
});
const Expected = z.looseObject({ institutionalDomains: z.array(z.string()), cases: z.array(Case) });

const FIXTURES = new URL('./fixtures/', import.meta.url);
const expected = Expected.parse(JSON.parse(readFileSync(new URL('expected.json', FIXTURES), 'utf8')));
const opciones = { institutionalDomains: expected.institutionalDomains };

describe('analyze() contra los fixtures', () => {
  it.each(expected.cases.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const r = await analyze(readFileSync(new URL(c.file, FIXTURES)), c.input, opciones);
    const reglas = c.expectedRules;

    expect(r.status).toBe(c.status);
    expect(r.limitedReason).toBe(c.limitedReason);
    expect(r.findings.map((f) => f.ruleId)).toEqual(reglas);

    // evidence: cada texto aparece en la evidencia cruda de algún hallazgo.
    if (c.evidence && reglas.length > 0) {
      const valores = r.findings.flatMap((f) => f.evidence.map((e) => e.value));
      for (const texto of c.evidence) {
        expect(valores.some((v) => v.includes(texto)), `${c.id}: falta "${texto}" en la evidencia`).toBe(true);
      }
    }
    // decodedText: cada texto aparece en el asunto o el cuerpo ya decodificados.
    for (const texto of c.decodedText ?? []) {
      expect(r.decodedText, `${c.id}: falta "${texto}" en el texto decodificado`).toContain(texto);
    }
    // Cada hallazgo trae regla, nombre, resumen y al menos una evidencia (métrica: 100 %).
    for (const f of r.findings) {
      expect(f.ruleName).not.toBe('');
      expect(f.summary).not.toBe('');
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });
});
