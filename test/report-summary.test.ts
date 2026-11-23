import { describe, expect, it } from 'vitest';
import { HEADLINES, NOTE_TEXTS, SUMMARY_PHRASES } from '../src/report/guide-texts.js';
import { buildNotes, buildSummary, type SummaryInput } from '../src/report/summary.js';

// Cada rama del resumen y de las notas del informe (plantillas de M3).

const base: SummaryInput = { status: 'completed', findingsCount: 0, priority: 'low', scanStatuses: [] };
const resumen = (extra: Partial<SummaryInput>) => buildSummary({ ...base, ...extra });

describe('buildSummary: encabezado', () => {
  it('failed manda sobre todo, y su texto va solo', () => {
    const s = resumen({ status: 'failed', findingsCount: 2, priority: null, scanStatuses: ['detected', 'error'] });
    expect(s).toEqual({ headline: HEADLINES.failed, text: SUMMARY_PHRASES.failed });
  });

  it('adjunto detected manda sobre los hallazgos y la prioridad (singular y plural)', () => {
    expect(resumen({ findingsCount: 3, priority: 'high', scanStatuses: ['detected', 'not_detected'] }).headline).toBe(HEADLINES.detectedOne);
    expect(resumen({ scanStatuses: ['detected', 'detected'] }).headline).toBe(HEADLINES.detectedMany);
  });

  it('0 hallazgos: limited y no limited', () => {
    expect(resumen({ status: 'limited' }).headline).toBe(HEADLINES.limitedNoFindings);
    expect(resumen({}).headline).toBe(HEADLINES.noFindings);
  });

  it('completed sin hallazgos con adjuntos en error o unsupported: encabezado de adjuntos sin escanear', () => {
    expect(resumen({ scanStatuses: ['error'] }).headline).toBe(HEADLINES.noFindingsUnscanned);
    expect(resumen({ scanStatuses: ['unsupported', 'not_detected'] }).headline).toBe(HEADLINES.noFindingsUnscanned);
    expect(resumen({ scanStatuses: ['not_detected'] }).headline).toBe(HEADLINES.noFindings);
  });

  it('detected sigue mandando y limited conserva su encabezado aunque haya adjuntos sin escanear', () => {
    expect(resumen({ scanStatuses: ['error', 'detected'] }).headline).toBe(HEADLINES.detectedOne);
    expect(resumen({ status: 'limited', scanStatuses: ['error', 'unsupported'] }).headline).toBe(HEADLINES.limitedNoFindings);
  });

  it('con hallazgos, adjuntos sin escanear no cambian el encabezado por prioridad', () => {
    expect(resumen({ findingsCount: 1, priority: 'low', scanStatuses: ['error'] }).headline).toBe(HEADLINES.low);
  });

  it('con hallazgos, según la prioridad (nula = medium)', () => {
    expect(resumen({ findingsCount: 2, priority: 'high' }).headline).toBe(HEADLINES.high);
    expect(resumen({ findingsCount: 1, priority: 'medium' }).headline).toBe(HEADLINES.medium);
    expect(resumen({ findingsCount: 1, priority: null }).headline).toBe(HEADLINES.medium);
    expect(resumen({ findingsCount: 1, priority: 'low' }).headline).toBe(HEADLINES.low);
  });
});

describe('buildSummary: texto', () => {
  it('con hallazgos: cantidad (singular y plural) y "ninguna regla prueba"', () => {
    expect(resumen({ findingsCount: 1, priority: 'low' }).text).toBe(`${SUMMARY_PHRASES.findings(1)} ${SUMMARY_PHRASES.noRuleProves}`);
    expect(resumen({ findingsCount: 3, priority: 'high' }).text).toBe(
      'El análisis encontró 3 señales en este correo. Ninguna regla prueba por sí sola que sea phishing: lee la guía de cada una antes de decidir.',
    );
  });

  it('sin hallazgos y no limited: "no significa seguro"', () => {
    expect(resumen({}).text).toBe(SUMMARY_PHRASES.noFindings);
  });

  it('limited sin hallazgos: solo la frase de limitado', () => {
    expect(resumen({ status: 'limited' }).text).toBe(SUMMARY_PHRASES.limited);
  });

  it('limited con hallazgos: hallazgos y luego limitado', () => {
    expect(resumen({ status: 'limited', findingsCount: 1, priority: 'medium' }).text).toBe(
      [SUMMARY_PHRASES.findings(1), SUMMARY_PHRASES.noRuleProves, SUMMARY_PHRASES.limited].join(' '),
    );
  });

  it('adjunto detected más limited', () => {
    const s = resumen({ status: 'limited', priority: 'high', scanStatuses: ['detected'] });
    expect(s.headline).toBe(HEADLINES.detectedOne);
    expect(s.text).toBe(`${SUMMARY_PHRASES.limited} ${SUMMARY_PHRASES.detected(1)}`);
  });

  it('0 hallazgos con un adjunto en error: nunca "limpio"', () => {
    const s = resumen({ scanStatuses: ['error'] });
    expect(s.headline).toBe(HEADLINES.noFindingsUnscanned);
    expect(s.text).toBe(`${SUMMARY_PHRASES.noFindings} ${SUMMARY_PHRASES.scanError(1)}`);
    expect(s.text).toContain('eso no significa que esté limpio');
  });

  it('plurales de detected, error y unsupported, en ese orden', () => {
    const s = resumen({ findingsCount: 1, priority: 'high', scanStatuses: ['unsupported', 'error', 'detected', 'error', 'detected', 'unsupported', 'unsupported', 'not_detected'] });
    expect(s.text).toBe(
      [
        SUMMARY_PHRASES.findings(1),
        SUMMARY_PHRASES.noRuleProves,
        'El escáner antivirus marcó 2 adjuntos como maliciosos. No los abras ni los reenvíes.',
        '2 adjuntos no se pudieron escanear por un error del escáner; eso no significa que estén limpios.',
        '3 adjuntos no se escanearon (tipo o tamaño no soportado); eso no significa que estén limpios.',
      ].join(' '),
    );
  });

  it('unsupported en singular; not_detected no agrega frase', () => {
    expect(resumen({ scanStatuses: ['unsupported', 'not_detected'] }).text).toBe(`${SUMMARY_PHRASES.noFindings} ${SUMMARY_PHRASES.unsupported(1)}`);
    expect(resumen({ scanStatuses: ['not_detected'] }).text).toBe(SUMMARY_PHRASES.noFindings);
  });
});

