import { describe, expect, it, vi } from 'vitest';
import { getVirusTotalReport, urlReportId } from '../src/reputation/virustotal.js';

const URL = 'https://sitio.example/ruta';
const KEY = 'MARCADOR_CLAVE_DE_PRUEBA';
const fake = (attributes: object) => new Response(JSON.stringify({ data: { attributes } }), { status: 200 });
const attrs = (malicious: number) => ({
  last_analysis_date: 1_700_000_000,
  last_analysis_stats: { malicious, harmless: 4, suspicious: 2, undetected: 3, timeout: 1 },
});

describe('cliente de informes existentes de VirusTotal', () => {
  it('usa solo GET a host fijo con base64url, sin visitar el enlace ni escanearlo', async () => {
    const fetchFn = vi.fn(async () => fake(attrs(3))) as unknown as typeof fetch;
    expect(urlReportId(URL)).toBe(Buffer.from(URL).toString('base64url'));
    expect(await getVirusTotalReport(URL, KEY, fetchFn)).toEqual({
      state: 'result', malicious: 3, total: 12, analyzedAt: new Date(1_700_000_000_000),
    });
    const [endpoint, options] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(endpoint).toBe(`https://www.virustotal.com/api/v3/urls/${urlReportId(URL)}`);
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { 'x-apikey': KEY } });
    expect(JSON.stringify(endpoint)).not.toContain('sitio.example');
  });

  it('no consulta URL con parámetros, credenciales, fragmento ni clave ausente', async () => {
    const fetchFn = vi.fn(async () => fake(attrs(0))) as unknown as typeof fetch;
    for (const url of [`${URL}?token=MARCADOR_PRIVADO`, `${URL}#fragmento`, 'https://usuario:clave@sitio.example/ruta']) {
      expect(urlReportId(url)).toBeNull();
      expect((await getVirusTotalReport(url, KEY, fetchFn)).state).toBe('error');
    }
    expect((await getVirusTotalReport(URL, undefined, fetchFn)).state).toBe('error');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('distingue informe sin datos, cuota agotada, fallo HTTP y respuesta inválida', async () => {
    for (const [response, state] of [
      [new Response(null, { status: 404 }), 'no_data'],
      [new Response(null, { status: 429 }), 'rate_limited'],
      [new Response(null, { status: 503 }), 'error'],
      [fake({}), 'no_data'],
      [new Response('{}'), 'error'],
      [fake(attrs(-1)), 'error'],
      [new Response('MARCADOR_NO_JSON'), 'error'],
    ] as const) {
      expect((await getVirusTotalReport(URL, KEY, vi.fn(async () => response))).state).toBe(state);
    }
  });

  it('cero marcas no equivale a sin datos; una marca se conserva para interpretación prudente', async () => {
    for (const malicious of [0, 1]) {
      expect(await getVirusTotalReport(URL, KEY, vi.fn(async () => fake(attrs(malicious))))).toMatchObject({
        state: 'result', malicious, total: 9 + malicious,
      });
    }
  });

  it('un fallo o tiempo agotado no propaga respuestas ni excepciones', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('MARCADOR_DATO_HOSTIL'); });
    expect(await getVirusTotalReport(URL, KEY, fetchFn)).toEqual({ state: 'error' });
    const huge = vi.fn(async () => new Response('x'.repeat(256 * 1024 + 1)));
    expect(await getVirusTotalReport(URL, KEY, huge)).toEqual({ state: 'error' });
  });
});
