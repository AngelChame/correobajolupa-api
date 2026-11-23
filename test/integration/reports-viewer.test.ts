import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorResponse } from '../../src/contract/schemas/common.js';
import { ReportSummary } from '../../src/contract/schemas/reports.js';
import { crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// GET /reports/{id}/html y /text (D-035). Correos sintéticos de test/fixtures/.
const fixture = (nombre: string) => readFileSync(new URL(`../fixtures/emails/${nombre}.eml`, import.meta.url));

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(limpiarBase);

type App = Parameters<typeof request>[0];

/** Sube un .eml y, si se pide, lo marca como analizado (el worker tiene sus propias pruebas). */
async function subir(app: App, s: Sesion, eml: Buffer, analizado = true): Promise<string> {
  const res = await request(app).post('/api/v1/reports').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).attach('file', eml, { filename: 'correo.eml' });
  expect(res.status).toBe(202);
  const id = ReportSummary.parse(res.body).id;
  if (analizado) await db.report.update({ where: { id }, data: { status: 'completed' } });
  return id;
}

function esError(res: request.Response, status: number, code: string) {
  expect(res.status, res.text.slice(0, 200)).toBe(status);
  expect(ErrorResponse.parse(res.body).code).toBe(code);
}

describe('GET /reports/{id}/html', () => {
  it('responde el HTML saneado con las cabeceras exactas del visor y sin X-Frame-Options', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, fixture('H01-html-hostil'));

    const res = await request(app).get(`/api/v1/reports/${id}/html`).set('Cookie', ana.cookie);

    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.text).toContain('Texto visible legítimo.');
    expect(res.text).not.toMatch(/<script|onerror|href=|203\.0\.113\.45\/track/i);
  });

  it('las demás rutas conservan la CSP global y X-Frame-Options DENY', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, fixture('H01-html-hostil'));
    const res = await request(app).get(`/api/v1/reports/${id}`).set('Cookie', ana.cookie);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
  });

  it('409 report_not_ready mientras está en cola o en proceso', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, fixture('H01-html-hostil'), false);
    esError(await request(app).get(`/api/v1/reports/${id}/html`).set('Cookie', ana.cookie), 409, 'report_not_ready');
    esError(await request(app).get(`/api/v1/reports/${id}/text`).set('Cookie', ana.cookie), 409, 'report_not_ready');
    await db.report.update({ where: { id }, data: { status: 'processing' } });
    esError(await request(app).get(`/api/v1/reports/${id}/html`).set('Cookie', ana.cookie), 409, 'report_not_ready');
  });

  it('404 sin parte HTML, para un reporte ajeno y con un id que no es UUID', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const luis = await entrarComo(app, 'reporter', 'luis@ejemplo.invalid');
    const soloTexto = await subir(app, ana, fixture('L03-texto-plano-simple'));
    const deLuis = await subir(app, luis, fixture('H01-html-hostil'));

    esError(await request(app).get(`/api/v1/reports/${soloTexto}/html`).set('Cookie', ana.cookie), 404, 'not_found');
    for (const ruta of [`${deLuis}/html`, `${deLuis}/text`, 'no-es-uuid/html', 'no-es-uuid/text']) {
      esError(await request(app).get(`/api/v1/reports/${ruta}`).set('Cookie', ana.cookie), 404, 'not_found');
    }
  });

  it('401 sin sesión', async () => {
    const { app } = crearApp();
    esError(await request(app).get(`/api/v1/reports/${crypto.randomUUID()}/html`), 401, 'unauthenticated');
    esError(await request(app).get(`/api/v1/reports/${crypto.randomUUID()}/text`), 401, 'unauthenticated');
  });
});

describe('GET /reports/{id}/text', () => {
  it('texto plano con las URL desactivadas y cabeceras nosniff, no-store y CSP default-src none', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const conTexto = await subir(app, ana, fixture('L01-boletin-legitimo'));
    const soloHtml = await subir(app, ana, fixture('C1-combinado-reglas-1-2-5'));

    const res = await request(app).get(`/api/v1/reports/${conTexto}/text`).set('Cookie', ana.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toMatch(/^default-src 'none'/);
    expect(res.text).toContain('hxxps://boletin-ejemplo[.]example/noviembre');

    const derivado = await request(app).get(`/api/v1/reports/${soloHtml}/text`).set('Cookie', ana.cookie);
    expect(derivado.status).toBe(200);
    for (const r of [res, derivado]) expect(r.text).not.toMatch(/https?:\/\/|www\.[a-z]/i);
  });

  it('un texto pegado sin encabezados devuelve el texto completo, desactivado', async () => {
    const { app } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const T03 = readFileSync(new URL('../fixtures/paste/T03-pegado-cuerpo-con-ip.txt', import.meta.url), 'utf8');
    const pegado = await request(app).post('/api/v1/reports/paste').set('Cookie', ana.cookie).set('X-CSRF-Token', ana.csrf).send({ text: T03 });
    const id = ReportSummary.parse(pegado.body).id;
    await db.report.update({ where: { id }, data: { status: 'limited', limitedReason: 'missing_headers' } });

    const res = await request(app).get(`/api/v1/reports/${id}/text`).set('Cookie', ana.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Estimado usuario:');
    expect(res.text).toContain('hxxp://203[.]0[.]113[.]45/aduana/liberar');
  });
});

describe('registros del visor', () => {
  it('no llevan nada del correo', async () => {
    const { app, lineas } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const original = readFileSync(new URL('../fixtures/emails/C1-combinado-reglas-1-2-5.eml', import.meta.url), 'latin1');
    const eml = Buffer.from(original.replace('cuenta suspendida', 'MARCADOR_ASUNTO_VISOR').replace('</p>', 'MARCADOR_CUERPO_VISOR</p>'), 'latin1');
    const id = await subir(app, ana, eml);
    await request(app).get(`/api/v1/reports/${id}/html`).set('Cookie', ana.cookie);
    await request(app).get(`/api/v1/reports/${id}/text`).set('Cookie', ana.cookie);
    const registros = lineas.join('\n');
    expect(registros).toContain(`/api/v1/reports/${id}/html`);
    expect(registros).not.toMatch(/MARCADOR_|banco-ejemplo|203\.0\.113/);
  });
});
