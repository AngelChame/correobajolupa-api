import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { FindingList, ReportDetail, ReportList, ReportSummary } from '../../src/contract/schemas/reports.js';
import type { ReportStatus } from '../../src/generated/prisma/enums.js';
import { crearApp, db, entrarComo, limpiarBase } from './support.js';

// GET /reports, /reports/{id} y /reports/{id}/findings. Filas sintéticas creadas en la base
// (el análisis llega en el paso 3); ningún contenido de correo real.

const Detail = z.strictObject(ReportDetail.shape);
const List = z.strictObject({ ...ReportList.shape, items: z.array(z.strictObject(ReportSummary.shape)) });

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(limpiarBase);

function reporte(userId: string, extra: { status?: ReportStatus; limitedReason?: 'parse_error' } = {}) {
  return db.report.create({
    data: { userId, source: 'eml', storageKey: 'clave-sintetica', sizeBytes: 1, sha256: 'b'.repeat(64), ...extra },
  });
}

function esError(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ErrorResponse.parse(res.body).code).toBe(code);
}

describe('GET /reports', () => {
  it('el reportante ve solo los suyos; analista y administrador ven todos', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const luis = await entrarComo(app, 'reporter', 'luis@ejemplo.invalid');
    const analista = await entrarComo(app, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const deAna = await reporte(ana.userId);
    await reporte(luis.userId);
    await reporte(luis.userId);

    const propia = List.parse((await request(app).get('/api/v1/reports').set('Cookie', ana.cookie)).body);
    expect(propia.total).toBe(1);
    expect(propia.items.map((r) => r.id)).toEqual([deAna.id]);

    for (const s of [analista, admin]) {
      const todas = List.parse((await request(app).get('/api/v1/reports').set('Cookie', s.cookie)).body);
      expect(todas.total).toBe(3);
    }
  });

  it('pagina en orden estable (createdAt desc, id desc) aunque la hora coincida', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    for (let i = 0; i < 5; i++) await reporte(ana.userId);
    await db.$executeRaw`UPDATE reports SET created_at = '2026-11-20T10:00:00Z'`;
    const nuevo = await reporte(ana.userId);

    const vistos: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await request(app).get(`/api/v1/reports?page=${page}&pageSize=2`).set('Cookie', ana.cookie);
      const lista = List.parse(res.body);
      expect(lista).toMatchObject({ page, pageSize: 2, total: 6 });
      vistos.push(...lista.items.map((r) => r.id));
    }
    const empatados = (await db.report.findMany({ where: { NOT: { id: nuevo.id } }, select: { id: true } }))
      .map((r) => r.id)
      .sort()
      .reverse();
    expect(vistos).toEqual([nuevo.id, ...empatados]);
  });

  it('filtra por estado y cuenta los hallazgos', async () => {
    const { app } = crearApp();
    const analista = await entrarComo(app, 'analyst', 'analista@ejemplo.invalid');
    const limitado = await reporte(analista.userId, { status: 'limited', limitedReason: 'parse_error' });
    await reporte(analista.userId);
    await db.finding.createMany({
      data: ['R1', 'R5'].map((ruleId) => ({
        reportId: limitado.id,
        ruleId: ruleId as 'R1' | 'R5',
        ruleName: 'Regla sintética',
        summary: 'Resumen sintético',
        evidence: [],
        rulesVersion: 'v-prueba',
      })),
    });

    const lista = List.parse((await request(app).get('/api/v1/reports?status=limited').set('Cookie', analista.cookie)).body);
    expect(lista.total).toBe(1);
    expect(lista.items[0]).toMatchObject({ id: limitado.id, status: 'limited', findingsCount: 2 });
  });

  it('400 validation_error con estado o paginación inválidos (contrato 0.2.1)', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    for (const q of ['status=terminado', 'pageSize=500', 'page=0', 'page=uno']) {
      esError(await request(app).get(`/api/v1/reports?${q}`).set('Cookie', ana.cookie), 400, 'validation_error');
    }
  });

  it('401 sin sesión', async () => {
    const { app } = crearApp();
    esError(await request(app).get('/api/v1/reports'), 401, 'unauthenticated');
  });
});

describe('GET /reports/{reportId} y /findings', () => {
  it('devuelve ReportDetail con los enlaces en orden y FindingList con la evidencia', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const r = await reporte(ana.userId);
    await db.reportLink.createMany({
      data: [
        { reportId: r.id, position: 1, displayText: null, normalizedUrl: 'http://203.0.113.45/', defangedUrl: 'hxxp://203[.]0[.]113[.]45/', domain: null },
        { reportId: r.id, position: 0, displayText: 'Portal', normalizedUrl: 'https://sitio.example/', defangedUrl: 'hxxps://sitio[.]example/', domain: 'sitio.example' },
      ],
    });
    await db.finding.create({
      data: {
        reportId: r.id,
        ruleId: 'R5',
        ruleName: 'Destino como dirección IP',
        summary: 'Resumen sintético',
        evidence: [{ label: 'Destino', value: 'hxxp://203[.]0[.]113[.]45/' }],
        rulesVersion: 'v-prueba',
      },
    });

    const detalle = Detail.parse((await request(app).get(`/api/v1/reports/${r.id}`).set('Cookie', ana.cookie)).body);
    expect(detalle).toMatchObject({ id: r.id, status: 'queued', findingsCount: 1, limitedReason: null, authentication: null, hasHtml: false });
    expect(detalle.links.map((l) => l.displayText)).toEqual(['Portal', null]);

    const res = await request(app).get(`/api/v1/reports/${r.id}/findings`).set('Cookie', ana.cookie);
    const hallazgos = FindingList.parse(res.body);
    expect(hallazgos.items).toHaveLength(1);
    expect(hallazgos.items[0]).toMatchObject({ ruleId: 'R5', evidence: [{ label: 'Destino', value: 'hxxp://203[.]0[.]113[.]45/' }] });
  });

  it('un reporte ajeno para un reportante, un id inexistente o no UUID: 404 not_found', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const luis = await entrarComo(app, 'reporter', 'luis@ejemplo.invalid');
    const analista = await entrarComo(app, 'analyst', 'analista@ejemplo.invalid');
    const deLuis = await reporte(luis.userId);

    for (const ruta of [deLuis.id, crypto.randomUUID(), 'no-es-uuid', '..%2F..%2Fetc']) {
      esError(await request(app).get(`/api/v1/reports/${ruta}`).set('Cookie', ana.cookie), 404, 'not_found');
      esError(await request(app).get(`/api/v1/reports/${ruta}/findings`).set('Cookie', ana.cookie), 404, 'not_found');
    }
    // El analista sí lo ve.
    expect((await request(app).get(`/api/v1/reports/${deLuis.id}`).set('Cookie', analista.cookie)).status).toBe(200);
    expect((await request(app).get(`/api/v1/reports/${deLuis.id}/findings`).set('Cookie', analista.cookie)).status).toBe(200);
  });

  it('401 sin sesión', async () => {
    const { app } = crearApp();
    esError(await request(app).get(`/api/v1/reports/${crypto.randomUUID()}`), 401, 'unauthenticated');
  });
});
