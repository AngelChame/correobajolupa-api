import { domainToASCII } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, defangEmail, defangUrlValue } from '../src/analysis/index.js';
import { readAuthentication } from '../src/analysis/authentication.js';
import { extractHtmlLinks, normalizeLink } from '../src/analysis/links.js';
import { editDistance, imitatedDomain } from '../src/analysis/lookalike.js';
import { priorityOf } from '../src/analysis/rules.js';
import { MAX_MULTIPART_DEPTH, scanMimeStructure } from '../src/analysis/structure.js';

// Piezas del analizador por separado. Solo datos sintéticos (.example, .invalid, 203.0.113.0/24).
const INST = ['universidad-ejemplo.example'];
const enlace = (raw: string, displayText: string | null = null) => normalizeLink({ raw, displayText }, 0);
const eml = (lineas: string[]) => Buffer.from(lineas.join('\r\n'));

describe('normalización y desactivación de enlaces (D-017)', () => {
  it('esquema y host en minúsculas, punycode, IP con puntos, sin credenciales, query ni fragmento', () => {
    expect(enlace('HTTPS://Usuario:Clave@Sitio.EXAMPLE:8443/Ruta?x=1#y')).toMatchObject({
      scheme: 'https',
      normalizedUrl: 'https://sitio.example:8443/Ruta',
      defangedUrl: 'hxxps://sitio[.]example:8443/Ruta',
      domain: 'sitio.example',
    });
    expect(enlace('http://0xCB00712D/a')).toMatchObject({ normalizedUrl: 'http://203.0.113.45/a', defangedUrl: 'hxxp://203[.]0[.]113[.]45/a' });
    // 'а' cirílica: el host queda en punycode (el mismo que calcula el URL de WHATWG).
    expect(enlace('https://bаnco.example/')?.domain).toBe(domainToASCII('bаnco.example'));
    expect(domainToASCII('bаnco.example')).toMatch(/^xn--/);
  });

  it('esquemas no web: el esquema desactivado y el resto recortado', () => {
    expect(enlace('javascript:alert(1)')?.defangedUrl).toBe('javascript[:]…');
    expect(enlace('data:text/html;base64,PHNjcmlwdD4=')?.defangedUrl).toBe('data[:]…');
    expect(enlace('mailto:Soporte@Banco.example?subject=x')).toMatchObject({ defangedUrl: 'mailto[:]Soporte@Banco[.]example', domain: 'banco.example' });
  });

  it('las URL relativas o inválidas no son enlaces', () => {
    for (const raw of ['/ruta', 'pagina.html', '#ancla', 'http://', '', 'http://[::1']) expect(enlace(raw), raw).toBeNull();
  });

  it('defang de evidencias: URL, dominio y correo nunca quedan clicables', () => {
    expect(defangUrlValue('https://www.banco.example/acceso?x=1')).toBe('hxxps://www[.]banco[.]example/acceso');
    expect(defangUrlValue('JaVaScRiPt:alert(1)')).toBe('javascript[:]…');
    expect(defangUrlValue('www.banco.example')).toBe('www[.]banco[.]example');
    expect(defangEmail('soporte@banco-ejemplo.example')).toBe('soporte@banco-ejemplo[.]example');
  });

  it('el parser HTML decodifica entidades y toma <a> y <area> con su texto', () => {
    const links = extractHtmlLinks('<a href="&#x6A;avascript:x">uno <b>dos</b></a><area href="http://a.example/" alt="mapa"><a>sin href</a>');
    expect(links).toEqual([
      { raw: 'javascript:x', displayText: 'uno dos' },
      { raw: 'http://a.example/', displayText: 'mapa' },
    ]);
  });
});

describe('estructura MIME antes de parsear', () => {
  const anidado = (n: number, cerrar: boolean) => {
    const partes: string[] = ['From: a@x.example', `Content-Type: multipart/mixed; boundary="B0"`, ''];
    for (let i = 1; i <= n; i++) partes.push(`--B${i - 1}`, `Content-Type: multipart/mixed; boundary="B${i}"`, '');
    partes.push(`--B${n}`, 'Content-Type: text/plain', '', 'fondo');
    if (cerrar) for (let i = n; i >= 0; i--) partes.push(`--B${i}--`);
    return Buffer.from(partes.join('\r\n'));
  };

  it(`acepta hasta ${MAX_MULTIPART_DEPTH} niveles y marca más como demasiado profundo`, () => {
    expect(scanMimeStructure(anidado(MAX_MULTIPART_DEPTH - 1, true))).toEqual({ truncated: false, tooDeep: false });
    expect(scanMimeStructure(anidado(MAX_MULTIPART_DEPTH, true)).tooDeep).toBe(true);
  });

  it('100 000 niveles no desbordan la pila y terminan rápido', async () => {
    const inicio = Date.now();
    const r = await analyze(anidado(100_000, true), 'eml', { institutionalDomains: INST });
    expect(r).toMatchObject({ status: 'limited', limitedReason: 'parse_error', links: [] });
    expect(Date.now() - inicio).toBeLessThan(5000);
  });

  it('un multipart sin delimitador final está truncado', () => {
    expect(scanMimeStructure(anidado(2, false)).truncated).toBe(true);
  });
});

