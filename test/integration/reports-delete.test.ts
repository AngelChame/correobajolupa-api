import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { ReportSummary } from '../../src/contract/schemas/reports.js';
import { createDiskStorage } from '../../src/storage/disk.js';
import { archivosEn, crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// DELETE /reports/{reportId}. Los reportes se crean subiendo un .eml sintético de fixtures.
const L03 = readFileSync(new URL('../fixtures/emails/L03-texto-plano-simple.eml', import.meta.url));

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(limpiarBase);

async function subir(app: Parameters<typeof request>[0], s: Sesion): Promise<string> {
  const res = await request(app)
    .post('/api/v1/reports')
    .set('Cookie', s.cookie)
    .set('X-CSRF-Token', s.csrf)
    .attach('file', L03, { filename: 'correo.eml' });
  expect(res.status).toBe(202);
  const id = ReportSummary.parse(res.body).id;
  // Un hallazgo y un enlace para comprobar la cascada.
  await db.finding.create({
    data: { reportId: id, ruleId: 'R1', ruleName: 'Regla sintética', summary: 'Resumen', evidence: [], rulesVersion: 'v-prueba' },
  });
  await db.reportLink.create({
    data: { reportId: id, position: 0, normalizedUrl: 'https://sitio.example/', defangedUrl: 'hxxps://sitio[.]example/' },
  });
  return id;
}

function borrar(app: Parameters<typeof request>[0], s: Sesion, id: string) {
  return request(app).delete(`/api/v1/reports/${id}`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
}

function esError(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ErrorResponse.parse(res.body).code).toBe(code);
}

describe('DELETE /reports/{reportId}', () => {
  it('el reportante borra el suyo: 204 y no queda nada en la base ni en el disco', async () => {
    const { app, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana);
    expect(archivosEn(storageDir)).toHaveLength(1);

    const res = await borrar(app, ana, id);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await db.report.count()).toBe(0);
    expect(await db.finding.count()).toBe(0);
    expect(await db.reportLink.count()).toBe(0);
    expect(archivosEn(storageDir)).toEqual([]);
    const evento = await db.auditEvent.findFirstOrThrow({ where: { action: 'report.delete' } });
    expect(evento).toMatchObject({ actorId: ana.userId, targetType: 'report', targetId: id, result: 'success', metadata: { ownerId: ana.userId } });
    // Ya no existe.
    esError(await borrar(app, ana, id), 404, 'not_found');
  });

  it('un reportante no borra uno ajeno (404); el analista y el administrador sí', async () => {
    const { app, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const luis = await entrarComo(app, 'reporter', 'luis@ejemplo.invalid');
    const analista = await entrarComo(app, 'analyst', 'analista@ejemplo.invalid');
    const admin = await entrarComo(app, 'admin', 'admin@ejemplo.invalid');
    const a = await subir(app, luis);
    const b = await subir(app, luis);

    esError(await borrar(app, ana, a), 404, 'not_found');
    expect(await db.report.count()).toBe(2);

    expect((await borrar(app, analista, a)).status).toBe(204);
    expect((await borrar(app, admin, b)).status).toBe(204);
    expect(await db.report.count()).toBe(0);
    expect(archivosEn(storageDir)).toEqual([]);
  });

  it('401 sin sesión y 403 sin token CSRF; el reporte sigue ahí', async () => {
    const { app, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana);
    esError(await request(app).delete(`/api/v1/reports/${id}`), 401, 'unauthenticated');
    esError(await request(app).delete(`/api/v1/reports/${id}`).set('Cookie', ana.cookie), 403, 'forbidden');
    expect(await db.report.count()).toBe(1);
    expect(archivosEn(storageDir)).toHaveLength(1);
  });

  it('un id que no es UUID da 404', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    esError(await borrar(app, ana, 'no-es-uuid'), 404, 'not_found');
  });

  it('si borrar la carpeta falla, responde 204 y registra el error solo con el ID', async () => {
    const { app: appSubida, storageDir } = crearApp();
    const ana = await entrarComo(appSubida, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(appSubida, ana);

    // Misma carpeta, pero deleteReport falla (por ejemplo, permisos del volumen).
    const real = createDiskStorage(storageDir);
    const fallaAlBorrar = { ...real, deleteReport: () => Promise.reject(Object.assign(new Error('fallo sintético'), { code: 'EACCES' })) };
    const { app, lineas } = crearApp({}, { storage: fallaAlBorrar });

    expect((await borrar(app, ana, id)).status).toBe(204);
    expect(await db.report.count()).toBe(0);
    const linea = lineas.find((l) => l.includes('no se pudo borrar la carpeta'));
    expect(linea).toBeDefined();
    expect(JSON.parse(linea!)).toMatchObject({ level: 50, reportId: id, errCode: 'EACCES' });
    expect(archivosEn(storageDir)).toHaveLength(1); // queda para la limpieza nocturna
  });
});
