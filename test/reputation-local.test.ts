import { describe, expect, it } from 'vitest';
import { decideBudget, MAX_DAILY_QUERIES, MIN_QUERY_GAP_MS } from '../src/reputation/budget.js';
import { REPUTATION_CACHE_MS } from '../src/reputation/cache.js';

describe('presupuesto local de reputación', () => {
  const now = new Date('2026-11-24T10:00:00.000Z');
  const row = { dayUtc: '2026-11-24', used: 0, nextAllowedAt: new Date(0) };

  it('reserva como máximo una operación cada 16 segundos', () => {
    const first = decideBudget(now, row);
    expect(first.state).toBe('reserved');
    if (first.state !== 'reserved') return;
    expect(first.next.used).toBe(1);
    expect(first.next.nextAllowedAt.getTime() - now.getTime()).toBe(MIN_QUERY_GAP_MS);
    expect(decideBudget(new Date(now.getTime() + 15_999), first.next).state).toBe('wait');
    expect(decideBudget(new Date(now.getTime() + 16_000), first.next).state).toBe('reserved');
  });

  it('se detiene al llegar a 500 y reinicia el conteo al cambiar de día UTC, sin saltar el intervalo', () => {
    const limit = decideBudget(now, { ...row, used: MAX_DAILY_QUERIES });
    expect(limit.state).toBe('daily_limit');
    if (limit.state !== 'daily_limit') expect.unreachable();
    else expect(limit.nextAllowedAt.toISOString()).toBe('2026-11-25T00:00:00.000Z');
    const endOfDay = new Date('2026-11-24T23:59:55.000Z');
    const previous = { dayUtc: '2026-11-24', used: 500, nextAllowedAt: new Date(endOfDay.getTime() + MIN_QUERY_GAP_MS) };
    expect(decideBudget(new Date('2026-11-25T00:00:00.000Z'), previous).state).toBe('wait');
    expect(decideBudget(new Date('2026-11-25T00:00:11.000Z'), previous).state).toBe('reserved');
  });
});

describe('caducidad', () => {
  it('la ventana de caché es de 24 horas', () => {
    expect(REPUTATION_CACHE_MS).toBe(86_400_000);
  });
});
