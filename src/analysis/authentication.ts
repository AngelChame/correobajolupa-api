import type { Authentication } from './types.js';

type Result = Authentication['spf'];

/** Resultado de Authentication-Results (RFC 8601) a los cuatro valores del contrato. */
function mapResult(value: string): Result {
  switch (value.toLowerCase()) {
    case 'pass':
      return 'pass';
    case 'fail':
    case 'softfail':
      return 'fail';
    case 'none':
      return 'none';
    default:
      // neutral, temperror, permerror, policy...
      return 'unknown';
  }
}

/**
 * SPF, DKIM y DMARC desde Authentication-Results (o Received-SPF para SPF). Solo informativo
 * (D-016): en un .eml subido estos encabezados se pueden inventar, así que nunca suman ni restan
 * puntaje. Se usa el primer resultado de cada método (el encabezado más alto, el del último
 * servidor). null si el correo no trae ninguno de esos encabezados.
 *
 * `headerLines` son las líneas crudas de mailparser: { key, line } con el encabezado completo.
 */
export function readAuthentication(headerLines: readonly { key: string; line: string }[]): Authentication | null {
  const results: Partial<Authentication> = {};
  let found = false;
  for (const { key, line } of headerLines) {
    const value = line.slice(line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ');
    if (key === 'authentication-results') {
      found = true;
      for (const m of value.matchAll(/\b(spf|dkim|dmarc)[ \t]*=[ \t]*([a-z]+)/gi)) {
        const method = m[1]!.toLowerCase() as keyof Authentication;
        results[method] ??= mapResult(m[2]!);
      }
    } else if (key === 'received-spf') {
      found = true;
      const first = /^[ \t]*([a-z]+)/i.exec(value)?.[1];
      if (first) results.spf ??= mapResult(first);
    }
  }
  if (!found) return null;
  return { spf: results.spf ?? 'unknown', dkim: results.dkim ?? 'unknown', dmarc: results.dmarc ?? 'unknown' };
}
