import { SHORTENERS, EXECUTABLE_SUFFIXES, RISKY_TLDS, LURE_WORDS, REDIRECT_PARAMS } from './url-signal-lists.js';

/** Señales de la forma de una URL, sin consultas a la red ni datos del correo en la salida. */
export type UrlSignal = { code: string; label: string; strength: 'strong' | 'weak' };

const signal = (code: string, label: string, strength: UrlSignal['strength']): UrlSignal => ({ code, label, strength });

/**
 * Evalúa una dirección sin visitarla. La query solo se inspecciona en memoria: no se guarda ni
 * se devuelve en la evidencia. Dos señales débiles independientes justifican R9:
 * "sin cifrar" + una palabra común no basta sin una señal estructural.
 */
export function evaluarSenalesUrl(raw: string, riskyTlds: ReadonlySet<string> = RISKY_TLDS): UrlSignal[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];

  const signals: UrlSignal[] = [];
  if (url.username || url.password) signals.push(signal('userinfo', 'Usuario en la dirección antes del destino', 'strong'));
  if (SHORTENERS.has(url.hostname)) signals.push(signal('shortener', 'Servicio de acortamiento de enlaces', 'strong'));
  if (EXECUTABLE_SUFFIXES.some((suffix) => url.pathname.toLowerCase().endsWith(suffix))) {
    signals.push(signal('executable', 'Ruta que termina en una extensión ejecutable', 'strong'));
  }
  for (const [key, value] of url.searchParams) {
    if (!REDIRECT_PARAMS.has(key.toLowerCase()) || value.length > 2048) continue;
    try {
      const target = new URL(value, url.origin);
      if (['http:', 'https:'].includes(target.protocol) && target.hostname !== url.hostname) {
        signals.push(signal('redirect', 'Parámetro de redirección a otro dominio', 'strong'));
        break;
      }
    } catch {
      // Un valor que no es URL no justifica una alerta.
    }
  }

  if (LURE_WORDS.test(`${url.hostname}${url.pathname}`)) signals.push(signal('lure', 'Palabras de acceso o verificación en host o ruta', 'weak'));
  if (url.hostname.split('.').length >= 5) signals.push(signal('subdomains', 'Muchos niveles de subdominio', 'weak'));
  if (riskyTlds.has(url.hostname.split('.').at(-1)!)) signals.push(signal('tld', 'Terminación de dominio que requiere revisión', 'weak'));
  if (url.protocol === 'http:') signals.push(signal('http', 'Conexión sin cifrar', 'weak'));
  if ((url.pathname.match(/%[0-9a-f]{2}/gi) ?? []).length >= 6) signals.push(signal('encoding', 'Ruta con codificación excesiva', 'weak'));

  return signals;
}

export function suficientesSenales(signals: readonly UrlSignal[]): boolean {
  const weak = signals.filter((s) => s.strength === 'weak');
  return signals.some((s) => s.strength === 'strong') ||
    (weak.length >= 2 && weak.some((s) => ['subdomains', 'tld', 'encoding'].includes(s.code)));
}
