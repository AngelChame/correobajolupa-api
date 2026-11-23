import { Parser } from 'htmlparser2';
import sanitizeHtml from 'sanitize-html';
import { normalizeLink } from '../analysis/links.js';
import { defangText } from './text.js';

/**
 * HTML del correo para el visor (D-035), en dos pasos:
 *
 *  1. Reescritura propia con htmlparser2: se descartan con todo su contenido script, style,
 *     head, svg, math, iframe, object…; cada <a>/<area> pasa a texto con su destino desactivado al
 *     lado (D-017, la misma función que el análisis); las imágenes remotas pasan a un texto; los
 *     comentarios (también los condicionales de Outlook) y las secciones <![CDATA[ desaparecen. El
 *     texto visible también pasa por defangText: una URL escrita como texto queda desactivada.
 *     La salida se vuelve a escribir desde los tokens, escapando texto y atributos: lo que llega al
 *     navegador es solo lo que el parser entendió (sin trucos de desincronización como el de
 *     <![CDATA[ de GHSA-2rjc-9xvg-45j7).
 *  2. sanitize-html con una lista de permitidos: etiquetas de texto y tablas, atributos mínimos y
 *     style solo con propiedades seguras. Es la segunda barrera aunque el paso 1 fallara.
 *
 * Además, el documento se sirve con CSP `sandbox; default-src 'none'` en un iframe sandbox.
 */

/** Tope de HTML que se sanea; más grande, se responde el documento de respaldo. */
export const MAX_HTML_CHARS = 2_000_000;

const ALLOWED_TAGS = [
  'p', 'br', 'div', 'span', 'b', 'i', 'u', 'strong', 'em', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
];

/** Se descartan junto con todo lo que tienen dentro (su texto no es contenido visible). */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'head', 'title', 'noscript', 'template', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'svg', 'math', 'xmp', 'noembed', 'noframes', 'textarea', 'select',
]);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Solo imágenes rasterizadas incrustadas; nunca SVG (puede llevar scripts). */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

const escapeText = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttr = (s: string) => escapeText(s).replaceAll('"', '&quot;');

function defanged(href: string | undefined): string | null {
  if (!href) return null;
  return normalizeLink({ raw: href, displayText: null }, 0)?.defangedUrl ?? null;
}

/** Paso 1. Sin recursión: un HTML con miles de niveles no desborda la pila. */
function rewrite(html: string): string {
  const out: string[] = [];
  const links: (string | null)[] = [];
  let skip = 0;
  // El parser puede entregar un mismo texto en varios trozos (por ejemplo, alrededor de una
  // entidad): se juntan antes de desactivar URL, para no partir una en dos.
  let texto = '';
  const volcarTexto = () => {
    if (texto !== '') out.push(escapeText(defangText(texto)));
    texto = '';
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        volcarTexto();
        if (skip > 0 || DROP_WITH_CONTENT.has(name)) {
          skip++;
          return;
        }
        if (name === 'a') {
          links.push(defanged(attribs.href));
          out.push('<span>');
          return;
        }
        if (name === 'area') {
          const d = defanged(attribs.href);
          const alt = attribs.alt?.trim();
          if (alt) out.push(escapeText(defangText(alt)));
          if (d) out.push(` [${escapeText(d)}]`);
          return;
        }
        if (name === 'img') {
          const src = attribs.src?.trim() ?? '';
          if (DATA_IMAGE.test(src)) {
            const alt = attribs.alt ? ` alt="${escapeAttr(attribs.alt)}"` : '';
            out.push(`<img src="${escapeAttr(src.replace(/\s+/g, ''))}"${alt}>`);
          } else {
            out.push('[imagen remota bloqueada]');
          }
          return;
        }
        const attrs = Object.entries(attribs)
          .filter(([key]) => /^[a-z][a-z0-9-]*$/.test(key))
          .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
          .join('');
        out.push(`<${name}${attrs}>`);
      },
      ontext(text) {
        if (skip === 0) texto += text;
      },
      onclosetag(name) {
        volcarTexto();
        if (skip > 0) {
          skip--;
          return;
        }
        if (name === 'a') {
          const d = links.pop();
          out.push('</span>');
          if (d) out.push(` [${escapeText(d)}]`);
          return;
        }
        if (VOID.has(name)) return;
        out.push(`</${name}>`);
      },
      // Comentarios, <![CDATA[, <!DOCTYPE> y <?…?>: fuera.
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeCDATA: false },
  );
  parser.write(html);
  parser.end();
  volcarTexto();
  return out.join('');
}

/** Valores de style sin url(), expression, @import, javascript:, escapes CSS (\) ni comentarios. */
const SAFE_CSS_VALUE = /^(?!.*(?:url|expression|import|javascript|behavior|binding))[-#%.,()\w\s'"!]+$/i;
const STYLE_PROPERTIES = [
  'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'text-align', 'text-decoration', 'vertical-align',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-collapse',
  'width', 'min-width', 'max-width',
];

const TABLE_CELL_ATTRS = ['colspan', 'rowspan', 'align', 'valign', 'width'];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    '*': ['style'],
    img: ['src', 'alt'],
    table: ['width', 'border', 'cellpadding', 'cellspacing', 'align'],
    td: TABLE_CELL_ATTRS,
    th: TABLE_CELL_ATTRS,
  },
  allowedStyles: { '*': Object.fromEntries(STYLE_PROPERTIES.map((p) => [p, [SAFE_CSS_VALUE]])) },
  // Ningún esquema en general; solo data: en <img> (ya filtrado a png/jpeg/gif/webp en el paso 1).
  allowedSchemes: [],
  allowedSchemesByTag: { img: ['data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'action', 'formaction', 'background', 'poster'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: [...DROP_WITH_CONTENT],
  parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
};

const DOC_HEAD =
  '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
  '<style>body{font-family:system-ui,sans-serif;margin:16px;overflow-wrap:anywhere}img{max-width:100%}</style></head><body>';
const DOC_TAIL = '</body></html>';

/** Documento de respaldo: cuando el HTML no se puede mostrar de forma segura. */
export const FALLBACK_HTML =
  `${DOC_HEAD}<p>No se pudo mostrar la versión HTML de este correo de forma segura. Usa la pestaña de texto.</p>${DOC_TAIL}`;

/** HTML del correo → documento completo y saneado. Nunca lanza: ante cualquier problema, el respaldo. */
export function renderSafeHtml(html: string): { html: string; fallback: boolean } {
  if (html.length > MAX_HTML_CHARS) return { html: FALLBACK_HTML, fallback: true };
  try {
    return { html: `${DOC_HEAD}${sanitizeHtml(rewrite(html), SANITIZE_OPTIONS)}${DOC_TAIL}`, fallback: false };
  } catch {
    return { html: FALLBACK_HTML, fallback: true };
  }
}
