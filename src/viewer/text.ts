import { defangHost } from '../analysis/links.js';

/**
 * Desactiva toda URL de un texto para la pestaña de texto (D-017; convención 7 del contrato):
 * nada debe quedar clicable aunque el front aplicara un autolink por error.
 *  - esquema://host… → hxxp(s)://host[.]…  (otros esquemas: esquema[:]//host[.]…)
 *  - javascript:, vbscript:, data: → esquema[:]
 *  - www.host → www[.]host
 *  - correo@dominio → correo@dominio[.]tld
 * El resto del texto (ruta, query) se deja igual: es el contenido del correo, solo sin enlace.
 */
export function defangText(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]{0,20}):\/\/([^\s/?#<>"'`]*)/gi, (_m, scheme: string, host: string) => {
      const s = scheme.toLowerCase();
      const prefix = s === 'http' || s === 'https' ? `${s.replace(/^http/, 'hxxp')}://` : `${scheme}[:]//`;
      return `${prefix}${defangHost(host)}`;
    })
    .replace(/\b(javascript|vbscript|data):/gi, '$1[:]')
    .replace(/\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, (host) => defangHost(host))
    .replace(/\b([\w.+-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi, (_m, local: string, domain: string) => `${local}@${defangHost(domain)}`);
}

/** Dominio suelto (sin esquema ni www.) con TLD alfabético, o IPv4; no toca lo ya desactivado. */
const BARE_HOST = /\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/gi;

/**
 * Desactiva un texto corto que puede ser o contener una dirección (texto visible de un enlace):
 * lo mismo que defangText y, además, dominios e IP sueltos ("banco.example" → "banco[.]example").
 * Prefiere desactivar de más: un "archivo.pdf" sale como "archivo[.]pdf", que sigue legible.
 */
export function defangLooseText(text: string): string {
  return defangText(text).replace(BARE_HOST, (host) => defangHost(host));
}

/**
 * Dirección de correo como indicador (D-017): "usuario@dominio.com" → "usuario[@]dominio[.]com".
 * Más fuerte que defangEmail (que deja la @): así ni un autolink de correo la reconoce. El buzón se
 * deja igual y se corta en la última @. Sin @, solo se desactivan los puntos.
 */
export function defangAddress(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? defangHost(address) : `${address.slice(0, at)}[@]${defangHost(address.slice(at + 1))}`;
}
