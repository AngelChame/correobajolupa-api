import { describe, expect, it } from 'vitest';
import { ReportDocument } from '../src/contract/schemas/report-document.js';
import { buildReportDocument, MAX_INDICATORS, type ReportInput } from '../src/report/build.js';
import { GUIDE_VERSION, HEADLINES, NOTE_TEXTS, RULE_GUIDES, UNKNOWN_RULE_GUIDE } from '../src/report/guide-texts.js';

// Armado del informe (función pura). Datos sintéticos: dominios .example e .invalid.

const AHORA = new Date('2026-11-23T12:00:00.000Z');
const ID = '0f6d6d3a-2f3e-4c1a-9b5e-1c2d3e4f5a6b';
const t = (s: number) => new Date(Date.UTC(2026, 10, 23, 10, 0, s));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function entrada(extra: Partial<ReportInput> = {}): ReportInput {
  return {
    id: ID,
    status: 'completed',
    limitedReason: null,
    priority: 'high',
    rulesVersion: 'm2-2026.11',
    fromAddress: 'Soporte@Banco-Ejemplo.example',
    authentication: { spf: 'fail', dkim: 'none', dmarc: 'unknown' },
    findings: [
      { id: uuid(3), ruleId: 'R1', createdAt: t(0), evidence: [{ label: 'Remitente (From)', value: 'soporte@banco-ejemplo[.]example' }] },
      { id: uuid(2), ruleId: 'R5', createdAt: t(0), evidence: [{ label: 'Dirección IP', value: '203[.]0[.]113[.]7' }] },
      { id: uuid(1), ruleId: 'R2', createdAt: t(0), evidence: [{ label: 'Destino', value: 'hxxp://otro-sitio[.]example/' }] },
    ],
    links: [
      { position: 1, domain: '203.0.113.7' },
      { position: 0, domain: 'otro-sitio.example' },
      { position: 2, domain: 'OTRO-SITIO.example' },
      { position: 3, domain: null },
    ],
    attachments: [
      { position: 1, fileName: 'factura.pdf.exe', sha256: 'b'.repeat(64), scanStatus: 'error' },
      { position: 0, fileName: '<b>nota</b>.txt', sha256: 'a'.repeat(64), scanStatus: 'not_detected' },
    ],
    ...extra,
  };
}

