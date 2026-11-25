import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { ReportDocument } from '../../src/contract/schemas/report-document.js';
import { ReportSummary } from '../../src/contract/schemas/reports.js';
import type { ReportStatus } from '../../src/generated/prisma/enums.js';
import { createLogger } from '../../src/logger.js';
import { processNext, type QueueDeps } from '../../src/queue/process.js';
import { FINDING_ORDER } from '../../src/report/build.js';
import { HEADLINES, NOTE_TEXTS, RULE_GUIDES, SUMMARY_PHRASES } from '../../src/report/guide-texts.js';
import type { ReportStorage } from '../../src/storage/storage.js';
import { correoConAdjuntos } from '../correo-adjuntos.js';
import { eicar, esEicar } from '../eicar.js';
import { startFakeClamd, type FakeClamd } from '../fake-clamd.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// GET /reports/{id}/report (M3) contra PostgreSQL real: visibilidad (P-07, P-08), estados,
// fixtures de punta a punta, nada sin desactivar (P-17) y registros sin contenido (P-18).
// Datos sintéticos; EICAR se arma al ejecutar (test/eicar.ts).

type App = Parameters<typeof request>[0];
const Doc = z.strictObject(ReportDocument.shape);

const Case = z.looseObject({ id: z.string(), input: z.enum(['eml', 'paste']), file: z.string(), expectedRules: z.array(z.string()), status: z.string() });
const FIXTURES = new URL('../fixtures/', import.meta.url);
const expected = z
  .looseObject({ institutionalDomains: z.array(z.string()), cases: z.array(Case) })
  .parse(JSON.parse(readFileSync(new URL('expected.json', FIXTURES), 'utf8')));

/** Una dirección de correo o una URL que se podría usar tal cual (sin [.] ni [@]). */
const CORREO_CRUDO = /[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
const URL_CRUDA = /https?:\/\//i;

let fake: FakeClamd | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

function esError(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ErrorResponse.parse(res.body).code).toBe(code);
}

async function subir(app: App, s: Sesion, eml: Buffer): Promise<string> {
  const res = await request(app).post('/api/v1/reports').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).attach('file', eml, { filename: 'correo.eml' });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return ReportSummary.parse(res.body).id;
}

async function pegar(app: App, s: Sesion, text: string): Promise<string> {
  const res = await request(app).post('/api/v1/reports/paste').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send({ text });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return ReportSummary.parse(res.body).id;
}

/** Worker con los dominios institucionales de los fixtures y ClamAV en `port`. */
function worker(storage: ReportStorage, port = 1): QueueDeps {
  const logger = createLogger('silent', undefined, 'worker');
  const scan = { host: '127.0.0.1', port, timeoutMs: 1000, totalBudgetMs: 3000, maxScanBytes: 1024 * 1024, maxScanned: 20 };
  return { db, storage, logger, institutionalDomains: expected.institutionalDomains, leaseSeconds: 60, maxAttempts: 3, scan };
}

async function informe(app: App, s: Sesion, id: string) {
  const res = await request(app).get(`/api/v1/reports/${id}/report`).set('Cookie', s.cookie);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { doc: Doc.parse(res.body), json: res.text };
}

function reporte(userId: string, status: ReportStatus = 'completed', extra: Record<string, unknown> = {}) {
  return db.report.create({
    data: { userId, source: 'eml', storageKey: 'clave-sintetica', sizeBytes: 1, sha256: 'b'.repeat(64), status, priority: status === 'completed' ? 'low' : null, ...extra },
  });
}

/** Un puerto donde nadie escucha. */
async function puertoCerrado(): Promise<number> {
  const f = await startFakeClamd({ kind: 'text', text: 'stream: OK' });
  await f.close();
  return f.port;
}

