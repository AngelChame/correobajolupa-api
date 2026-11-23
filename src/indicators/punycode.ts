/**
 * Punycode (RFC 3492) mínimo para validar etiquetas `xn--` sin depender de la versión de Node:
 * `domainToASCII` cambió entre versiones de Node 24 y acepta etiquetas que no decodifican. Sin
 * dependencias y sin el módulo `punycode` de Node (deprecado). Solo se usa para validar.
 */

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_INT = 0x7fffffff;

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.floor(d / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
}

/** Valor de un dígito (a-z = 0-25, 0-9 = 26-35); BASE si no es dígito. */
function digitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  return BASE;
}

/** Dígito en minúsculas (forma canónica). */
const digitChar = (d: number) => String.fromCharCode(d < 26 ? d + 0x61 : d - 26 + 0x30);

const threshold = (k: number, bias: number) => (k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias);

/** Decodifica la parte después de `xn--`; null si no es punycode válido. */
export function decodePunycode(input: string): string | null {
  const basicEnd = Math.max(input.lastIndexOf('-'), 0);
  const output: number[] = [];
  for (let j = 0; j < basicEnd; j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    output.push(c);
  }
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  for (let idx = basicEnd > 0 ? basicEnd + 1 : 0; idx < input.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (idx >= input.length) return null;
      const digit = digitValue(input.charCodeAt(idx++));
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / w)) return null;
      i += digit * w;
      const t = threshold(k, bias);
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) return null;
      w *= BASE - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (Math.floor(i / out) > MAX_INT - n) return null;
    n += Math.floor(i / out);
    i %= out;
    // Solo puntos de código Unicode válidos, sin sustitutos.
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i, 0, n);
    i++;
  }
  return String.fromCodePoint(...output);
}

/** Codifica a punycode (sin el prefijo `xn--`), con dígitos en minúsculas. */
export function encodePunycode(input: string): string {
  const codes = Array.from(input, (ch) => ch.codePointAt(0)!);
  let output = codes.filter((c) => c < 0x80).map((c) => String.fromCharCode(c)).join('');
  const basic = output.length;
  let handled = basic;
  if (basic > 0) output += '-';
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < codes.length) {
    const m = Math.min(...codes.filter((c) => c >= n));
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of codes) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = threshold(k, bias);
          if (q < t) break;
          output += digitChar(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        output += digitChar(q);
        bias = adapt(delta, handled + 1, handled === basic);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return output;
}

/**
 * ¿Es válida una etiqueta ACE (`xn--…`) ya en minúsculas? Debe decodificar, no quedar vacía,
 * traer al menos un carácter no ASCII, no traer caracteres de control (solo letras, dígitos y
 * guiones ASCII o caracteres desde U+00A0) y volver a codificarse exactamente igual (forma canónica).
 */
export function isValidAceLabel(label: string): boolean {
  if (!label.startsWith('xn--')) return true;
  const encoded = label.slice(4);
  const decoded = decodePunycode(encoded);
  if (decoded === null || decoded === '' || !/[^\x00-\x7f]/.test(decoded)) return false;
  if (!/^(?:[a-z0-9-]|[^\x00-\x9f])+$/u.test(decoded)) return false;
  return encodePunycode(decoded) === encoded;
}
