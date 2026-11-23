import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Attachment, AttachmentList } from '../../src/contract/schemas/attachments.js';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import type { ReportStatus } from '../../src/generated/prisma/enums.js';
import { crearApp, db, entrarComo, limpiarBase } from './support.js';

// GET /reports/{id}/attachments (M2). Filas sintéticas en la base; ningún adjunto real.
const List = z.strictObject({ items: z.array(z.strictObject(Attachment.shape)) });

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(limpiarBase);

function reporte(userId: string, status: ReportStatus = 'completed') {
  return db.report.create({
    data: { userId, source: 'eml', storageKey: 'clave-sintetica', sizeBytes: 1, sha256: 'b'.repeat(64), status, priority: status === 'completed' ? 'low' : null },
  });
}

function adjunto(reportId: string, position: number, extra: Record<string, unknown> = {}) {
  return db.attachment.create({
    data: { reportId, position, fileName: `archivo-${position}.pdf`, sizeBytes: 10 + position, sha256: String(position).repeat(64).slice(0, 64), scanStatus: 'not_detected', ...extra },
  });
}

function esError(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ErrorResponse.parse(res.body).code).toBe(code);
}

describe('GET /reports/{reportId}/attachments', () => {
  it('devuelve los adjuntos en orden, con el contrato exacto y sin contenido', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const r = await reporte(ana.userId);
    await adjunto(r.id, 1, { scanStatus: 'error', scanDetail: 'tiempo de escaneo agotado' });
    const fecha = new Date('2026-11-23T10:00:00.000Z');
    await adjunto(r.id, 0, { declaredType: 'application/pdf', detectedType: 'application/pdf', scannedAt: fecha });

    const res = await request(app).get(`/api/v1/reports/${r.id}/attachments`).set('Cookie', ana.cookie);
    expect(res.status).toBe(200);
    const lista = List.parse(res.body);
    AttachmentList.parse(res.body);
    expect(lista.items.map((a) => a.fileName)).toEqual(['archivo-0.pdf', 'archivo-1.pdf']);
    expect(lista.items[0]).toMatchObject({ declaredType: 'application/pdf', detectedType: 'application/pdf', scanStatus: 'not_detected', scannedAt: fecha.toISOString() });
    expect(lista.items[1]).toMatchObject({ scanStatus: 'error', scanDetail: 'tiempo de escaneo agotado', scannedAt: null });
  });

  it('analista y administrador ven los ajenos; otro reportante recibe 404', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const luis = await entrarComo(app, 'reporter', 'luis@ejemplo.invalid');
    const analista = await entrarComo(app, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const r = await reporte(ana.userId);
    await adjunto(r.id, 0);

    for (const s of [analista, admin]) {
      expect(List.parse((await request(app).get(`/api/v1/reports/${r.id}/attachments`).set('Cookie', s.cookie)).body).items).toHaveLength(1);
    }
    esError(await request(app).get(`/api/v1/reports/${r.id}/attachments`).set('Cookie', luis.cookie), 404, 'not_found');
  });

  it('404 con un ID que no es UUID o que no existe; 401 sin sesión', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    esError(await request(app).get('/api/v1/reports/no-es-uuid/attachments').set('Cookie', ana.cookie), 404, 'not_found');
    esError(await request(app).get(`/api/v1/reports/${crypto.randomUUID()}/attachments`).set('Cookie', ana.cookie), 404, 'not_found');
    esError(await request(app).get(`/api/v1/reports/${crypto.randomUUID()}/attachments`), 401, 'unauthenticated');
  });

  it('409 report_not_ready mientras está queued o processing', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    for (const status of ['queued', 'processing'] as const) {
      const r = await reporte(ana.userId, status);
      esError(await request(app).get(`/api/v1/reports/${r.id}/attachments`).set('Cookie', ana.cookie), 409, 'report_not_ready');
    }
  });

  it('un reporte failed responde 200 con lista vacía', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const r = await reporte(ana.userId, 'failed');
    const res = await request(app).get(`/api/v1/reports/${r.id}/attachments`).set('Cookie', ana.cookie);
    expect(res.status).toBe(200);
    expect(List.parse(res.body).items).toEqual([]);
  });
});
