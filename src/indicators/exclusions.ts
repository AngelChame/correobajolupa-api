import { isIP } from 'node:net';
import type { Db } from '../db/client.js';
import { normalizeDomainName } from './normalize.js';

/**
 * Lista de exclusión (P-11, D-019): dominios que nunca pueden ser indicadores, como los
 * institucionales. Un dominio excluido cubre el dominio y sus subdominios, con frontera de
 * etiqueta: `portal.universidad-ejemplo.example` sí, `xuniversidad-ejemplo.example` no
 * (decisión provisional de M5). Una IP solo se cubre a sí misma.
 */

/** ¿El dominio excluido cubre este host? Ambos ya normalizados. */
export function covers(excluded: string, host: string): boolean {
  return host === excluded || (!isIpHost(host) && host.endsWith(`.${excluded}`));
}

const isIpHost = (host: string) => isIP(host.replace(/^\[|\]$/g, '')) !== 0;

/**
 * Sufijos de un host con al menos dos etiquetas, de más largo a más corto:
 * `a.b.example` → [`a.b.example`, `b.example`]. Una IP solo da ella misma.
 */
export function domainSuffixes(host: string): string[] {
  if (isIpHost(host)) return [host];
  const labels = host.split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** Dominios institucionales de la configuración, normalizados igual que las exclusiones. */
export function configExclusions(institutionalDomains: readonly string[]): string[] {
  return [...new Set(institutionalDomains.map((d) => normalizeDomainName(d) ?? d.toLowerCase()))];
}

/**
 * ¿Algún dominio de la lista (configuración o tabla) cubre este host? Busca por los sufijos en el
 * índice único de exclusions: nunca recorre la tabla completa.
 */
export async function isExcluded(db: Pick<Db, 'exclusion'>, institutionalDomains: readonly string[], host: string): Promise<boolean> {
  if (configExclusions(institutionalDomains).some((d) => covers(d, host))) return true;
  const fila = await db.exclusion.findFirst({ where: { domain: { in: domainSuffixes(host) } }, select: { id: true } });
  return fila !== null;
}
