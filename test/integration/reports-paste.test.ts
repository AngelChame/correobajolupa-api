import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { ReportSummary } from '../../src/contract/schemas/reports.js';
import { archivosEn, crearApp, db, entrarComo, limpiarBase } from './support.js';

// POST /reports/paste. Texto de test/fixtures/paste/ (sintético).
const T01 = readFileSync(new URL('../fixtures/paste/T01-pegado-con-encabezados.txt', import.meta.url), 'utf8');
const Summary = z.strictObject(ReportSummary.shape);

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(limpiarBase);

function pegar(app: Parameters<typeof request>[0], s: { cookie: string; csrf: string }, body: unknown) {
  return request(app).post('/api/v1/reports/paste').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body as object);
}

function esError(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
  expect(ErrorResponse.parse(res.body).code).toBe(code);
}

describe('POST /reports/paste', () => {
  it('202: guarda el texto como bytes UTF-8 con source paste', async () => {
    const { app, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');

    const res = await pegar(app, ana, { text: T01 });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const resumen = Summary.parse(res.body);
    expect(resumen).toMatchObject({ status: 'queued', source: 'paste', findingsCount: 0 });
    const fila = await db.report.findUniqueOrThrow({ where: { id: resumen.id } });
    expect(readFileSync(`${storageDir}/${fila.storageKey}`)).toEqual(Buffer.from(T01, 'utf8'));
    expect(fila.sizeBytes).toBe(Buffer.byteLength(T01, 'utf8'));
  });

  it('acepta 200 000 caracteres multibyte (más de 100 kb, menos de 1 MiB): usa su propio parser', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const text = 'ñ€'.repeat(100_000); // 200 000 caracteres, 500 000 bytes en UTF-8
    expect(text.length).toBe(200_000);

    const res = await pegar(app, ana, { text });

    expect(res.status).toBe(202);
    const fila = await db.report.findFirstOrThrow();
    expect(fila.sizeBytes).toBe(500_000);
  });

  it('413 payload_too_large en JSON si el cuerpo pasa de MAX_PASTE_BYTES', async () => {
    const { app, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    esError(await pegar(app, ana, { text: '€'.repeat(400_000) }), 413, 'payload_too_large'); // ~1,2 MB
    expect(archivosEn(storageDir)).toEqual([]);
  });

  it('el resto de la API sigue con el límite global de 100 kb', async () => {
    const { app } = crearApp();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ana@ejemplo.invalid', password: 'x'.repeat(150_000) });
    esError(res, 413, 'payload_too_large');
  });

  it('400 validation_error si falta el texto, está vacío o pasa de 200 000 caracteres', async () => {
    const { app, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    for (const body of [{}, { text: '' }, { text: 42 }, { text: 'a'.repeat(200_001) }]) {
      esError(await pegar(app, ana, body), 400, 'validation_error');
    }
    expect(archivosEn(storageDir)).toEqual([]);
    expect(await db.report.count()).toBe(0);
  });

  it('401 sin sesión y 403 sin token CSRF', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    esError(await request(app).post('/api/v1/reports/paste').send({ text: T01 }), 401, 'unauthenticated');
    esError(await request(app).post('/api/v1/reports/paste').set('Cookie', ana.cookie).send({ text: T01 }), 403, 'forbidden');
    expect(await db.report.count()).toBe(0);
  });

  it('comparte la cuota con las subidas de .eml', async () => {
    const { app } = crearApp({ REPORTS_PER_USER_PER_HOUR: '1' });
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    expect((await pegar(app, ana, { text: T01 })).status).toBe(202);
    esError(await pegar(app, ana, { text: T01 }), 429, 'rate_limited');
  });
});