describe('GET /reports/{reportId}/report: acceso y estados', () => {
  it('P-07: el reportante ve el informe de su propio reporte; P-08: el ajeno es 404', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const luis = await entrarComo(app, 'reporter', 'luis@ejemplo.invalid');
    const r = await reporte(ana.userId);

    const { doc } = await informe(app, ana, r.id);
    expect(doc).toMatchObject({ reportId: r.id, status: 'completed', guideVersion: 'g4-2026.11', findings: [], summary: { headline: HEADLINES.noFindings } });
    expect(doc.notes.map((n) => n.kind)).toEqual(['no_findings']);
    esError(await request(app).get(`/api/v1/reports/${r.id}/report`).set('Cookie', luis.cookie), 404, 'not_found');
  });

  it('analista y administrador ven el informe de cualquier reporte', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const analista = await entrarComo(app, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const r = await reporte(ana.userId);
    for (const s of [analista, admin]) expect((await informe(app, s, r.id)).doc.reportId).toBe(r.id);
  });

  it('401 sin sesión; 404 con un ID mal formado o inexistente', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    esError(await request(app).get(`/api/v1/reports/${crypto.randomUUID()}/report`), 401, 'unauthenticated');
    esError(await request(app).get('/api/v1/reports/no-es-uuid/report').set('Cookie', ana.cookie), 404, 'not_found');
    esError(await request(app).get(`/api/v1/reports/${crypto.randomUUID()}/report`).set('Cookie', ana.cookie), 404, 'not_found');
  });

  it('409 report_not_ready mientras está queued o processing', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    for (const status of ['queued', 'processing'] as const) {
      const r = await reporte(ana.userId, status);
      esError(await request(app).get(`/api/v1/reports/${r.id}/report`).set('Cookie', ana.cookie), 409, 'report_not_ready');
    }
  });

  it('failed responde 200 con la nota failed y sin hallazgos (D-004)', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const r = await reporte(ana.userId, 'failed');
    await db.finding.create({ data: { reportId: r.id, ruleId: 'R1', ruleName: 'x', summary: 'x', evidence: [], rulesVersion: 'm2-2026.11' } });
    const { doc } = await informe(app, ana, r.id);
    expect(doc).toMatchObject({ status: 'failed', findings: [], indicators: [], attachments: [], summary: { headline: HEADLINES.failed, text: SUMMARY_PHRASES.failed } });
    expect(doc.notes).toEqual([{ kind: 'failed', ...NOTE_TEXTS.failed }]);
  });

  it('limited con motivo y autenticación informativa', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const r = await reporte(ana.userId, 'limited', { limitedReason: 'missing_headers', priority: 'low', authentication: { spf: 'fail', dkim: 'unknown', dmarc: 'none' } });
    const { doc } = await informe(app, ana, r.id);
    expect(doc.summary.headline).toBe(HEADLINES.limitedNoFindings);
    expect(doc.notes.map((n) => n.kind)).toEqual(['limited', 'no_findings', 'auth_informative']);
    expect(doc.notes[2]!.text).toContain('SPF falló, DKIM desconocido, DMARC sin registro.');
  });
});

describe('informe de los fixtures de punta a punta', () => {
  it('reglas esperadas con su guía; P-17: nada sin desactivar en ningún informe', async () => {
    const { app, storage } = crearApp({ REPORTS_PER_USER_PER_HOUR: '200' });
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const d = worker(storage);
    let conReglas = 0;

    for (const c of expected.cases) {
      const bytes = readFileSync(new URL(c.file, FIXTURES));
      const id = c.input === 'eml' ? await subir(app, ana, bytes) : await pegar(app, ana, bytes.toString('utf8'));
      expect(await processNext(d), c.id).toBe('done');
      const { doc, json } = await informe(app, ana, id);

      expect(doc.status, c.id).toBe(c.status);
      const esperadas = [...c.expectedRules].sort((a, b) => FINDING_ORDER.indexOf(a as never) - FINDING_ORDER.indexOf(b as never));
      expect(doc.findings.map((f) => f.ruleId), c.id).toEqual(esperadas);
      for (const f of doc.findings) {
        expect(f.title, c.id).toBe(RULE_GUIDES[f.ruleId].title);
        expect(f.whatToDo.length, c.id).toBeGreaterThan(0);
        expect(f.evidence.length, c.id).toBeGreaterThan(0);
      }
      if (c.expectedRules.length > 0) conReglas++;
      else expect(doc.notes.map((n) => n.kind), c.id).toContain('no_findings');

      // P-17: ni URL ni correo utilizables en el JSON completo.
      expect(json, `${c.id}: URL sin desactivar`).not.toMatch(URL_CRUDA);
      expect(json, `${c.id}: correo sin desactivar`).not.toMatch(CORREO_CRUDO);
    }
    expect(conReglas).toBeGreaterThan(10);
  });
});

