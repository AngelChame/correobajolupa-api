import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FindingList, ReportDetail, ReportSummary } from '../../src/contract/schemas/reports.js';
import { createLogger } from '../../src/logger.js';
import { claimNext, processNext, type QueueDeps } from '../../src/queue/process.js';
import type { ReportStorage } from '../../src/storage/storage.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Worker de análisis contra PostgreSQL real. Correos sintéticos de test/fixtures/.
const fixture = (nombre: string) => readFileSync(new URL(`../fixtures/emails/${nombre}`, import.meta.url));
const C1 = fixture('C1-combinado-reglas-1-2-5.eml');
const H02 = fixture('H02-multipart-truncado.eml');
const INST = ['universidad-ejemplo.example'];

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(limpiarBase);

type App = Parameters<typeof request>[0];

async function subir(app: App, s: Sesion, eml: Buffer): Promise<string> {
  const res = await request(app).post('/api/v1/reports').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).attach('file', eml, { filename: 'correo.eml' });
  expect(res.status).toBe(202);
  return ReportSummary.parse(res.body).id;
}

function deps(storage: ReportStorage, extra: Partial<QueueDeps> = {}) {
  const lineas: string[] = [];
  const logger = createLogger('info', { write: (l: string) => void lineas.push(l) }, 'worker');
  const d: QueueDeps = { db, storage, logger, institutionalDomains: INST, leaseSeconds: 60, maxAttempts: 3, ...extra };
  return { d, lineas };
}

describe('worker: queued → analizado', () => {
  it('C1 queda completed con hallazgos R1, R2 y R5, enlaces y evidencia desactivada', async () => {
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, C1);
    const { d, lineas } = deps(storage);

    expect(await processNext(d)).toBe('done');
    expect(await processNext(d)).toBe('idle');

    const detalle = ReportDetail.parse((await request(app).get(`/api/v1/reports/${id}`).set('Cookie', ana.cookie)).body);
    expect(detalle).toMatchObject({
      status: 'completed',
      limitedReason: null,
      priority: 'high',
      findingsCount: 3,
      subject: 'URGENTE: cuenta suspendida',
      fromAddress: 'soporte@banco-ejemplo.example',
      rulesVersion: 'm1-2026.11',
      hasHtml: true,
    });
    expect(detalle.analyzedAt).not.toBeNull();
    expect(detalle.links).toEqual([
      { displayText: 'https://www.banco-ejemplo.example/cuenta', defangedUrl: 'hxxp://203[.]0[.]113[.]45/cuenta', domain: '203.0.113.45' },
    ]);

    const hallazgos = FindingList.parse((await request(app).get(`/api/v1/reports/${id}/findings`).set('Cookie', ana.cookie)).body);
    expect(hallazgos.items.map((f) => f.ruleId)).toEqual(['R1', 'R2', 'R5']);
    const valores = hallazgos.items.flatMap((f) => f.evidence.map((e) => e.value));
    expect(valores).toContain('soporte@banco-ejemplo[.]example');
    expect(valores).toContain('cobros@correo-desconocido[.]invalid');
    expect(valores).toContain('hxxps://www[.]banco-ejemplo[.]example/cuenta');
    expect(valores).toContain('hxxp://203[.]0[.]113[.]45/cuenta');
    // Nada clicable en la evidencia guardada.
    for (const v of valores) expect(v).not.toMatch(/https?:\/\/|\w\.\w/);

    const fila = await db.report.findUniqueOrThrow({ where: { id } });
    expect(fila).toMatchObject({ attempts: 1, lockedUntil: null, lastErrorCode: null });
    // Registros: solo IDs y conteos.
    const registros = lineas.join('\n');
    expect(registros).toContain(id);
    expect(registros).not.toMatch(/URGENTE|banco-ejemplo|correo-desconocido|203\.0\.113/);
  });

  it('un multipart truncado queda limited / parse_error', async () => {
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, H02);
    expect(await processNext(deps(storage).d)).toBe('done');
    expect(await db.report.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'limited', limitedReason: 'parse_error' });
  });
});

