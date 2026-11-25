import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeLink } from '../../src/analysis/links.js';
import { lookupFeeds } from '../../src/feeds/lookup.js';
import { refreshFeed } from '../../src/feeds/refresh.js';
import { createLogger } from '../../src/logger.js';
import { db, limpiarBase } from './support.js';

// PostgreSQL real, respuestas de feed inventadas: nunca llama a las fuentes externas.
const logger = createLogger('silent', { write: () => undefined }, 'test-feeds');

beforeEach(async () => {
  await limpiarBase();
  await db.feedEntry.deleteMany();
  await db.feedSource.deleteMany();
});
afterAll(async () => { await db.$disconnect(); });

describe('feeds en base de datos', () => {
  it('reemplaza el snapshot atómicamente y R10 distingue URL exacta de dominio compartido', async () => {
    const first = vi.fn(async () => new Response('https://reportado.example/ruta\n'));
    expect(await refreshFeed(db, logger, 'OpenPhish', first)).toBe(true);
    expect(await db.feedEntry.count()).toBe(1);
    const link = (raw: string) => normalizeLink({ raw, displayText: null }, 0)!;
    const exact = await lookupFeeds(db, [link('https://reportado.example/ruta')], [], ['OpenPhish']);
    expect(exact.finding?.ruleId).toBe('R10');
    expect(exact.exact).toBe(true);
    const host = await lookupFeeds(db, [link('https://reportado.example/otra')], [], ['OpenPhish']);
    expect(host.finding?.ruleId).toBe('R10');
    expect(host.exact).toBe(false);

    expect(await refreshFeed(db, logger, 'OpenPhish', vi.fn(async () => new Response('https://nuevo.example/otro\n')))).toBe(true);
    expect(await db.feedEntry.count()).toBe(1);
    expect((await lookupFeeds(db, [link('https://reportado.example/ruta')], [], ['OpenPhish'])).finding).toBeNull();
  });

  it('una descarga fallida conserva el snapshot y registra no disponibilidad', async () => {
    const link = normalizeLink({ raw: 'https://reportado.example/ruta', displayText: null }, 0)!;
    expect(await refreshFeed(db, logger, 'OpenPhish', vi.fn(async () => new Response('https://reportado.example/ruta\n')))).toBe(true);
    expect(await refreshFeed(db, logger, 'OpenPhish', vi.fn(async () => new Response('fallo', { status: 503 })))).toBe(false);
    expect(await db.feedEntry.count()).toBe(1);
    const result = await lookupFeeds(db, [link], [], ['OpenPhish']);
    expect(result.finding?.ruleId).toBe('R10');
    expect(result.unavailable).toEqual(['OpenPhish']);
  });
});
