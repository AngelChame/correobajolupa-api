import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Db } from '../src/db/client.js';
import { normalizeLink } from '../src/analysis/links.js';
import { lookupFeeds } from '../src/feeds/lookup.js';
import { digest, parseFeed } from '../src/feeds/parse.js';
import { refreshFeed } from '../src/feeds/refresh.js';

const date = new Date('2026-11-24T12:00:00.000Z');
const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;

describe('listas de reputación sin acceso a la red', () => {
  it('normaliza con M5, deduplica y guarda solo hashes; rechaza feeds vacíos o mal formados', () => {
    const a = parseFeed('https://sitio.example/ruta?a=1\nhttps://sitio.example/ruta?a=2\n', 'OpenPhish');
    expect(a).toEqual([{ urlHash: digest('https://sitio.example/ruta'), hostHash: digest('sitio.example'), hasQuery: true }]);
    expect(JSON.stringify(a)).not.toContain('sitio.example');
    expect(() => parseFeed('<html>error</html>', 'OpenPhish')).toThrow('feed_invalid_format');
    expect(() => parseFeed('# cabecera\n', 'OpenPhish')).toThrow('feed_empty');
    expect(parseFeed('ftp://sitio.example/archivo\nhttps://sitio.example/ruta\n', 'URLhaus')).toHaveLength(1);
  });

  function fakeDb(entries: { source: string; urlHash: string; hostHash: string; hasQuery: boolean }[], opts?: {
    lastErrorAt?: Date | null;
    excluded?: string[];
  }): Db {
    return {
      exclusion: { findMany: vi.fn(async () => (opts?.excluded ?? []).map((domain) => ({ domain }))) },
      feedSource: {
        findMany: vi.fn(async () => [{ source: 'OpenPhish', lastGoodAt: date, lastErrorAt: opts?.lastErrorAt ?? null }]),
      },
      feedEntry: {
        findFirst: vi.fn(async ({ where }: { where: { urlHash?: { in: string[] }; hostHash?: { in: string[] } } }) =>
          entries.find((e) => where.urlHash?.in.includes(e.urlHash) || where.hostHash?.in.includes(e.hostHash)) ?? null),
      },
    } as unknown as Db;
  }

  const link = (raw: string) => normalizeLink({ raw, displayText: null }, 0)!;

  it('R10 exacta incluye fuente y fecha; solo dominio baja a sospechosa', async () => {
    const entry = parseFeed('https://reportado.example/ruta\n', 'OpenPhish')[0]!;
    const db = fakeDb([{ source: 'OpenPhish', ...entry }]);
    const exact = await lookupFeeds(db, [link('https://reportado.example/ruta')], [], ['OpenPhish']);
    expect(exact.finding?.ruleId).toBe('R10');
    expect(exact.exact).toBe(true);
    expect(exact.finding?.evidence.map((e) => e.value)).toEqual([
      'https://reportado.example/ruta', 'OpenPhish', date.toISOString(), 'URL exacta',
    ]);
    const host = await lookupFeeds(db, [link('https://reportado.example/otra')], [], ['OpenPhish']);
    expect(host.exact).toBe(false);
    expect(host.finding?.evidence.at(-1)?.value).toBe('Solo dominio');
  });

  it('una query diferente impide afirmar coincidencia exacta; las exclusiones no se marcan', async () => {
    const entry = parseFeed('https://reportado.example/ruta?token=abc\n', 'OpenPhish')[0]!;
    const db = fakeDb([{ source: 'OpenPhish', ...entry }]);
    const result = await lookupFeeds(db, [link('https://reportado.example/ruta?token=otro')], [], ['OpenPhish']);
    expect(result.exact).toBe(false);
    expect(result.finding?.evidence.at(-1)?.value).toBe('URL sin parámetros (no exacta)');
    const excluded = await lookupFeeds(fakeDb([{ source: 'OpenPhish', ...entry }], { excluded: ['reportado.example'] }),
      [link('https://reportado.example/ruta')], [], ['OpenPhish']);
    expect(excluded.finding).toBeNull();
  });

  it('una fuente fallida conserva sus entradas pero indica no disponibilidad; sin fuente no confunde ausencia con seguridad', async () => {
    const entry = parseFeed('https://reportado.example/ruta\n', 'OpenPhish')[0]!;
    const stale = await lookupFeeds(fakeDb([{ source: 'OpenPhish', ...entry }], { lastErrorAt: new Date(date.getTime() + 1000) }),
      [link('https://reportado.example/ruta')], [], ['OpenPhish']);
    expect(stale.finding?.ruleId).toBe('R10');
    expect(stale.unavailable).toEqual(['OpenPhish']);
    const noConfig = await lookupFeeds(fakeDb([]), [link('https://sitio.example/')], [], []);
    expect(noConfig.unavailable).toEqual([]);
    expect(noConfig.finding).toBeNull();
  });

  it('descarga sintética: reemplaza el snapshot, pero error y feed vacío preservan el anterior', async () => {
    const stored: { source: string; urlHash: string; hostHash: string; hasQuery: boolean }[] = [];
    const state = { source: 'OpenPhish', lastGoodAt: null as Date | null, lastErrorAt: null as Date | null };
    const tx = {
      $queryRaw: vi.fn(async () => [{ ok: true }]),
      feedSource: {
        upsert: vi.fn(async ({ create, update }: { create: typeof state; update: Partial<typeof state> }) => {
          Object.assign(state, state.lastGoodAt === null && state.lastErrorAt === null ? create : update);
        }),
      },
      feedEntry: {
        deleteMany: vi.fn(async () => { stored.length = 0; }),
        createMany: vi.fn(async ({ data }: { data: typeof stored }) => { stored.push(...data); }),
      },
    };
    const db = { $transaction: async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx) } as unknown as Db;
    const ok = vi.fn(async () => new Response('https://sitio.example/ruta\n'));
    expect(await refreshFeed(db, logger, 'OpenPhish', ok)).toBe(true);
    expect(stored).toHaveLength(1);
    const previous = [...stored];
    expect(await refreshFeed(db, logger, 'OpenPhish', vi.fn(async () => new Response('', { status: 503 })))).toBe(false);
    expect(stored).toEqual(previous);
    expect(state.lastErrorAt).toBeInstanceOf(Date);
    expect(await refreshFeed(db, logger, 'OpenPhish', vi.fn(async () => new Response('# vacío\n')))).toBe(false);
    expect(stored).toEqual(previous);
  });
});
