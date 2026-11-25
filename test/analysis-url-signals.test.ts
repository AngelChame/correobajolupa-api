import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/index.js';
import { findUrlFinding } from '../src/analysis/rules.js';
import { normalizeLink } from '../src/analysis/links.js';
import { evaluarSenalesUrl, suficientesSenales } from '../src/analysis/url-signals.js';

const codes = (url: string, tlds?: ReadonlySet<string>) => evaluarSenalesUrl(url, tlds).map((s) => s.code);
const base = 'https://sitio.example/';

describe('señales locales de URL (R9)', () => {
  it.each([
    ['userinfo', 'https://cuenta@sitio.example/', base],
    ['shortener', 'https://bit.ly/abc', base],
    ['executable', 'https://sitio.example/archivo.exe', 'https://sitio.example/archivo.pdf'],
    ['redirect', 'https://sitio.example/ir?next=https%3A%2F%2Fotro.example%2F', 'https://sitio.example/ir?next=%2Fperfil'],
    ['lure', 'https://sitio.example/verify', 'https://sitio.example/overview'],
    ['subdomains', 'https://a.b.c.sitio.example/', 'https://a.b.sitio.example/'],
    ['http', 'http://sitio.example/', base],
    ['encoding', 'https://sitio.example/%61%62%63%64%65%66', 'https://sitio.example/%61%62'],
  ] as const)('%s: caso positivo y negativo', (code, positive, negative) => {
    expect(codes(positive)).toContain(code);
    expect(codes(negative)).not.toContain(code);
  });

  it('TLD configurable para comprobarlo con dominios sintéticos', () => {
    const tlds = new Set(['example']);
    expect(codes(base, tlds)).toContain('tld');
    expect(codes(base, new Set())).not.toContain('tld');
  });

  it('ignora URL inválidas y esquemas que no son web', () => {
    expect(codes('no-es-url')).toEqual([]);
    expect(codes('mailto:usuario@ejemplo.example')).toEqual([]);
  });

  it('una fuerte basta; dos débiles con señal estructural bastan; sin cifrar y login no bastan', () => {
    expect(suficientesSenales(evaluarSenalesUrl('https://bit.ly/x'))).toBe(true);
    expect(suficientesSenales(evaluarSenalesUrl('http://a.b.c.sitio.example/login'))).toBe(true);
    expect(suficientesSenales(evaluarSenalesUrl('http://sitio.example/login'))).toBe(false);
    expect(suficientesSenales(evaluarSenalesUrl('https://sitio.example/login'))).toBe(false);
  });

  it('un único enlace en texto pegado dispara R9 sin visitar el destino', async () => {
    const result = await analyze(Buffer.from('https://sitio.example/archivo.exe'), 'paste', { institutionalDomains: [] });
    expect(result.status).toBe('limited');
    expect(result.findings.map((f) => f.ruleId)).toEqual(['R9']);
    expect(result.findings[0]!.evidence.map((e) => e.value).join(' ')).toContain('extensión ejecutable');
    expect(result.priority).toBe('medium');
  });

  it('un enlace sin señales suficientes no se etiqueta como seguro ni como malicioso', async () => {
    const result = await analyze(Buffer.from('https://sitio.example/'), 'paste', { institutionalDomains: [] });
    expect(result.status).toBe('limited');
    expect(result.links).toHaveLength(1);
    expect(result.findings).toEqual([]);
  });

  it('un dominio institucional configurado y sus subdominios no disparan R9', async () => {
    const result = await analyze(Buffer.from('https://portal.institucion.example/archivo.exe'), 'paste', { institutionalDomains: ['institucion.example'] });
    expect(result.findings).toEqual([]);
  });

  it('una exclusión manual cubre el host y sus subdominios sin cubrir dominios parecidos', () => {
    const covered = normalizeLink({ raw: 'https://portal.confiable.example/archivo.exe', displayText: null }, 0)!;
    const different = normalizeLink({ raw: 'https://noconfiable.example/archivo.exe', displayText: null }, 1)!;
    expect(findUrlFinding([covered], [], ['confiable.example'])).toBeNull();
    expect(findUrlFinding([different], [], ['confiable.example'])?.ruleId).toBe('R9');
  });

  it('la evidencia no expone la query, las credenciales ni el destino de redirección', () => {
    const raw = 'https://usuario:MARCADOR_CLAVE@sitio.example/ir?next=https%3A%2F%2Fotro.example%2Fsecreto';
    const link = normalizeLink({ raw, displayText: null }, 0)!;
    const finding = findUrlFinding([link], [])!;
    const evidence = JSON.stringify(finding.evidence);
    expect(evidence).not.toContain('MARCADOR_CLAVE');
    expect(evidence).not.toContain('otro.example');
    expect(evidence).not.toContain('?next=');
    expect(finding.evidence.map((e) => e.label)).toContain('Señal');
  });
});