describe('regla 3: dominios parecidos', () => {
  it('el dominio exacto y sus subdominios no disparan; las imitaciones sí', () => {
    expect(imitatedDomain('universidad-ejemplo.example', INST)).toBeNull();
    expect(imitatedDomain('portal.universidad-ejemplo.example', INST)).toBeNull();
    for (const d of ['un1versidad-ejemplo.example', 'universidad-ejernplo.example', 'universidad-ejemp1o.example', 'portal.universidad-ejenplo.example']) {
      expect(imitatedDomain(d, INST), d).toBe('universidad-ejemplo.example');
    }
    expect(imitatedDomain('banco-ejemplo.example', INST)).toBeNull();
  });

  it('distancia de edición con corte', () => {
    expect(editDistance('kitten', 'sitting', 5)).toBe(3);
    expect(editDistance('abc', 'abcdefgh', 2)).toBe(3);
  });
});

describe('autenticación (D-016, solo informativa)', () => {
  it('lee Authentication-Results y Received-SPF; null si no hay', () => {
    const lineas = [
      { key: 'authentication-results', line: 'Authentication-Results: mx.example; spf=softfail\r\n smtp.mailfrom=x; dkim=pass; dmarc=temperror' },
      { key: 'received-spf', line: 'Received-SPF: pass (otro)' },
    ];
    expect(readAuthentication(lineas)).toEqual({ spf: 'fail', dkim: 'pass', dmarc: 'unknown' });
    expect(readAuthentication([{ key: 'received-spf', line: 'Received-SPF: none' }])).toEqual({ spf: 'none', dkim: 'unknown', dmarc: 'unknown' });
    expect(readAuthentication([{ key: 'subject', line: 'Subject: x' }])).toBeNull();
  });
});

describe('analyze(): casos extra', () => {
  it('R1 no dispara con el mismo dominio y otro buzón; R2 ignora "www."', async () => {
    const r = await analyze(
      eml([
        'From: A <a@banco.example>',
        'Reply-To: b@banco.example',
        'Date: Tue, 10 Nov 2026 10:00:00 -0600',
        'Content-Type: text/html',
        '',
        '<a href="https://banco.example/x">www.banco.example</a>',
      ]),
      'eml',
      { institutionalDomains: INST },
    );
    expect(r.findings).toEqual([]);
    expect(r.status).toBe('completed');
  });

  it('un texto pegado que empieza como encabezado pero sin From ni Date queda limitado', async () => {
    const r = await analyze(Buffer.from('Nota: revisa esto\n\nhttp://203.0.113.45/'), 'paste', { institutionalDomains: INST });
    expect(r).toMatchObject({ status: 'limited', limitedReason: 'missing_headers' });
  });

  it('asunto y remitente se recortan y el tope de enlaces se respeta', async () => {
    const muchos = Array.from({ length: 500 }, (_, i) => `<a href="https://s${i}.example/">x</a>`).join('');
    const r = await analyze(
      eml(['From: a@x.example', 'Date: Tue, 10 Nov 2026 10:00:00 -0600', `Subject: ${'a'.repeat(5000)}`, 'Content-Type: text/html', '', muchos]),
      'eml',
      { institutionalDomains: INST },
    );
    expect(r.subject!.length).toBeLessThanOrEqual(300);
    expect(r.links.length).toBe(200);
  });

  it('nunca lanza con basura binaria', async () => {
    const basura = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256));
    await expect(analyze(basura, 'eml', { institutionalDomains: INST })).resolves.toMatchObject({ status: 'limited' });
  });

  it('prioridad provisional por pesos', () => {
    const f = (ruleId: 'R1' | 'R2' | 'R6') => ({ ruleId, ruleName: 'x', summary: 'x', evidence: [] });
    expect(priorityOf([])).toBe('low');
    expect(priorityOf([f('R1')])).toBe('low');
    expect(priorityOf([f('R2')])).toBe('medium');
    expect(priorityOf([f('R1'), f('R6')])).toBe('high');
  });
});
