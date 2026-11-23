import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import type { IndicatorType } from '../../src/generated/prisma/enums.js';
import { testDatabaseUrl } from './test-db.js';

// Migración de M5: indicadores y lista de exclusión (índice único parcial, CHECK y borrados).
const db = createDb(testDatabaseUrl());

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE incident_comments, incident_indicators, incident_reports, incidents, indicators, exclusions, attachments, report_links, findings, reports, audit_events, sessions, users');
});

const SHA = 'b'.repeat(64);

async function persona(email = 'analista@ejemplo.invalid') {
  return db.user.create({ data: { email, displayName: 'Persona', passwordHash: 'x', role: 'analyst' } });
}

function indicador(proposedById: string, data: { type?: IndicatorType; value?: string; reportId?: string } = {}) {
  return db.indicator.create({ data: { type: data.type ?? 'domain', value: data.value ?? 'malo.example', proposedById, ...(data.reportId ? { reportId: data.reportId } : {}) } });
}

describe('migración de indicadores', () => {
  it('un (tipo, valor) solo una vez entre los no descartados; descartar libera el valor', async () => {
    const u = await persona();
    const primero = await indicador(u.id);
    await expect(indicador(u.id)).rejects.toMatchObject({ code: 'P2002' });
    // Mismo valor con otro tipo: permitido.
    await expect(indicador(u.id, { type: 'sender', value: 'malo.example' })).resolves.toBeTruthy();

    await db.indicator.update({ where: { id: primero.id }, data: { status: 'dismissed', decidedById: u.id, decidedAt: new Date() } });
    const segundo = await indicador(u.id);
    // Con un descartado y uno propuesto, no se puede confirmar otro igual ni reactivar el descartado.
    await expect(indicador(u.id)).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.indicator.update({ where: { id: primero.id }, data: { status: 'confirmed' } })).rejects.toThrow();
    expect(segundo.status).toBe('proposed');
  });

  it('CHECK: SHA-256 de 64 hexadecimales en minúsculas; dominio, hash y remitente en minúsculas; url conserva mayúsculas en la ruta', async () => {
    const u = await persona();
    await expect(indicador(u.id, { type: 'sha256', value: 'B'.repeat(64) })).rejects.toThrow();
    await expect(indicador(u.id, { type: 'sha256', value: 'b'.repeat(63) })).rejects.toThrow();
    await expect(indicador(u.id, { type: 'sha256', value: SHA })).resolves.toBeTruthy();
    await expect(indicador(u.id, { type: 'domain', value: 'Malo.example' })).rejects.toThrow();
    await expect(indicador(u.id, { type: 'sender', value: 'Rh@malo.example' })).rejects.toThrow();
    await expect(indicador(u.id, { type: 'domain', value: `${'a'.repeat(251)}.ex` })).rejects.toThrow();
    await expect(indicador(u.id, { type: 'domain', value: '' })).rejects.toThrow();
    await expect(indicador(u.id, { type: 'url', value: 'https://malo.example/Recibo' })).resolves.toBeTruthy();
  });

  it('CHECK: propuesto sin fecha de decisión; decidido con fecha', async () => {
    const u = await persona();
    const i = await indicador(u.id);
    await expect(db.indicator.update({ where: { id: i.id }, data: { status: 'confirmed' } })).rejects.toThrow();
    await expect(db.indicator.update({ where: { id: i.id }, data: { decidedAt: new Date() } })).rejects.toThrow();
    await expect(db.indicator.update({ where: { id: i.id }, data: { status: 'confirmed', decidedAt: new Date(), decidedById: u.id } })).resolves.toBeTruthy();
  });

  it('borrar el reporte conserva el indicador (report_id nulo); borrar a quien decidió deja decidedBy nulo', async () => {
    const u = await persona();
    const otra = await persona('otra@ejemplo.invalid');
    const report = await db.report.create({ data: { userId: u.id, source: 'eml', storageKey: 'k/x', sizeBytes: 1, sha256: SHA } });
    const i = await indicador(u.id, { reportId: report.id });
    await db.indicator.update({ where: { id: i.id }, data: { status: 'confirmed', decidedAt: new Date(), decidedById: otra.id } });
    await db.report.delete({ where: { id: report.id } });
    await db.user.delete({ where: { id: otra.id } });
    const fila = await db.indicator.findUniqueOrThrow({ where: { id: i.id } });
    expect(fila).toMatchObject({ reportId: null, decidedById: null, status: 'confirmed' });
  });
});

describe('quién propuso (Restrict)', () => {
  it('no se puede borrar la cuenta de quien propuso un indicador; sin indicadores, sí', async () => {
    const u = await persona();
    const i = await indicador(u.id);
    await expect(db.user.delete({ where: { id: u.id } })).rejects.toThrow();
    expect(await db.indicator.count()).toBe(1);
    await db.indicator.delete({ where: { id: i.id } });
    await expect(db.user.delete({ where: { id: u.id } })).resolves.toBeTruthy();
  });
});

describe('migración de exclusiones', () => {
  it('dominio único, en minúsculas y de 1 a 253 caracteres', async () => {
    const u = await persona();
    const crear = (domain: string) => db.exclusion.create({ data: { domain, createdById: u.id } });
    await crear('nube-compartida.example');
    await expect(crear('nube-compartida.example')).rejects.toMatchObject({ code: 'P2002' });
    await expect(crear('Mayusculas.example')).rejects.toThrow();
    await expect(crear('')).rejects.toThrow();
  });
});