describe('informe con adjuntos', () => {
  it('EICAR: encabezado de malware y el adjunto como detected', async () => {
    fake = await startFakeClamd((content) => ({ kind: 'text', text: esEicar(content) ? 'stream: Eicar-Test-Signature FOUND' : 'stream: OK' }));
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const prueba = eicar();
    const id = await subir(app, ana, correoConAdjuntos([{ name: 'prueba-eicar.txt', type: 'text/plain', content: prueba }]));
    expect(await processNext(worker(storage, fake.port))).toBe('done');

    const { doc } = await informe(app, ana, id);
    expect(doc.summary.headline).toBe(HEADLINES.detectedOne);
    expect(doc.summary.text).toContain(SUMMARY_PHRASES.detected(1));
    expect(doc.attachments).toEqual([{ fileName: 'prueba-eicar.txt', sha256: createHash('sha256').update(prueba).digest('hex'), scanStatus: 'detected' }]);
    expect(doc.priority).toBe('high');
  });

  it('ClamAV caído: la frase de error, nunca "limpio"', async () => {
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, correoConAdjuntos([{ name: 'documento.pdf', type: 'application/pdf', content: Buffer.from('%PDF-1.4\n') }]));
    expect(await processNext(worker(storage, await puertoCerrado()))).toBe('done');

    const { doc } = await informe(app, ana, id);
    expect(doc.attachments.map((a) => a.scanStatus)).toEqual(['error']);
    expect(doc.summary.headline).toBe(HEADLINES.noFindingsUnscanned);
    expect(doc.summary.text).toContain(SUMMARY_PHRASES.scanError(1));
    // "limpio" y "seguro" solo aparecen negados.
    const sinNegaciones = doc.summary.text.replaceAll('no significa que esté limpio', '').replaceAll('no significa que el correo sea seguro', '');
    expect(sinNegaciones).not.toMatch(/limpi|segur/i);
    expect(JSON.stringify(doc)).not.toContain('not_detected');
  });
});

describe('P-18: registros de la petición del informe', () => {
  it('solo ID, estado y conteos: sin nombres de archivo, dominios, indicadores ni textos', async () => {
    fake = await startFakeClamd({ kind: 'text', text: 'stream: OK' });
    const { app, storage, lineas } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const C1 = readFileSync(new URL('emails/C1-combinado-reglas-1-2-5.eml', FIXTURES));
    const ids = [await subir(app, ana, C1), await subir(app, ana, correoConAdjuntos([{ name: 'nombre-secreto-adjunto.pdf', type: 'application/pdf', content: Buffer.from('%PDF-1.4\n') }]))];
    const d = worker(storage, fake.port);
    expect(await processNext(d)).toBe('done');
    expect(await processNext(d)).toBe('done');

    for (const id of ids) {
      const desde = lineas.length;
      const { doc } = await informe(app, ana, id);
      const registros = lineas.slice(desde).join('\n');

      expect(registros).toContain(id);
      expect(registros).toContain('"findings":');
      const prohibidos = [
        'nombre-secreto-adjunto',
        'banco-ejemplo',
        doc.summary.headline,
        doc.summary.text,
        ...doc.indicators.map((i) => i.displayValue),
        ...doc.attachments.flatMap((a) => [a.fileName ?? '', a.sha256]),
        ...doc.findings.flatMap((f) => [f.title, f.whatItMeans, ...f.evidence.map((e) => e.value)]),
        ...doc.notes.map((n) => n.text),
      ].filter((p) => p !== '');
      for (const p of prohibidos) expect(registros, `registro con "${p}"`).not.toContain(p);
    }
  });
});
