import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDocument } from '../../src/contract/schemas/report-document.js';
import { ReportDetail, ReportSummary } from '../../src/contract/schemas/reports.js';
import { createLogger } from '../../src/logger.js';
import { processNext, type QueueDeps } from '../../src/queue/process.js';
import { crearApp, db, entrarComo, limpiarBase } from './support.js';

const KEY = 'MARCADOR_CLAVE_DE_PRUEBA_LARGA_123456';
const url = 'https://sitio.example/ruta';
const email = Buffer.from([
  'From: remitente@ejemplo.example',
  'To: persona@ejemplo.example',
  'Subject: Ejemplo sintético',
  'Date: Tue, 24 Nov 2026 10:00:00 +0000',
  'Message-ID: <reputation-test@ejemplo.invalid>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `Consulta ${url}`,
  '',
].join('\r\n'));
const report = (malicious: number) => new Response(JSON.stringify({
  data: { attributes: {
    last_analysis_date: 1_700_000_000,
    last_analysis_stats: { malicious, harmless: 5, suspicious: 0, undetected: 3, timeout: 0 },
  } },
}));

beforeEach(async () => {
  await limpiarBase();
  await db.reputationCache.deleteMany();
  await db.reputationQuota.deleteMany();
});
afterAll(async () => { await db.$disconnect(); });

function deps(storage: QueueDeps['storage'], fetchFn: typeof fetch, key?: string) {
  const lines: string[] = [];
  const logger = createLogger('info', { write: (line: string) => void lines.push(line) }, 'test');
  return {
    lines,
    settings: {
      db, storage, logger, institutionalDomains: [] as string[], leaseSeconds: 60, maxAttempts: 3,
      scan: { host: '127.0.0.1', port: 1, timeoutMs: 500, totalBudgetMs: 1000, maxScanBytes: 1_000, maxScanned: 1 },
      virusTotalApiKey: key, reputationFetchFn: fetchFn,
    } satisfies QueueDeps,
  };
}

async function upload(app: Parameters<typeof request>[0], cookie: string, csrf: string) {
  const res = await request(app).post('/api/v1/reports').set('Cookie', cookie).set('X-CSRF-Token', csrf)
    .attach('file', email, { filename: 'sintetico.eml' });
  expect(res.status).toBe(202);
  return ReportSummary.parse(res.body).id;
}

describe('worker y reputación externa simulada', () => {
  it('marca informe existente, conserva caché entre reportes y nunca muestra URL ni clave crudas', async () => {
    const { app, storage } = crearApp();
    const user = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const fetchFn = vi.fn(async () => report(3)) as unknown as typeof fetch;
    const { settings, lines } = deps(storage, fetchFn, KEY);
    const first = await upload(app, user.cookie, user.csrf);
    expect(await processNext(settings)).toBe('done');
    const detail = ReportDetail.parse((await request(app).get(`/api/v1/reports/${first}`).set('Cookie', user.cookie)).body);
    expect(detail.status).toBe('completed');
    expect(detail.priority).toBe('high');
    expect(detail.reputation).toMatchObject({ status: 'checked', items: [{ displayUrl: 'hxxps://sitio[.]example/ruta', state: 'reported', malicious: 3, total: 11 }] });
    const document = ReportDocument.parse((await request(app).get(`/api/v1/reports/${first}/report`).set('Cookie', user.cookie)).body);
    expect(document.findings.some((f) => f.ruleId === 'R10' && f.evidence.some((e) => e.value === '3 de 11'))).toBe(true);
    expect(JSON.stringify(document)).not.toContain(url);
    expect(lines.join('')).not.toContain(url);
    expect(lines.join('')).not.toContain(KEY);

    const second = await upload(app, user.cookie, user.csrf);
    expect(await processNext(settings)).toBe('done');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await db.report.findUniqueOrThrow({ where: { id: second } })).status).toBe('completed');
    expect((await db.reputationQuota.findUniqueOrThrow({ where: { id: 1 } })).used).toBe(1);
  });

  it.each([
    [404, 'no_data', 'checked'],
    [429, 'error', 'unavailable'],
  ] as const)('HTTP %i termina el reporte con estado %s', async (code, state, status) => {
    const { app, storage } = crearApp();
    const user = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await upload(app, user.cookie, user.csrf);
    const fetchFn = vi.fn(async () => new Response(null, { status: code })) as unknown as typeof fetch;
    expect(await processNext(deps(storage, fetchFn, KEY).settings)).toBe('done');
    const detail = ReportDetail.parse((await request(app).get(`/api/v1/reports/${id}`).set('Cookie', user.cookie)).body);
    expect(detail.status).toBe('completed');
    expect(detail.reputation).toMatchObject({ status, items: [{ state }] });
    const document = ReportDocument.parse((await request(app).get(`/api/v1/reports/${id}/report`).set('Cookie', user.cookie)).body);
    expect(document.notes.some((note) => note.kind === 'reputation_unavailable')).toBe(code === 429);
  });

  it('sin clave no se reserva cuota ni se llama a la red; con excepción termina completed', async () => {
    const { app, storage } = crearApp();
    const user = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const fetchFn = vi.fn(async () => { throw new Error('MARCADOR_ERROR_INTERNO'); }) as unknown as typeof fetch;
    const first = await upload(app, user.cookie, user.csrf);
    expect(await processNext(deps(storage, fetchFn).settings)).toBe('done');
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await db.report.findUniqueOrThrow({ where: { id: first } })).reputation).toMatchObject({ status: 'not_configured' });
    expect(await db.reputationQuota.count()).toBe(0);

    const second = await upload(app, user.cookie, user.csrf);
    const { settings, lines } = deps(storage, fetchFn, KEY);
    expect(await processNext(settings)).toBe('done');
    expect((await db.report.findUniqueOrThrow({ where: { id: second } })).reputation).toMatchObject({ status: 'unavailable' });
    expect(lines.join('')).not.toContain('MARCADOR_ERROR_INTERNO');
    expect(lines.join('')).not.toContain(KEY);
  });

  it('un dominio institucional nunca se consulta aunque la fuente esté configurada', async () => {
    const { app, storage } = crearApp();
    const user = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await upload(app, user.cookie, user.csrf);
    const fetchFn = vi.fn(async () => report(3)) as unknown as typeof fetch;
    const { settings } = deps(storage, fetchFn, KEY);
    settings.institutionalDomains = ['sitio.example'];
    expect(await processNext(settings)).toBe('done');
    const detail = ReportDetail.parse((await request(app).get(`/api/v1/reports/${id}`).set('Cookie', user.cookie)).body);
    expect(detail.reputation).toEqual({ status: 'checked', items: [] });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await db.reputationQuota.count()).toBe(0);
  });
});
