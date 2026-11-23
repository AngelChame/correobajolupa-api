import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readHtml, readText } from '../src/viewer/read.js';
import { FALLBACK_HTML, MAX_HTML_CHARS, renderSafeHtml } from '../src/viewer/sanitize.js';
import { defangText } from '../src/viewer/text.js';

// Visor del correo (D-035): HTML saneado y texto con URL desactivadas. Datos sintéticos.
const FIXTURES = new URL('./fixtures/', import.meta.url);
const eml = (nombre: string) => readFileSync(new URL(`emails/${nombre}.eml`, FIXTURES));
const sanear = (html: string) => renderSafeHtml(html).html;

/** Nada que el navegador pueda seguir o cargar: ningún href, ningún src salvo imágenes data:. */
function sinEnlacesNiRecursos(salida: string) {
  expect(salida).not.toMatch(/\bhref\s*=/i);
  for (const m of salida.matchAll(/\bsrc\s*=\s*"([^"]*)"/gi)) expect(m[1]).toMatch(/^data:image\/(png|jpeg|gif|webp);base64,/);
  expect(salida).not.toMatch(/(?<!x)https?:\/\//i);
}

describe('saneado del HTML: H01 contra expected.json', () => {
  it('no contiene nada de forbiddenInSanitizedHtml y conserva mustKeepInSanitizedHtml', async () => {
    const expected = z
      .object({ cases: z.array(z.looseObject({ id: z.string(), forbiddenInSanitizedHtml: z.array(z.string()).optional(), mustKeepInSanitizedHtml: z.array(z.string()).optional() })) })
      .parse(JSON.parse(readFileSync(new URL('expected.json', FIXTURES), 'utf8')));
    const h01 = expected.cases.find((c) => c.id === 'H01-html-hostil')!;
    const salida = sanear((await readHtml(eml('H01-html-hostil'), 'eml'))!);

    expect(h01.forbiddenInSanitizedHtml?.length).toBeGreaterThan(0);
    for (const prohibido of h01.forbiddenInSanitizedHtml!) expect(salida.toLowerCase(), prohibido).not.toContain(prohibido.toLowerCase());
    for (const texto of h01.mustKeepInSanitizedHtml!) expect(salida).toContain(texto);
    sinEnlacesNiRecursos(salida);
  });

  it.each(['L01-boletin-legitimo', 'R2-texto-enlace-enganoso', 'C1-combinado-reglas-1-2-5'])('%s: sin href ni src remoto', async (nombre) => {
    sinEnlacesNiRecursos(sanear((await readHtml(eml(nombre), 'eml'))!));
  });
});

describe('vectores de XSS', () => {
  const vectores: [string, string][] = [
    ['onerror', '<img src=x onerror=alert(1)>'],
    ['onload en body', '<body onload=alert(1)><p>hola</p></body>'],
    ['javascript: en mayúsculas', '<a href="JaVaScRiPt:alert(1)">uno</a>'],
    ['javascript: con tabulador', '<a href="java&#09;script:alert(2)">dos</a>'],
    ['javascript: con entidad', '<a href="&#x6A;avascript:alert(3)">tres</a>'],
    ['vbscript:', '<a href="vbscript:msgbox(4)">cuatro</a>'],
    ['svg con script', '<svg onload=alert(1)><script>alert(1)</script></svg>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=http://203.0.113.45/">'],
    ['base', '<base href="http://203.0.113.45/"><p>x</p>'],
    ['CSS url()', '<div style="background:url(http://203.0.113.45/a.png);color:red">x</div>'],
    ['CSS expression', '<div style="width:expression(alert(1))">x</div>'],
    ['@import', '<style>@import url(http://203.0.113.45/i.css);</style><p>x</p>'],
    ['position fija', '<div style="position:fixed;top:0;left:0">x</div>'],
    ['escape CSS', '<div style="color:\\72 ed;background-image:u\\72l(x)">x</div>'],
    ['comentario condicional', '<!--[if mso]><script>alert(1)</script><img src="http://203.0.113.45/o.gif"><![endif]--><p>x</p>'],
    ['CDATA (GHSA-2rjc)', '<p><![CDATA[><img src=x onerror=alert(1)>]]></p>'],
    ['CDATA con noscript', '<![CDATA[<noscript>]]><img src=x onerror=alert(1)></noscript>'],
    ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['object y embed', '<object data="http://203.0.113.45/o"></object><embed src="http://203.0.113.45/e">'],
    ['form', '<form action="http://203.0.113.45/p"><input name="u"><button formaction="javascript:alert(1)">Enviar</button></form>'],
    ['imagen svg en data:', '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">'],
    ['src protocolo relativo', '<img src="//203.0.113.45/a.png">'],
    ['math', '<math><mtext><style><img src=x onerror=alert(1)></style></mtext></math>'],
  ];

  it.each(vectores)('%s', (_nombre, html) => {
    const salida = sanear(html);
    const cuerpo = salida.slice(salida.indexOf('<body>'));
    expect(cuerpo).not.toMatch(/<(script|style|svg|math|iframe|object|embed|form|input|button|meta|base|link)\b/i);
    expect(cuerpo).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(cuerpo).not.toMatch(/javascript:|vbscript:|expression\(|url\(|@import|position\s*:/i);
    expect(cuerpo).not.toContain('<!--');
    expect(cuerpo).not.toMatch(/alert\(/);
    sinEnlacesNiRecursos(cuerpo);
  });

  it('el enlace queda como texto con su destino desactivado (sin query)', () => {
    expect(sanear('<a href="https://sitio.example/ruta?x=1">Entrar</a>')).toContain('<span>Entrar</span> [hxxps://sitio[.]example/ruta]');
    expect(sanear('<map><area href="http://203.0.113.45/" alt="zona"></map>')).toContain('zona [hxxp://203[.]0[.]113[.]45/]');
  });

  it('imágenes: remotas bloqueadas; data: png se conserva', () => {
    expect(sanear('<img src="https://img.example/a.png" alt="logo">')).toContain('[imagen remota bloqueada]');
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanear(`<img src="${png}" alt="p">`)).toContain(`<img src="${png}" alt="p" />`);
  });

  it('conserva texto, tablas y estilos permitidos', () => {
    const salida = sanear('<table><tr><td colspan="2" style="color:#ff0000;text-align:center" onclick="x()">Celda</td></tr></table>');
    expect(salida).toContain('<td colspan="2" style="color:#ff0000;text-align:center">Celda</td>');
  });

  it('respaldo si el HTML es demasiado grande, y anidamiento profundo sin romperse', () => {
    expect(renderSafeHtml('a'.repeat(MAX_HTML_CHARS + 1))).toEqual({ html: FALLBACK_HTML, fallback: true });
    expect(FALLBACK_HTML).toContain('pestaña de texto');
    const profundo = renderSafeHtml(`${'<div>'.repeat(20_000)}fondo${'</div>'.repeat(20_000)}`);
    expect(profundo.html).toContain('fondo');
  });
});

describe('texto con URL desactivadas', () => {
  it('desactiva URL, www, esquemas peligrosos y dominios de correos', () => {
    const entrada = [
      'Entra a https://Banco.example/acceso?x=1 o http://203.0.113.45/a.',
      'También www.banco.example y ftp://archivos.example/x',
      'javascript:alert(1) data:text/html,x',
      'Escribe a soporte@universidad-ejernplo.example',
    ].join('\n');
    const salida = defangText(entrada);
    expect(salida).toBe(
      [
        'Entra a hxxps://Banco[.]example/acceso?x=1 o hxxp://203[.]0[.]113[.]45/a.',
        'También www[.]banco[.]example y ftp[:]//archivos[.]example/x',
        'javascript[:]alert(1) data[:]text/html,x',
        'Escribe a soporte@universidad-ejernplo[.]example',
      ].join('\n'),
    );
    expect(salida).not.toMatch(/https?:\/\/|www\.|\w@\w+\.\w/);
  });

  it('el texto de un correo solo HTML se deriva del HTML, y queda desactivado', async () => {
    const texto = defangText(await readText(eml('R2-texto-enlace-enganoso'), 'eml'));
    expect(texto).toContain('hoy mismo');
    expect(texto).not.toMatch(/https?:\/\//);
  });
});