describe('buildReportDocument', () => {
  it('un feed caído añade una nota sin cambiar completed ni afirmar que el enlace está limpio', () => {
    const doc = buildReportDocument(entrada({
      status: 'completed', findings: [], feedUnavailable: ['OpenPhish'], priority: 'low',
    }), AHORA);
    expect(ReportDocument.parse(doc)).toEqual(doc);
    expect(doc.status).toBe('completed');
    expect(doc.notes.map((note) => note.kind)).toContain('feed_unavailable');
    expect(doc.notes.find((note) => note.kind === 'feed_unavailable')?.text).toBe(NOTE_TEXTS.feedUnavailable.text);
  });

  it('cumple el contrato ReportDocument y lleva la versión de la guía', () => {
    const doc = buildReportDocument(entrada(), AHORA);
    expect(ReportDocument.parse(doc)).toEqual(doc);
    expect(doc).toMatchObject({ reportId: ID, generatedAt: AHORA.toISOString(), guideVersion: GUIDE_VERSION, rulesVersion: 'm2-2026.11', status: 'completed', priority: 'high' });
  });

  it('determinista: la misma entrada da el mismo JSON, aunque cambie el orden de las listas', () => {
    const a = buildReportDocument(entrada(), AHORA);
    const e = entrada();
    const b = buildReportDocument({ ...e, findings: [...e.findings].reverse(), links: [...e.links].reverse(), attachments: [...e.attachments].reverse() }, AHORA);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(buildReportDocument(entrada(), AHORA))).toBe(JSON.stringify(a));
  });

  it('hallazgos en orden fijo, incluidas R9 y R10; dentro de una regla por fecha e id', () => {
    const marca = (n: string) => [{ label: 'marca', value: n }];
    const findings = ['R1', 'R5', 'R4', 'R3', 'R2', 'R7', 'R6', 'R8', 'R9', 'R10'].map((ruleId, i) => ({ id: uuid(i), ruleId, createdAt: t(0), evidence: marca(`f${i}`) }));
    findings.push({ id: uuid(20), ruleId: 'R6', createdAt: t(0), evidence: marca('f20') }, { id: uuid(30), ruleId: 'R6', createdAt: t(-5), evidence: marca('f30') });
    const doc = buildReportDocument(entrada({ findings }), AHORA);
    expect(doc.findings.map((f) => f.ruleId)).toEqual(['R8', 'R10', 'R6', 'R6', 'R6', 'R7', 'R9', 'R2', 'R3', 'R4', 'R5', 'R1']);
    // Entre los R6: primero el más antiguo (f30); luego f6 y f20, a la misma hora, por id.
    expect(doc.findings.slice(2, 5).map((f) => f.evidence[0]!.value)).toEqual(['f30', 'f6', 'f20']);
  });

  it('cada hallazgo trae su guía completa y la evidencia tal como está guardada', () => {
    const doc = buildReportDocument(entrada(), AHORA);
    const r2 = doc.findings[0]!;
    expect(r2).toEqual({ ruleId: 'R2', ...RULE_GUIDES.R2, whatToDo: [...RULE_GUIDES.R2.whatToDo], forAnalyst: [...RULE_GUIDES.R2.forAnalyst], evidence: [{ label: 'Destino', value: 'hxxp://otro-sitio[.]example/' }] });
  });

  it('evidencia que no cumple el contrato lanza error (la ruta responde 500)', () => {
    expect(() => buildReportDocument(entrada({ findings: [{ id: uuid(1), ruleId: 'R1', createdAt: t(0), evidence: [{ label: 1 }] }] }), AHORA)).toThrow();
  });

  it('una regla sin guía usa el texto genérico, va al final y avisa solo con el ruleId', () => {
    const avisos: string[] = [];
    const findings = [
      { id: uuid(1), ruleId: 'R11', createdAt: t(0), evidence: [] },
      { id: uuid(2), ruleId: 'R1', createdAt: t(0), evidence: [] },
    ];
    const doc = buildReportDocument(entrada({ findings }), AHORA, { onUnknownRule: (r) => avisos.push(r) });
    expect(doc.findings.map((f) => f.ruleId)).toEqual(['R1', 'R11']);
    expect(doc.findings[1]).toMatchObject({ title: UNKNOWN_RULE_GUIDE.title, whatItMeans: UNKNOWN_RULE_GUIDE.whatItMeans });
    expect(avisos).toEqual(['R11']);
  });

  it('indicadores: remitente, dominios y SHA-256 desactivados, sin repetidos y en orden', () => {
    const doc = buildReportDocument(entrada(), AHORA);
    expect(doc.indicators).toEqual([
      { type: 'sender', displayValue: 'soporte[@]banco-ejemplo[.]example' },
      { type: 'domain', displayValue: 'otro-sitio[.]example' },
      { type: 'domain', displayValue: '203[.]0[.]113[.]7' },
      { type: 'sha256', displayValue: 'a'.repeat(64) },
      { type: 'sha256', displayValue: 'b'.repeat(64) },
    ]);
  });

  it('indicadores: SHA-256 repetido sale una vez; sin remitente no hay sender', () => {
    const doc = buildReportDocument(
      entrada({
        fromAddress: null,
        links: [],
        attachments: [
          { position: 0, fileName: 'uno.txt', sha256: 'c'.repeat(64), scanStatus: 'not_detected' },
          { position: 1, fileName: 'dos.txt', sha256: 'c'.repeat(64), scanStatus: 'not_detected' },
        ],
      }),
      AHORA,
    );
    expect(doc.indicators).toEqual([{ type: 'sha256', displayValue: 'c'.repeat(64) }]);
    expect(doc.attachments).toHaveLength(2);
  });

  it(`indicadores: tope de ${MAX_INDICATORS}`, () => {
    const links = Array.from({ length: 40 }, (_, i) => ({ position: i, domain: `sitio-${i}.example` }));
    const doc = buildReportDocument(entrada({ links }), AHORA);
    expect(doc.indicators).toHaveLength(MAX_INDICATORS);
    expect(doc.indicators[0]!.type).toBe('sender');
    expect(doc.indicators.at(-1)).toEqual({ type: 'domain', displayValue: 'sitio-23[.]example' });
    expect(new Set(doc.indicators.map((i) => i.displayValue)).size).toBe(MAX_INDICATORS);
    expect(ReportDocument.safeParse(doc).success).toBe(true);
  });

  it('adjuntos en orden de position con el nombre tal como está guardado', () => {
    const doc = buildReportDocument(entrada(), AHORA);
    expect(doc.attachments).toEqual([
      { fileName: '<b>nota</b>.txt', sha256: 'a'.repeat(64), scanStatus: 'not_detected' },
      { fileName: 'factura.pdf.exe', sha256: 'b'.repeat(64), scanStatus: 'error' },
    ]);
    expect(doc.summary.text).toContain('1 adjunto no se pudo escanear');
  });

  it('failed: sin hallazgos, indicadores ni adjuntos, con la nota failed', () => {
    const doc = buildReportDocument(entrada({ status: 'failed', priority: null, authentication: null }), AHORA);
    expect(doc).toMatchObject({ findings: [], indicators: [], attachments: [], summary: { headline: HEADLINES.failed } });
    expect(doc.notes).toEqual([{ kind: 'failed', ...NOTE_TEXTS.failed }]);
    expect(ReportDocument.safeParse(doc).success).toBe(true);
  });

  it('no copia nada del correo fuera de evidencia, indicadores desactivados y nombres de adjunto', () => {
    const json = JSON.stringify(buildReportDocument(entrada(), AHORA));
    expect(json).not.toContain('Banco-Ejemplo.example');
    expect(json).not.toContain('otro-sitio.example');
    expect(json).not.toMatch(/[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i);
    expect(json).not.toMatch(/https?:\/\//);
  });
});
