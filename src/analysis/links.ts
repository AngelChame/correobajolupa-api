import { isIP } from 'node:net';
import { Parser } from 'htmlparser2';
import type { AnalyzedLink } from './types.js';

/** Tope de enlaces por reporte: un correo con miles de enlaces no llena la base. */
export const MAX_LINKS = 200;
/** Recortes para guardar y mostrar: nada de esto debe crecer sin límite. */
const MAX_RAW = 500;
const MAX_DISPLAY_TEXT = 300;
const MAX_NORMALIZED = 2048;

/** Esquemas que no se consideran sospechosos por sí mismos (regla 6). */
export const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const WEB_SCHEMES = new Set(['http', 'https']);

type Candidate = { raw: string; displayText: string | null };

const recortar = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** decodeURIComponent que no lanza con un % mal formado (correo hostil). */
function decodificar(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * href de <a> y <area> del HTML. htmlparser2 decodifica las entidades (&#x6A; → j, &#09; → tab)
 * igual que un navegador, y nunca ejecuta nada: solo tokeniza.
 */
export function extractHtmlLinks(html: string): Candidate[] {
  const found: Candidate[] = [];
  // Pila de <a> abiertos para acumular su texto visible.
  const abiertos: { raw: string; text: string }[] = [];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (found.length + abiertos.length >= MAX_LINKS) return;
        const href = attribs.href;
        if (name === 'a') {
          abiertos.push({ raw: href ?? '', text: '' });
        } else if (name === 'area' && href !== undefined) {
          found.push({ raw: href, displayText: attribs.alt?.trim() || null });
        }
      },
      ontext(text) {
        const actual = abiertos.at(-1);
        if (actual && actual.text.length < MAX_DISPLAY_TEXT * 2) actual.text += text;
      },
      onclosetag(name) {
        if (name !== 'a') return;
        const a = abiertos.pop();
        if (a && a.raw !== '') {
          const texto = a.text.replace(/\s+/g, ' ').trim();
          found.push({ raw: a.raw, displayText: texto === '' ? null : recortar(texto, MAX_DISPLAY_TEXT) });
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return found;
}

/** URL del texto plano: http://, https:// o www. Sin texto visible. */
const TEXT_URL = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

export function extractTextUrls(text: string): Candidate[] {
  const found: Candidate[] = [];
  for (const match of text.matchAll(TEXT_URL)) {
    if (found.length >= MAX_LINKS) break;
    // Puntuación final que suele cerrar la frase y no la URL.
    const raw = match[0].replace(/[.,;:!?)\]}>]+$/, '');
    found.push({ raw: /^www\./i.test(raw) ? `http://${raw}` : raw, displayText: null });
  }
  return found;
}

/** Host desactivado: cada punto pasa a [.] (sirve para dominios e IPv4). */
export function defangHost(host: string): string {
  return host.replaceAll('.', '[.]');
}

/** Correo desactivado: el dominio con [.]; el buzón se deja igual. */
export function defangEmail(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? defangHost(address) : `${address.slice(0, at + 1)}${defangHost(address.slice(at + 1))}`;
}

/**
 * Forma desactivada de una URL ya parseada (D-017): hxxp/hxxps y [.] en el host. Para esquemas no
 * web solo se muestra el esquema desactivado; el resto (código, base64...) se recorta.
 */
function defangParsed(url: URL, normalizedUrl: string): string {
  const scheme = url.protocol.slice(0, -1);
  if (WEB_SCHEMES.has(scheme)) {
    const rest = normalizedUrl.slice(url.protocol.length + 2 + url.host.length);
    return `${scheme.replace(/^http/, 'hxxp')}://${defangHost(url.host)}${rest}`;
  }
  if (scheme === 'mailto') return `mailto[:]${defangEmail(decodificar(url.pathname))}`;
  if (scheme === 'tel') return `tel[:]${url.pathname}`;
  return `${scheme}[:]…`;
}

/**
 * Normaliza un href con el URL de WHATWG (new URL), el mismo algoritmo de los navegadores: quita
 * tabulaciones y saltos, pasa esquema y host a minúsculas, el host a punycode y las IP decimales
 * o hexadecimales a su forma con puntos. Las URL relativas o inválidas no son enlaces (null).
 */
export function normalizeLink(candidate: Candidate, position: number): AnalyzedLink | null {
  let url: URL;
  try {
    url = new URL(candidate.raw);
  } catch {
    return null;
  }
  const scheme = url.protocol.slice(0, -1);
  let normalizedUrl: string;
  let domain: string | null = null;
  if (WEB_SCHEMES.has(scheme)) {
    if (url.hostname === '') return null;
    normalizedUrl = `${url.protocol}//${url.host}${url.pathname}`;
    domain = url.hostname;
  } else {
    normalizedUrl = `${url.protocol}${url.pathname}`;
    if (scheme === 'mailto') {
      const address = decodificar(url.pathname);
      const at = address.lastIndexOf('@');
      domain = at === -1 ? null : address.slice(at + 1).toLowerCase() || null;
    }
  }
  normalizedUrl = recortar(normalizedUrl, MAX_NORMALIZED);
  return {
    position,
    displayText: candidate.displayText,
    raw: recortar(candidate.raw, MAX_RAW),
    scheme,
    normalizedUrl,
    defangedUrl: defangParsed(url, normalizedUrl),
    domain: domain && domain.length <= 253 ? domain : null,
  };
}

/** Desactiva un valor de evidencia de tipo URL (cruda o normalizada). */
export function defangUrlValue(value: string): string {
  try {
    const url = new URL(value);
    const scheme = url.protocol.slice(0, -1);
    const normalized = WEB_SCHEMES.has(scheme) ? `${url.protocol}//${url.host}${url.pathname}` : `${url.protocol}${url.pathname}`;
    return defangParsed(url, normalized);
  } catch {
    // Texto con forma de dominio o URL sin esquema: se desactivan los puntos y los ":".
    return value.replaceAll('.', '[.]').replaceAll(':', '[:]');
  }
}

/** Host sin corchetes de IPv6, para isIP. */
export function isIpHost(hostname: string): boolean {
  return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;
}
