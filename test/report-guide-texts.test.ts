import { describe, expect, it } from 'vitest';
import { RuleId } from '../src/contract/schemas/reports.js';
import {
  AUTH_RESULT_TEXT,
  GUIDE_VERSION,
  HEADLINES,
  NOTE_TEXTS,
  RULE_GUIDES,
  SUMMARY_PHRASES,
  UNKNOWN_RULE_GUIDE,
  type GuideText,
} from '../src/report/guide-texts.js';

// Textos de plantilla del informe (D-011): completos, sin enlaces ni direcciones de correo.

const guias: [string, GuideText][] = [...Object.entries(RULE_GUIDES), ['desconocida', UNKNOWN_RULE_GUIDE]];

/** Todos los textos del archivo, con las plantillas de cantidad evaluadas en singular y plural. */
function todosLosTextos(): string[] {
  const deGuias = guias.flatMap(([, g]) => [g.title, g.whatItMeans, g.whyRisky, ...g.whatToDo, ...g.forAnalyst]);
  const frases = Object.values(SUMMARY_PHRASES).flatMap((f) => (typeof f === 'function' ? [f(1), f(3)] : [f]));
  const notas = [
    NOTE_TEXTS.failed.title,
    NOTE_TEXTS.failed.text,
    NOTE_TEXTS.limited.title,
    ...Object.values(NOTE_TEXTS.limited.byReason),
    NOTE_TEXTS.noFindings.title,
    NOTE_TEXTS.noFindings.text,
    NOTE_TEXTS.authInformative.title,
    NOTE_TEXTS.authInformative.text('aprobado', 'falló', 'sin registro'),
  ];
  return [...deGuias, ...Object.values(HEADLINES), ...frases, ...notas, ...Object.values(AUTH_RESULT_TEXT)];
}

describe('textos de la guía', () => {
  it('cada regla del contrato (R1 a R8) tiene su guía completa', () => {
    expect(Object.keys(RULE_GUIDES).sort()).toEqual([...RuleId.options].sort());
    for (const [id, g] of guias) {
      for (const campo of [g.title, g.whatItMeans, g.whyRisky]) expect(campo.trim(), id).not.toBe('');
      expect(g.whatToDo.length, id).toBeGreaterThanOrEqual(1);
      expect(g.forAnalyst.length, id).toBeGreaterThanOrEqual(1);
      for (const item of [...g.whatToDo, ...g.forAnalyst]) expect(item.trim(), id).not.toBe('');
    }
  });

  it('ningún texto contiene http, www. ni @', () => {
    for (const texto of todosLosTextos()) {
      expect(texto).not.toMatch(/http/i);
      expect(texto).not.toContain('www.');
      expect(texto).not.toContain('@');
    }
  });

  it('títulos y encabezados de 80 caracteres o menos', () => {
    const titulos = [...guias.map(([, g]) => g.title), ...Object.values(HEADLINES), NOTE_TEXTS.failed.title, NOTE_TEXTS.limited.title, NOTE_TEXTS.noFindings.title, NOTE_TEXTS.authInformative.title];
    for (const t of titulos) expect(t.length, t).toBeLessThanOrEqual(80);
  });

  it('plantillas de cantidad en singular y plural', () => {
    expect(SUMMARY_PHRASES.findings(1)).toBe('El análisis encontró 1 señal en este correo.');
    expect(SUMMARY_PHRASES.findings(2)).toBe('El análisis encontró 2 señales en este correo.');
    expect(SUMMARY_PHRASES.detected(2)).toContain('2 adjuntos como maliciosos');
    expect(SUMMARY_PHRASES.scanError(1)).toMatch(/^1 adjunto no se pudo escanear/);
    expect(SUMMARY_PHRASES.unsupported(4)).toMatch(/^4 adjuntos no se escanearon/);
  });

  it('versión de la guía', () => {
    expect(GUIDE_VERSION).toBe('g1-2026.11');
  });
});
