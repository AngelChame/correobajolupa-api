import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Db } from '../src/db/client.js';
import { normalizeLink } from '../src/analysis/links.js';
import { lookupFeeds } from '../src/feeds/lookup.js';
import { digest, parseFeed } from '../src/feeds/parse.js';
import { MAX_BYTES, refreshFeed, runFeedSchedule } from '../src/feeds/refresh.js';

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

  it('acepta una lista algo mayor que 5 MiB, como el feed reciente de URLhaus', async () => {
    const stored: { source: string; urlHash: string; hostHash: string; hasQuery: boolean }[] = [];
    const state = { source: 'URLhaus', lastGoodAt: null as Date | null, lastErrorAt: null as Date | null };
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
    const feed = `${'https://sitio.example/ruta-con-id-000000\n'.repeat(150_000)}`;
    expect(Buffer.byteLength(feed)).toBeGreaterThan(5 * 1024 * 1024);
    expect(await refreshFeed(db, logger, 'URLhaus', vi.fn(async () => new Response(feed)), 'CLAVE_DE_PRUEBA_URLHAUS_123')).toBe(true);
    expect(stored).toHaveLength(1);
    expect(state.lastGoodAt).toBeInstanceOf(Date);
  }, 20_000);

  function fakeRefreshDb(source: string) {
    const stored: { source: string; urlHash: string; hostHash: string; hasQuery: boolean }[] = [];
    const state = { source, lastGoodAt: null as Date | null, lastErrorAt: null as Date | null };
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
    return { db: { $transaction: async (cb: (client: typeof tx) => Promise<boolean>) => cb(tx) } as unknown as Db, stored, state };
  }

  it.each([
    ['error HTTP', async () => new Response('', { status: 503 }), { reason: 'http_error', httpStatus: 503 }],
    ['cuerpo demasiado grande', async () => new Response('x'.repeat(MAX_BYTES + 1)), { reason: 'too_large', bytes: MAX_BYTES + 1 }],
    ['UTF-8 inválido', async () => new Response(new Uint8Array([0xff, 0xfe, 0xfd])), { reason: 'decode_error', bytes: 3 }],
    ['formato inesperado', async () => new Response('<html>no es una lista</html>'), { reason: 'invalid_format' }],
    ['lista vacía', async () => new Response('# solo comentarios\n'), { reason: 'empty_feed' }],
  ])('diagnostica %s sin filtrar el marcador', async (_name, respond, expected) => {
    const { db, stored } = fakeRefreshDb('URLhaus');
    const warn = vi.fn();
    const info = vi.fn();
    const log = { warn, info } as unknown as Logger;
    const marcador = 'MARCADOR_SINTETICO_ABC123456';
    const fetchFn = vi.fn(respond) as unknown as typeof fetch;

    expect(await refreshFeed(db, log, 'URLhaus', fetchFn, marcador)).toBe(false);
    expect(stored).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const fields = warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields).toMatchObject({ source: 'URLhaus', errorCode: 'feed_unavailable', ...expected });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(marcador);
    expect(logged).not.toContain('urlhaus-api.abuse.ch');
    expect(logged).not.toContain('no es una lista');
  }, 20_000);

  it('clasifica fallos de red por el nombre del error, sin registrar su mensaje', async () => {
    const { db } = fakeRefreshDb('URLhaus');
    const warn = vi.fn();
    const log = { warn, info: vi.fn() } as unknown as Logger;
    const fetchFn = vi.fn(async () => {
      const error = new Error('fetch a https://urlhaus-api.abuse.ch/v2/MARCADOR_SINTETICO falló');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch;

    expect(await refreshFeed(db, log, 'URLhaus', fetchFn, 'MARCADOR_SINTETICO')).toBe(false);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      source: 'URLhaus', errorCode: 'feed_unavailable', reason: 'network_error', errName: 'TimeoutError',
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('MARCADOR_SINTETICO');
    expect(logged).not.toContain('urlhaus-api.abuse.ch');
  });

  it('una descarga correcta no emite advertencias y registra cuántas entradas se guardaron', async () => {
    const { db, stored } = fakeRefreshDb('URLhaus');
    const warn = vi.fn();
    const info = vi.fn();
    const log = { warn, info } as unknown as Logger;
    const feed = 'https://sitio.example/ruta\n';
    expect(await refreshFeed(db, log, 'URLhaus', vi.fn(async () => new Response(feed)), 'CLAVE_DE_PRUEBA')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls[0]![0]).toMatchObject({ source: 'URLhaus', count: 1 });
    expect(stored).toHaveLength(1);
  });

  it('el planificador registra un fallo de base sin exponer el mensaje ni el marcador', async () => {
    const marcador = 'MARCADOR_SINTETICO';
    const controller = new AbortController();
    const warn = vi.fn();
    const log = { warn, info: vi.fn() } as unknown as Logger;
    const db = {
      $transaction: async () => {
        controller.abort();
        throw new Error('error interno con valor sensible');
      },
    } as unknown as Db;

    await runFeedSchedule(db, log, {
      openPhishEnabled: false,
      urlhausAuthKey: marcador,
      intervalMs: 0,
      signal: controller.signal,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ source: 'URLhaus', errorCode: 'feed_unavailable', reason: 'unknown' });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(marcador);
    expect(logged).not.toContain('valor sensible');
  });
});