describe('buildNotes', () => {
  const sinAuth = { limitedReason: null, authentication: null } as const;

  it('failed: solo la nota failed (sin no_findings)', () => {
    expect(buildNotes({ status: 'failed', findingsCount: 0, ...sinAuth })).toEqual([{ kind: 'failed', ...NOTE_TEXTS.failed }]);
  });

  it('limited según el motivo; sin motivo usa el de parse_error; luego no_findings', () => {
    expect(buildNotes({ status: 'limited', limitedReason: 'missing_headers', findingsCount: 0, authentication: null })).toEqual([
      { kind: 'limited', title: 'Análisis limitado', text: NOTE_TEXTS.limited.byReason.missing_headers },
      { kind: 'no_findings', ...NOTE_TEXTS.noFindings },
    ]);
    expect(buildNotes({ status: 'limited', limitedReason: 'parse_error', findingsCount: 1, authentication: null })).toEqual([
      { kind: 'limited', title: 'Análisis limitado', text: NOTE_TEXTS.limited.byReason.parse_error },
    ]);
    expect(buildNotes({ status: 'limited', limitedReason: null, findingsCount: 1, authentication: null })[0]!.text).toBe(NOTE_TEXTS.limited.byReason.parse_error);
  });

  it('completed: no_findings solo con 0 hallazgos', () => {
    expect(buildNotes({ status: 'completed', findingsCount: 0, ...sinAuth }).map((n) => n.kind)).toEqual(['no_findings']);
    expect(buildNotes({ status: 'completed', findingsCount: 2, ...sinAuth })).toEqual([]);
  });

  it('auth_informative con al menos un resultado distinto de unknown, al final y en palabras', () => {
    const notas = buildNotes({ status: 'completed', limitedReason: null, findingsCount: 0, authentication: { spf: 'pass', dkim: 'fail', dmarc: 'none' } });
    expect(notas.map((n) => n.kind)).toEqual(['no_findings', 'auth_informative']);
    expect(notas[1]).toEqual({
      kind: 'auth_informative',
      title: 'Autenticación del remitente (informativa)',
      text: 'Resultados que trae el encabezado: SPF aprobado, DKIM falló, DMARC sin registro. Se muestran solo como información: en un archivo subido pueden estar alterados y nunca cambian la prioridad.',
    });
    const conUnknown = buildNotes({ status: 'completed', limitedReason: null, findingsCount: 1, authentication: { spf: 'unknown', dkim: 'unknown', dmarc: 'pass' } });
    expect(conUnknown[0]!.text).toContain('SPF desconocido, DKIM desconocido, DMARC aprobado.');
  });

  it('sin auth_informative si todo es unknown o no hay autenticación', () => {
    expect(buildNotes({ status: 'completed', limitedReason: null, findingsCount: 1, authentication: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' } })).toEqual([]);
    expect(buildNotes({ status: 'completed', findingsCount: 1, ...sinAuth })).toEqual([]);
  });

  it('orden completo: limited, no_findings, auth_informative', () => {
    const notas = buildNotes({ status: 'limited', limitedReason: 'missing_headers', findingsCount: 0, authentication: { spf: 'fail', dkim: 'unknown', dmarc: 'unknown' } });
    expect(notas.map((n) => n.kind)).toEqual(['limited', 'no_findings', 'auth_informative']);
  });
});
