import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { testDatabaseUrl } from './test-db.js';

// Migración de M6: incidentes, asociaciones y comentarios (CHECK, borrados y solo inserción).
const db = createDb(testDatabaseUrl());

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE quarantine_actions, incident_comments, incident_indicators, incident_reports, incidents, indicators, exclusions, attachments, report_links, findings, reports, audit_events, sessions, users',
  );
});

async function persona(email = 'analista@ejemplo.invalid') {
  return db.user.create({ data: { email, displayName: 'Persona', passwordHash: 'x', role: 'analyst' } });
}

async function reporte(userId: string) {
  return db.report.create({ data: { userId, source: 'eml', storageKey: 'k/x', sizeBytes: 1, sha256: 'a'.repeat(64) } });
}

describe('migración de incidentes', () => {
  it('CHECK de longitudes: título de 1 a 120, descripción hasta 2000, comentario de 1 a 2000', async () => {
    const u = await persona();
    await expect(db.incident.create({ data: { title: '', createdById: u.id } })).rejects.toThrow();
    await expect(db.incident.create({ data: { title: 't'.repeat(121), createdById: u.id } })).rejects.toThrow();
    await expect(db.incident.create({ data: { title: 't', description: 'd'.repeat(2001), createdById: u.id } })).rejects.toThrow();
    const i = await db.incident.create({ data: { title: 't'.repeat(120), description: 'd'.repeat(2000), createdById: u.id } });
    expect(i.status).toBe('received');

    await expect(db.incidentComment.create({ data: { incidentId: i.id, authorId: u.id, body: '' } })).rejects.toThrow();
    await expect(db.incidentComment.create({ data: { incidentId: i.id, authorId: u.id, body: 'c'.repeat(2001) } })).rejects.toThrow();
    await expect(db.incidentComment.create({ data: { incidentId: i.id, authorId: u.id, body: 'c'.repeat(2000) } })).resolves.toBeTruthy();
  });

  it('los comentarios son solo de inserción: el UPDATE falla', async () => {
    const u = await persona();
    const i = await db.incident.create({ data: { title: 'Campaña', createdById: u.id } });
    const c = await db.incidentComment.create({ data: { incidentId: i.id, authorId: u.id, body: 'original' } });
    await expect(db.incidentComment.update({ where: { id: c.id }, data: { body: 'cambiado' } })).rejects.toThrow();
    expect((await db.incidentComment.findUniqueOrThrow({ where: { id: c.id } })).body).toBe('original');
  });

  it('una pareja solo una vez; borrar el reporte o el indicador quita la asociación y deja el incidente', async () => {
    const u = await persona();
    const i = await db.incident.create({ data: { title: 'Campaña', createdById: u.id } });
    const r = await reporte(u.id);
    const ind = await db.indicator.create({ data: { type: 'domain', value: 'malo.example', proposedById: u.id } });
    await db.incidentReport.create({ data: { incidentId: i.id, reportId: r.id, addedById: u.id } });
    await db.incidentIndicator.create({ data: { incidentId: i.id, indicatorId: ind.id, addedById: u.id } });
    await expect(db.incidentReport.create({ data: { incidentId: i.id, reportId: r.id, addedById: u.id } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.incidentIndicator.create({ data: { incidentId: i.id, indicatorId: ind.id, addedById: u.id } })).rejects.toMatchObject({ code: 'P2002' });

    await db.report.delete({ where: { id: r.id } });
    await db.indicator.delete({ where: { id: ind.id } });
    expect(await db.incidentReport.count()).toBe(0);
    expect(await db.incidentIndicator.count()).toBe(0);
    expect(await db.incident.count()).toBe(1);
  });

  it('borrar el incidente borra sus asociaciones y comentarios, no los reportes ni los indicadores', async () => {
    const u = await persona();
    const i = await db.incident.create({ data: { title: 'Campaña', createdById: u.id } });
    const r = await reporte(u.id);
    const ind = await db.indicator.create({ data: { type: 'domain', value: 'malo.example', proposedById: u.id } });
    await db.incidentReport.create({ data: { incidentId: i.id, reportId: r.id, addedById: u.id } });
    await db.incidentIndicator.create({ data: { incidentId: i.id, indicatorId: ind.id, addedById: u.id } });
    await db.incidentComment.create({ data: { incidentId: i.id, authorId: u.id, body: 'nota' } });

    await db.incident.delete({ where: { id: i.id } });
    expect(await db.incidentReport.count()).toBe(0);
    expect(await db.incidentIndicator.count()).toBe(0);
    expect(await db.incidentComment.count()).toBe(0);
    expect(await db.report.count()).toBe(1);
    expect(await db.indicator.count()).toBe(1);
  });

  it('Restrict: no se puede borrar la cuenta que creó un incidente, comentó o asoció algo', async () => {
    const creador = await persona();
    await db.incident.create({ data: { title: 'Campaña', createdById: creador.id } });
    await expect(db.user.delete({ where: { id: creador.id } })).rejects.toThrow();

    const otra = await persona('otra@ejemplo.invalid');
    const i2 = await db.incident.create({ data: { title: 'Otra', createdById: creador.id } });
    await db.incidentComment.create({ data: { incidentId: i2.id, authorId: otra.id, body: 'nota' } });
    await expect(db.user.delete({ where: { id: otra.id } })).rejects.toThrow();

    const tercera = await persona('tercera@ejemplo.invalid');
    const r = await reporte(creador.id);
    await db.incidentReport.create({ data: { incidentId: i2.id, reportId: r.id, addedById: tercera.id } });
    await expect(db.user.delete({ where: { id: tercera.id } })).rejects.toThrow();
    expect(await db.user.count()).toBe(3);
  });
});
