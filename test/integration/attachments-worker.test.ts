import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentList } from '../../src/contract/schemas/attachments.js';
import { ReportDetail, ReportSummary } from '../../src/contract/schemas/reports.js';
import { createLogger } from '../../src/logger.js';
import { processNext, type QueueDeps } from '../../src/queue/process.js';
import type { ReportStorage } from '../../src/storage/storage.js';
import { correoConAdjuntos } from '../correo-adjuntos.js';
import { eicar, esEicar } from '../eicar.js';
import { startFakeClamd, type FakeClamd } from '../fake-clamd.js';
import { archivosEn, crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Adjuntos de punta a punta contra PostgreSQL real (P-04, P-05, P-06, P-21) con un clamd falso.
// EICAR se arma al ejecutar (test/eicar.ts); ningún binario real en el repositorio.
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type App = Parameters<typeof request>[0];

let fake: FakeClamd | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(limpiarBase);

async function subir(app: App, s: Sesion, eml: Buffer): Promise<string> {
  const res = await request(app).post('/api/v1/reports').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).attach('file', eml, { filename: 'correo.eml' });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return ReportSummary.parse(res.body).id;
}

/** Deps del worker con ClamAV en `port` (por defecto, el clamd falso). */
function deps(storage: ReportStorage, port: number) {
  const lineas: string[] = [];
  const logger = createLogger('info', { write: (l: string) => void lineas.push(l) }, 'worker');
  const scan = { host: '127.0.0.1', port, timeoutMs: 2000, totalBudgetMs: 5000, maxScanBytes: 1024 * 1024, maxScanned: 20 };
  const d: QueueDeps = { db, storage, logger, institutionalDomains: [], leaseSeconds: 60, maxAttempts: 3, scan };
  return { d, lineas };
}

async function adjuntos(app: App, s: Sesion, id: string) {
  const res = await request(app).get(`/api/v1/reports/${id}/attachments`).set('Cookie', s.cookie);
  expect(res.status).toBe(200);
  return AttachmentList.parse(res.body).items;
}

/** Un puerto donde nadie escucha (se abre y se cierra un clamd falso). */
async function puertoCerrado(): Promise<number> {
  const f = await startFakeClamd({ kind: 'text', text: 'stream: OK' });
  await f.close();
  return f.port;
}

