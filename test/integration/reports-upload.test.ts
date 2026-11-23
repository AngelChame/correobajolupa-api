import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { ReportSummary } from '../../src/contract/schemas/reports.js';
import { archivosEn, crearApp, db, entrarComo, limpiarBase } from './support.js';

// POST /reports (subida de .eml). Correos de test/fixtures/ (sintéticos).
const L03 = readFileSync(new URL('../fixtures/emails/L03-texto-plano-simple.eml', import.meta.url));
// Sin campos de más: storageKey, sha256 o la cola nunca salen en la respuesta.
const Summary = z.strictObject(ReportSummary.shape);

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(limpiarBase);

function subir(app: Parameters<typeof request>[0], s: { cookie: string; csrf: string }) {
  return request(app).post('/api/v1/reports').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
}

/** Error con la forma del contrato y en JSON (nunca el HTML o texto por defecto). */
function esError(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
  expect(ErrorResponse.parse(res.body).code).toBe(code);
}

describe('POST /reports: 202', () => {
  it('guarda el .eml, crea el reporte en cola y responde ReportSummary', async () => {
    const { app, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');

    const res = await subir(app, ana).attach('file', L03, { filename: 'correo.eml', contentType: 'message/rfc822' });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const resumen = Summary.parse(res.body);
    expect(resumen).toMatchObject({ status: 'queued', source: 'eml', findingsCount: 0, priority: null, subject: null, fromAddress: null });

    const fila = await db.report.findUniqueOrThrow({ where: { id: resumen.id } });
    expect(fila.userId).toBe(ana.userId);
    expect(fila.sizeBytes).toBe(L03.byteLength);
    expect(fila.sha256).toBe(createHash('sha256').update(L03).digest('hex'));
    // Los bytes se guardan tal cual (CRLF incluido) en la carpeta del reporte.
    expect(archivosEn(storageDir)).toEqual([fila.storageKey]);
    expect(readFileSync(`${storageDir}/${fila.storageKey}`).equals(L03)).toBe(true);

    const evento = await db.auditEvent.findFirstOrThrow({ where: { action: 'report.create' } });
    expect(evento).toMatchObject({ actorId: ana.userId, targetType: 'report', targetId: resumen.id, result: 'success' });
    expect(evento.requestId).toBe(res.headers['x-request-id']);
  });

  it('acepta application/octet-stream si el nombre es .eml, y message/rfc822 con otro nombre', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const a = await subir(app, ana).attach('file', L03, { filename: 'Correo.EML', contentType: 'application/octet-stream' });
    const b = await subir(app, ana).attach('file', L03, { filename: 'mensaje', contentType: 'message/rfc822' });
    expect([a.status, b.status]).toEqual([202, 202]);
  });
});

describe('POST /reports: errores con la forma del contrato y sin dejar nada', () => {
  it('415 si no es .eml (también octet-stream con otro nombre)', async () => {
    const { app, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    esError(await subir(app, ana).attach('file', L03, { filename: 'nota.txt', contentType: 'text/plain' }), 415, 'unsupported_media_type');
    esError(
      await subir(app, ana).attach('file', L03, { filename: 'factura.pdf', contentType: 'application/octet-stream' }),
      415,
      'unsupported_media_type',
    );
    expect(archivosEn(storageDir)).toEqual([]);
    expect(await db.report.count()).toBe(0);
  });

  it('413 si supera MAX_EML_BYTES', async () => {
    const { app, storageDir } = crearApp({ MAX_EML_BYTES: '100' });
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    esError(await subir(app, ana).attach('file', L03, { filename: 'correo.eml' }), 413, 'payload_too_large');
    expect(archivosEn(storageDir)).toEqual([]);
    expect(await db.report.count()).toBe(0);
  });

  it('400 sin archivo, con otro campo, con dos archivos o con campos de texto de más', async () => {
    const { app, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const casos = [
      subir(app, ana).send({ file: 'no es multipart' }),
      subir(app, ana).field('nota', 'sin archivo'),
      subir(app, ana).attach('adjunto', L03, { filename: 'correo.eml' }),
      subir(app, ana).attach('file', L03, { filename: 'a.eml' }).attach('file', L03, { filename: 'b.eml' }),
      subir(app, ana).field('extra', 'x').attach('file', L03, { filename: 'correo.eml' }),
      subir(app, ana).set('Content-Type', 'multipart/form-data; boundary=xyz').send('--xyz\r\nroto'),
    ];
    for (const res of await Promise.all(casos)) {
      esError(res, 400, 'validation_error');
    }
    expect(archivosEn(storageDir)).toEqual([]);
    expect(await db.report.count()).toBe(0);
  });

  it('401 sin sesión y 403 sin token CSRF, sin leer el archivo', async () => {
    const { app, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    esError(await request(app).post('/api/v1/reports').attach('file', L03, { filename: 'correo.eml' }), 401, 'unauthenticated');
    esError(
      await request(app).post('/api/v1/reports').set('Cookie', ana.cookie).attach('file', L03, { filename: 'correo.eml' }),
      403,
      'forbidden',
    );
    expect(archivosEn(storageDir)).toEqual([]);
  });
});

describe('POST /reports: cuota por cuenta (REPORTS_PER_USER_PER_HOUR)', () => {
  it('pasada la cuota responde 429 rate_limited; otra cuenta sigue pudiendo', async () => {
    const { app, storageDir } = crearApp({ REPORTS_PER_USER_PER_HOUR: '2' });
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const luis = await entrarComo(app, 'reporter', 'luis@ejemplo.invalid');
    const adjuntar = (s: typeof ana) => subir(app, s).attach('file', L03, { filename: 'correo.eml' });

    expect((await adjuntar(ana)).status).toBe(202);
    expect((await adjuntar(ana)).status).toBe(202);
    esError(await adjuntar(ana), 429, 'rate_limited');
    expect((await adjuntar(luis)).status).toBe(202);

    expect(await db.report.count({ where: { userId: ana.userId } })).toBe(2);
    expect(archivosEn(storageDir)).toHaveLength(3);
  });

  it('la cuenta en la base: con reportes de hace más de una hora no cuenta', async () => {
    const { app } = crearApp({ REPORTS_PER_USER_PER_HOUR: '1' });
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    expect((await subir(app, ana).attach('file', L03, { filename: 'correo.eml' })).status).toBe(202);
    await db.$executeRaw`UPDATE reports SET created_at = now() - interval '61 minutes'`;
    expect((await subir(app, ana).attach('file', L03, { filename: 'correo.eml' })).status).toBe(202);
  });
});
