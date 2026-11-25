import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decideBudget, reserveLocalBudget } from '../../src/reputation/budget.js';
import { readCachedReputation, saveCachedReputation, REPUTATION_CACHE_MS } from '../../src/reputation/cache.js';
import { interpretReputation } from '../../src/reputation/interpret.js';
import { db, limpiarBase } from './support.js';

// Sin cliente externo: verifica persistencia, caducidad y reserva atómica en PostgreSQL.
beforeEach(async () => {
  await limpiarBase();
  await db.reputationCache.deleteMany();
  await db.reputationQuota.deleteMany();
});
afterAll(async () => { await db.$disconnect(); });

describe('reputación local persistente', () => {
  const now = new Date('2026-11-24T10:00:00.000Z');
  const url = 'https://sitio.example/ruta?token=MARCADOR_DEMO';

  it('guarda solo hash, reutiliza hasta 24 horas y no guarda errores como cero detecciones', async () => {
    const positive = interpretReputation({ status: 'result', malicious: 3, total: 90 });
    expect(await saveCachedReputation(db, url, positive, now)).toBe(true);
    const row = await db.reputationCache.findFirstOrThrow();
    expect(row.urlHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('sitio.example');
    expect(await readCachedReputation(db, 'https://sitio.example/ruta?token=OTRO', new Date(now.getTime() + REPUTATION_CACHE_MS - 1))).toMatchObject({
      state: 'reported', malicious: 3, total: 90,
    });
    expect(await readCachedReputation(db, url, new Date(now.getTime() + REPUTATION_CACHE_MS))).toBeNull();
    expect(await saveCachedReputation(db, url, interpretReputation({ status: 'error' }), now)).toBe(false);
    expect((await db.reputationCache.findFirstOrThrow()).state).toBe('reported');
    expect(await saveCachedReputation(db, url, interpretReputation({ status: 'no_data' }), now)).toBe(true);
    expect(await readCachedReputation(db, url, now)).toMatchObject({ state: 'no_data', malicious: null });
    expect(await db.reputationCache.count()).toBe(1);
  });

  it('reserva un lugar por vez entre transacciones concurrentes y respeta el día UTC', async () => {
    const attempts = await Promise.all([reserveLocalBudget(db, now), reserveLocalBudget(db, now)]);
    expect(attempts.map((a) => a.state).sort()).toEqual(['reserved', 'wait']);
    expect((await db.reputationQuota.findUniqueOrThrow({ where: { id: 1 } })).used).toBe(1);
    expect((await reserveLocalBudget(db, new Date(now.getTime() + 16_000))).state).toBe('reserved');
    expect((await db.reputationQuota.findUniqueOrThrow({ where: { id: 1 } })).used).toBe(2);
    expect(decideBudget(now, { dayUtc: '2026-11-24', used: 500, nextAllowedAt: now }).state).toBe('daily_limit');
    await db.reputationQuota.update({ where: { id: 1 }, data: { used: 500, nextAllowedAt: now } });
    expect((await reserveLocalBudget(db, now)).state).toBe('daily_limit');
    expect((await db.reputationQuota.findUniqueOrThrow({ where: { id: 1 } })).used).toBe(500);
    expect((await reserveLocalBudget(db, new Date('2026-11-25T00:00:00.000Z'))).state).toBe('reserved');
    expect((await db.reputationQuota.findUniqueOrThrow({ where: { id: 1 } })).used).toBe(1);
  });
});
