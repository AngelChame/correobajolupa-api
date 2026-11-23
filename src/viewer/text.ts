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
