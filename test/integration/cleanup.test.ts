import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ReportSummary } from '../../src/contract/schemas/reports.js';
import { createLogger } from '../../src/logger.js';
import { runCleanup } from '../../src/queue/cleanup.js';
import type { ReportStorage } from '../../src/storage/storage.js';
import { archivosEn, crearApp, db, entrarComo, limpiarBase, type Sesion } from './support.js';

// Limpieza programada del worker (D-012, D-034, D-038). Datos sintéticos.
const L03 = readFileSync(new URL('../fixtures/emails/L03-texto-plano-simple.eml', import.meta.url));
const HACE_DOS_HORAS = new Date(Date.now() - 2 * 60 * 60 * 1000);

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(limpiarBase);

async function subir(app: Parameters<typeof request>[0], s: Sesion): Promise<string> {
  const res = await request(app).post('/api/v1/reports').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).attach('file', L03, { filename: 'correo.eml' });
  expect(res.status).toBe(202);
  return ReportSummary.parse(res.body).id;
}

function logger() {
  const lineas: string[] = [];
  return { lineas, log: createLogger('info', { write: (l: string) => void lineas.push(l) }, 'worker') };
}

describe('limpieza programada', () => {
  it('un reporte vencido desaparece de la base y del disco; uno vigente se queda', async () => {
    const { app, storage, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const vencido = await subir(app, ana);
    const vigente = await subir(app, ana);
    await db.finding.create({ data: { reportId: vencido, ruleId: 'R1', ruleName: 'x', summary: 'x', evidence: [], rulesVersion: 'v' } });
    await db.$executeRaw`UPDATE reports SET expires_at = now() - interval '1 minute' WHERE id = ${vencido}::uuid`;
    const { lineas, log } = logger();

    const counts = await runCleanup({ db, storage, logger: log });

    expect(counts).toMatchObject({ expiredReports: 1, folderErrors: 0 });
    expect((await db.report.findMany({ select: { id: true } })).map((r) => r.id)).toEqual([vigente]);
    expect(await db.finding.count()).toBe(0);
    expect(archivosEn(storageDir).map((k) => k.split('/')[0])).toEqual([vigente]);
    expect(lineas.join('\n')).not.toMatch(/Reuni|correo-ejemplo|jueves/);
  });

  it('borra las sesiones vencidas por tiempo absoluto o por inactividad', async () => {
    const { app, storage } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const user = await db.user.findUniqueOrThrow({ where: { email: 'ana@ejemplo.invalid' } });
    const ahora = Date.now();
    await db.session.createMany({
      data: [
        { userId: user.id, tokenHash: 'h-absoluta', csrfToken: 'c', expiresAt: new Date(ahora - 1000) },
        { userId: user.id, tokenHash: 'h-inactiva', csrfToken: 'c', lastActivityAt: new Date(ahora - 31 * 60_000), expiresAt: new Date(ahora + 3_600_000) },
      ],
    });

    const counts = await runCleanup({ db, storage, logger: logger().log });

    expect(counts?.expiredSessions).toBe(2);
    expect((await db.session.findMany({ select: { tokenHash: true } })).map((s) => s.tokenHash)).toEqual([expect.not.stringMatching(/^h-/)]);
    // La sesión de verdad sigue sirviendo.
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', ana.cookie)).status).toBe(200);
  });

  it('carpeta huérfana vieja se borra; una reciente, una con fila o con otro nombre no', async () => {
    const { app, storage, storageDir } = crearApp();
    const ana = await entrarComo(app, 'reporter', 'ana@ejemplo.invalid');
    const conFila = await subir(app, ana);
    const huerfanaVieja = randomUUID();
    const huerfanaReciente = randomUUID();
    await storage.save(huerfanaVieja, L03);
    await storage.save(huerfanaReciente, L03);
    await mkdir(join(storageDir, 'no-es-uuid'));
    for (const nombre of [huerfanaVieja, conFila, 'no-es-uuid']) await utimes(join(storageDir, nombre), HACE_DOS_HORAS, HACE_DOS_HORAS);

    const counts = await runCleanup({ db, storage, logger: logger().log });

    expect(counts).toMatchObject({ orphanFolders: 1, expiredReports: 0 });
    const carpetas = new Set(archivosEn(storageDir).map((k) => k.split('/')[0]));
    expect(carpetas.has(huerfanaVieja)).toBe(false);
    expect(carpetas.has(huerfanaReciente)).toBe(true);
    expect(carpetas.has(conFila)).toBe(true);
    expect(await db.report.count()).toBe(1);
  });

  it('deja auditoría system.cleanup sin actor ni requestId, solo con conteos', async () => {
    const { storage } = crearApp();
    await runCleanup({ db, storage, logger: logger().log });
    const evento = await db.auditEvent.findFirstOrThrow({ where: { action: 'system.cleanup' } });
    expect(evento).toMatchObject({ actorId: null, requestId: null, result: 'success' });
    expect(evento.metadata).toEqual({ expiredReports: 0, expiredSessions: 0, orphanFolders: 0, folderErrors: 0 });
  });

  it('dos limpiezas a la vez no chocan: la segunda se omite mientras la primera tiene el candado', async () => {
    const { storage } = crearApp();
    let avisarDentro!: () => void;
    let soltar!: () => void;
    const dentro = new Promise<void>((r) => (avisarDentro = r));
    const puerta = new Promise<void>((r) => (soltar = r));
    // La primera limpieza se queda esperando dentro de la reconciliación, con el candado tomado.
    const lenta: ReportStorage = {
      ...storage,
      listReports: async () => {
        avisarDentro();
        await puerta;
        return storage.listReports();
      },
    };

    const primera = runCleanup({ db, storage: lenta, logger: logger().log });
    await dentro;
    const segunda = await runCleanup({ db, storage, logger: logger().log });
    soltar();

    expect(segunda).toBeNull();
    expect(await primera).toMatchObject({ expiredReports: 0 });
    expect(await db.auditEvent.count({ where: { action: 'system.cleanup' } })).toBe(1);
    // Al terminar la primera, el candado se libera y otra vuelta ya puede limpiar.
    expect(await runCleanup({ db, storage, logger: logger().log })).not.toBeNull();
  });
});
