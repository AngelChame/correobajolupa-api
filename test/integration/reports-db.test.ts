import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { testDatabaseUrl } from './test-db.js';

// Tablas de reportes (M1, paso 1): restricciones que la base garantiza por sí sola.
// Solo datos sintéticos: ningún contenido de correo.

const db = createDb(testDatabaseUrl());
const SHA_SINTETICO = 'a'.repeat(64);
const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE quarantine_actions, incident_comments, incident_indicators, incident_reports, incidents, indicators, exclusions, attachments, report_links, findings, reports, audit_events, sessions, users');
});

async function crearReporte(datos: { status?: 'queued' | 'limited' | 'completed'; limitedReason?: 'parse_error' | null } = {}) {
  const usuario = await db.user.create({
    data: { email: `persona-${crypto.randomUUID()}@ejemplo.invalid`, displayName: 'Persona de prueba', passwordHash: 'hash-sintetico' },
  });
  const reporte = await db.report.create({
    data: {
      userId: usuario.id,
      source: 'eml',
      storageKey: 'clave-sintetica',
      sizeBytes: 10,
      sha256: SHA_SINTETICO,
      ...datos,
    },
  });
  return { usuario, reporte };
}

describe('reports', () => {
  it('nace en la cola con los valores por defecto y vence a los 7 días (D-012)', async () => {
    const { reporte } = await crearReporte();
    expect(reporte).toMatchObject({ status: 'queued', attempts: 0, lockedUntil: null, lastErrorCode: null, priority: null });
    expect(reporte.expiresAt.getTime() - reporte.createdAt.getTime()).toBe(SIETE_DIAS_MS);
  });

  it('limited va siempre con limitedReason, y solo limited (D-004)', async () => {
    await expect(crearReporte({ status: 'limited', limitedReason: null })).rejects.toThrow(/reports_limited_reason_check/);
    await expect(crearReporte({ status: 'completed', limitedReason: 'parse_error' })).rejects.toThrow(/reports_limited_reason_check/);
    const { reporte } = await crearReporte({ status: 'limited', limitedReason: 'parse_error' });
    expect(reporte.limitedReason).toBe('parse_error');
  });

  it('rechaza un sha256 que no es hexadecimal de 64 caracteres', async () => {
    const { usuario } = await crearReporte();
    await expect(
      db.report.create({ data: { userId: usuario.id, source: 'paste', storageKey: 'k', sizeBytes: 1, sha256: 'Z'.repeat(64) } }),
    ).rejects.toThrow(/reports_sha256_check/);
  });

  it('al borrar la cuenta se borran sus reportes, hallazgos y enlaces', async () => {
    const { usuario, reporte } = await crearReporte();
    await db.finding.create({
      data: { reportId: reporte.id, ruleId: 'R1', ruleName: 'Regla sintética', summary: 'Resumen sintético', evidence: [], rulesVersion: 'v-prueba' },
    });
    await db.reportLink.create({
      data: { reportId: reporte.id, position: 0, normalizedUrl: 'https://sitio.example/', defangedUrl: 'hxxps://sitio[.]example/' },
    });

    await db.user.delete({ where: { id: usuario.id } });

    expect(await db.report.count()).toBe(0);
    expect(await db.finding.count()).toBe(0);
    expect(await db.reportLink.count()).toBe(0);
  });
});

describe('findings (solo inserción)', () => {
  it('la base rechaza cualquier UPDATE de un hallazgo', async () => {
    const { reporte } = await crearReporte();
    const hallazgo = await db.finding.create({
      data: { reportId: reporte.id, ruleId: 'R5', ruleName: 'Regla sintética', summary: 'Original', evidence: [{ label: 'a', value: 'b' }], rulesVersion: 'v-prueba' },
    });
    await expect(db.finding.update({ where: { id: hallazgo.id }, data: { summary: 'Cambiado' } })).rejects.toThrow(
      /solo de inserción/,
    );
    expect((await db.finding.findUniqueOrThrow({ where: { id: hallazgo.id } })).summary).toBe('Original');
  });

  it('la evidencia debe ser una lista', async () => {
    const { reporte } = await crearReporte();
    await expect(
      db.finding.create({
        data: { reportId: reporte.id, ruleId: 'R1', ruleName: 'Regla sintética', summary: 'x', evidence: { label: 'a' }, rulesVersion: 'v' },
      }),
    ).rejects.toThrow(/findings_evidence_array_check/);
  });
});

describe('report_links', () => {
  it('la posición es única dentro del reporte', async () => {
    const { reporte } = await crearReporte();
    const enlace = { reportId: reporte.id, position: 0, normalizedUrl: 'https://sitio.example/', defangedUrl: 'hxxps://sitio[.]example/' };
    await db.reportLink.create({ data: enlace });
    await expect(db.reportLink.create({ data: enlace })).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('attachments (M2)', () => {
  const adjunto = (reportId: string, extra: Record<string, unknown> = {}) => ({
    reportId,
    position: 0,
    sizeBytes: 4,
    sha256: SHA_SINTETICO,
    scanStatus: 'not_detected' as const,
    ...extra,
  });

  it('la posición es única dentro del reporte', async () => {
    const { reporte } = await crearReporte();
    await db.attachment.create({ data: adjunto(reporte.id) });
    await expect(db.attachment.create({ data: adjunto(reporte.id) })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rechaza un SHA-256 mal formado y un tamaño negativo', async () => {
    const { reporte } = await crearReporte();
    await expect(db.attachment.create({ data: adjunto(reporte.id, { sha256: 'Z'.repeat(64) }) })).rejects.toThrow();
    await expect(db.attachment.create({ data: adjunto(reporte.id, { sizeBytes: -1 }) })).rejects.toThrow();
  });

  it('se borran junto con su reporte (cascada)', async () => {
    const { reporte } = await crearReporte();
    await db.attachment.create({ data: adjunto(reporte.id, { scanStatus: 'error', scanDetail: 'motivo sintético' }) });
    await db.report.delete({ where: { id: reporte.id } });
    expect(await db.attachment.count()).toBe(0);
  });
});