describe('worker: arriendos, reintentos y concurrencia', () => {
  it('P-22: un trabajo en processing con el arriendo vencido se retoma; uno vigente no', async () => {
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const vencido = await subir(app, ana, C1);
    const vigente = await subir(app, ana, C1);
    await db.$executeRaw`UPDATE reports SET status = 'processing', attempts = 1, locked_until = now() - interval '1 minute' WHERE id = ${vencido}::uuid`;
    await db.$executeRaw`UPDATE reports SET status = 'processing', attempts = 1, locked_until = now() + interval '10 minutes' WHERE id = ${vigente}::uuid`;

    expect(await processNext(deps(storage).d)).toBe('done');
    expect(await processNext(deps(storage).d)).toBe('idle');
    expect(await db.report.findUniqueOrThrow({ where: { id: vencido } })).toMatchObject({ status: 'completed', attempts: 2 });
    expect(await db.report.findUniqueOrThrow({ where: { id: vigente } })).toMatchObject({ status: 'processing', attempts: 1 });
  });

  it('un error al leer el archivo se reintenta hasta JOB_MAX_ATTEMPTS y luego queda failed', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, C1);
    const rota: ReportStorage = {
      save: () => Promise.reject(new Error('no se usa')),
      read: () => Promise.reject(Object.assign(new Error('MARCADOR_ERROR_INTERNO'), { code: 'EIO' })),
      deleteReport: () => Promise.resolve(),
    };
    const { d, lineas } = deps(rota);

    expect(await processNext(d)).toBe('retry');
    expect(await db.report.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'queued', attempts: 1, lastErrorCode: 'storage_error' });
    expect(await processNext(d)).toBe('retry');
    expect(await processNext(d)).toBe('failed');
    expect(await db.report.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'failed', attempts: 3, lockedUntil: null, lastErrorCode: 'storage_error' });
    expect(await processNext(d)).toBe('idle');
    expect(lineas.join('\n')).not.toContain('MARCADOR_ERROR_INTERNO');
  });

  it('un análisis que no termina a tiempo se libera con analysis_timeout', async () => {
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, C1);
    const { d } = deps(storage, { analysisTimeoutMs: 50, analyzeFn: () => new Promise(() => undefined) });
    expect(await processNext(d)).toBe('retry');
    expect(await db.report.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'queued', lastErrorCode: 'analysis_timeout' });
  });

  it('un arriendo vencido demasiadas veces queda failed sin volver a analizar', async () => {
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, C1);
    await db.$executeRaw`UPDATE reports SET status = 'processing', attempts = 3, locked_until = now() - interval '1 minute' WHERE id = ${id}::uuid`;
    expect(await processNext(deps(storage).d)).toBe('failed');
    expect(await db.report.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'failed', lastErrorCode: 'lease_expired' });
  });

  it('si el reporte se borra mientras se analiza, el resultado se descarta', async () => {
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, C1);
    const borraAlLeer: ReportStorage = {
      ...storage,
      read: async (key) => {
        const bytes = await storage.read(key);
        const res = await request(app).delete(`/api/v1/reports/${id}`).set('Cookie', ana.cookie).set('X-CSRF-Token', ana.csrf);
        expect(res.status).toBe(204);
        return bytes;
      },
    };
    expect(await processNext(deps(borraAlLeer).d)).toBe('discarded');
    expect(await db.report.count()).toBe(0);
    expect(await db.finding.count()).toBe(0);
    expect(await db.reportLink.count()).toBe(0);
  });

  it('dos workers a la vez nunca toman el mismo reporte', async () => {
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    // Una sola fila: de dos tomas simultáneas, solo una la consigue.
    await subir(app, ana, C1);
    const tomas = await Promise.all([claimNext(db, 60), claimNext(db, 60)]);
    expect(tomas.filter(Boolean)).toHaveLength(1);

    // Varias filas y varios workers: cada reporte se analiza exactamente una vez.
    await limpiarBase();
    const ana2 = await entrarComo(app, 'reporter', 'ana2@ejemplo.invalid');
    for (let i = 0; i < 6; i++) await subir(app, ana2, C1);
    const worker = async () => {
      const hechos: string[] = [];
      while ((await processNext(deps(storage).d)) !== 'idle') hechos.push('x');
      return hechos.length;
    };
    const cuentas = await Promise.all([worker(), worker(), worker()]);
    expect(cuentas.reduce((a, b) => a + b, 0)).toBe(6);
    const filas = await db.report.findMany({ select: { status: true, attempts: true } });
    expect(filas.every((f) => f.status === 'completed' && f.attempts === 1)).toBe(true);
  });
});
