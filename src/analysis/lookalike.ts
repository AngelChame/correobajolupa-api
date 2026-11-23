/**
 * Regla 3: ¿un dominio imita a uno institucional?
 *  - El dominio exacto o un subdominio suyo es legítimo: no dispara.
 *  - Dispara si, comparando el mismo número de etiquetas finales, coincide después de deshacer
 *    imitaciones comunes (0→o, 1→i/l, 3→e, 5→s, rn→m, vv→w) o si la distancia de edición es ≤ 2.
 */

/** Forma canónica: las imitaciones y sus originales caen en el mismo carácter. */
function canonical(domain: string): string {
  return domain
    .replaceAll('rn', 'm')
    .replaceAll('vv', 'w')
    .replace(/[01il|]/g, 'i')
    .replaceAll('3', 'e')
    .replaceAll('5', 's');
}

/** Distancia de Levenshtein con corte: deja de calcular en cuanto pasa de `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Devuelve el dominio institucional imitado, o null. Ambos en minúsculas. */
export function imitatedDomain(domain: string, institutional: readonly string[]): string | null {
  const d = domain.toLowerCase().replace(/\.$/, '');
  for (const inst of institutional) {
    if (d === inst || d.endsWith(`.${inst}`)) return null;
  }
  for (const inst of institutional) {
    const labels = inst.split('.').length;
    const tail = d.split('.').slice(-labels).join('.');
    if (tail === inst) continue;
    if (canonical(tail) === canonical(inst) || editDistance(tail, inst) <= 2) return inst;
  }
  return null;
}