describe('worker con adjuntos', () => {
  it('P-04: EICAR detectado → detected con la firma y prioridad high; registros sin nombre, firma ni hash', async () => {
    fake = await startFakeClamd((content) => ({ kind: 'text', text: esEicar(content) ? 'stream: Eicar-Test-Signature FOUND' : 'stream: OK' }));
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const prueba = eicar();
    const id = await subir(
      app,
      ana,
      correoConAdjuntos([
        { name: 'prueba-eicar.txt', type: 'text/plain', content: prueba },
        { name: 'nota.txt', type: 'text/plain', content: Buffer.from('nota sintética') },
      ]),
    );
    const { d, lineas } = deps(storage, fake.port);
    expect(await processNext(d)).toBe('done');

    const items = await adjuntos(app, ana, id);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ fileName: 'prueba-eicar.txt', sha256: sha(prueba), sizeBytes: prueba.length, scanStatus: 'detected', scanDetail: 'Eicar-Test-Signature' });
    expect(items[0]!.scannedAt).not.toBeNull();
    expect(items[1]).toMatchObject({ scanStatus: 'not_detected', scanDetail: null });

    const detalle = ReportDetail.parse((await request(app).get(`/api/v1/reports/${id}`).set('Cookie', ana.cookie)).body);
    expect(detalle).toMatchObject({ status: 'completed', priority: 'high', findingsCount: 0 });

    const registros = lineas.join('\n');
    expect(registros).toContain('"detected":1');
    expect(registros).not.toMatch(/prueba-eicar|nota\.txt|Eicar-Test-Signature|EICAR/);
    expect(registros).not.toContain(sha(prueba));
  });

  it('P-05: ClamAV inalcanzable → adjunto en error (nunca limpio) y el reporte queda completed', async () => {
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, correoConAdjuntos([{ name: 'documento.pdf', type: 'application/pdf', content: Buffer.from('%PDF-1.4\n') }]));
    expect(await processNext(deps(storage, await puertoCerrado()).d)).toBe('done');

    const items = await adjuntos(app, ana, id);
    expect(items).toEqual([expect.objectContaining({ scanStatus: 'error', scannedAt: null })]);
    expect(items[0]!.scanDetail).not.toBeNull();
    expect(await db.report.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'completed', priority: 'low' });
  });

  it('P-06: un .zip de apariencia hostil no se descomprime: un solo adjunto con su hash y su estado', async () => {
    fake = await startFakeClamd({ kind: 'text', text: 'stream: OK' });
    const { app, storage, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    // Cabecera ZIP con una entrada llamada "../../fuera.exe" (sintética, no es un ZIP válido entero).
    const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(26), Buffer.from('../../fuera.exe MZ contenido sintético', 'latin1')]);
    const id = await subir(app, ana, correoConAdjuntos([{ name: 'facturas.zip', type: 'application/zip', content: zip }]));
    expect(await processNext(deps(storage, fake.port).d)).toBe('done');

    expect(await adjuntos(app, ana, id)).toEqual([
      expect.objectContaining({ fileName: 'facturas.zip', detectedType: 'application/zip', sha256: sha(zip), sizeBytes: zip.length, scanStatus: 'not_detected' }),
    ]);
    // ClamAV recibió el ZIP tal cual, y en disco solo está el .eml original.
    expect(fake.received.map((r) => r.content.equals(zip))).toEqual([true]);
    expect(archivosEn(storageDir)).toHaveLength(1);
    expect(archivosEn(storageDir)[0]).toMatch(new RegExp(`^${id}/[0-9a-f]{32}$`));
  });

  it('un nombre con ../ o con U+202E no escribe nada fuera del volumen y se guarda saneado', async () => {
    fake = await startFakeClamd({ kind: 'text', text: 'stream: OK' });
    const { app, storage, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const antes = readdirSync(dirname(storageDir)).sort();
    const id = await subir(
      app,
      ana,
      correoConAdjuntos([
        { name: '../../../fuera-del-volumen.txt', type: 'text/plain', content: Buffer.from('uno') },
        { name: 'factura\u202Efdp.exe', type: 'application/octet-stream', content: Buffer.from('MZ sintético', 'latin1') },
      ]),
    );
    expect(await processNext(deps(storage, fake.port).d)).toBe('done');

    expect((await adjuntos(app, ana, id)).map((a) => a.fileName)).toEqual(['../../../fuera-del-volumen.txt', 'factura[U+202E]fdp.exe']);
    expect(archivosEn(storageDir)).toHaveLength(1);
    expect(readdirSync(dirname(storageDir)).sort()).toEqual(antes);
    // U+202E dispara R7 con el nombre escapado en la evidencia.
    const r7 = await db.finding.findFirstOrThrow({ where: { reportId: id, ruleId: 'R7' } });
    expect(JSON.stringify(r7.evidence)).toContain('factura[U+202E]fdp.exe');
  });

  it('el reanálisis no duplica adjuntos y el borrado del reporte los borra (P-21)', async () => {
    fake = await startFakeClamd({ kind: 'text', text: 'stream: OK' });
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const id = await subir(app, ana, correoConAdjuntos([{ name: 'a.txt', type: 'text/plain', content: Buffer.from('a') }, { name: 'b.txt', type: 'text/plain', content: Buffer.from('b') }]));
    const { d } = deps(storage, fake.port);
    expect(await processNext(d)).toBe('done');
    await db.report.update({ where: { id }, data: { status: 'queued' } });
    expect(await processNext(d)).toBe('done');
    expect(await db.attachment.count({ where: { reportId: id } })).toBe(2);

    const res = await request(app).delete(`/api/v1/reports/${id}`).set('Cookie', ana.cookie).set('X-CSRF-Token', ana.csrf);
    expect(res.status).toBe(204);
    expect(await db.attachment.count({ where: { reportId: id } })).toBe(0);
  });
});
