import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { defangEmail, defangHost, defangUrlValue, normalizeLink } from '../analysis/links.js';
import type { IndicatorType } from '../generated/prisma/enums.js';
import { isValidAceLabel } from './punycode.js';

/**
 * Normalización de indicadores (M5). El valor propuesto es texto hostil: aquí se convierte en
 * una forma canónica (la que se guarda y se compara con los mensajes indexados) o se rechaza con
 * un mensaje fijo que nunca repite lo recibido. Nunca se resuelve ni se visita nada (D-017).
 */

export type Normalized = {
  /** Valor canónico que se guarda. */
  value: string;
  /** Host que se compara con la lista de exclusión (P-11); null para un SHA-256. */
  host: string | null;
};

export type NormalizeResult = ({ ok: true } & Normalized) | { ok: false; message: string };

const MAX_DOMAIN = 253;
const MAX_URL = 2048;
const MAX_LOCAL_PART = 64;
const MAX_ADDRESS = 254;

/** Mensajes fijos por tipo: nunca llevan el valor recibido. */
export const INVALID_VALUE: Record<IndicatorType, string> = {
  domain: 'El valor no es un dominio ni una dirección IP válidos.',
  url: 'El valor no es una URL http o https válida (sin usuario ni contraseña).',
  sha256: 'El valor no es un SHA-256 (64 caracteres hexadecimales).',
  sender: 'El valor no es una dirección de correo válida.',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Parte local sin comillas (dot-atom de RFC 5322), ya en minúsculas. */
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

const fail = (type: IndicatorType): NormalizeResult => ({ ok: false, message: INVALID_VALUE[type] });

/**
 * Nombre de dominio en minúsculas y punycode, sin punto final; null si no es válido. Exige al
 * menos dos etiquetas de letras, dígitos y guiones (1 a 63 caracteres) y 253 en total.
 */
export function normalizeDomainName(input: string): string | null {
  // Una etiqueta ACE (xn--) se acepta solo en su forma canónica, en minúsculas.
  if (input.split('.').some((l) => /^xn--/i.test(l.trim()) && l !== l.toLowerCase())) return null;
  let s = input.trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s === '' || /[\s/\\@:?#[\]%]/.test(s)) return null;
  // IDN a punycode (UTS-46, como los navegadores). Devuelve '' si no es un dominio válido.
  const ascii = domainToASCII(s);
  if (ascii === '' || ascii.length > MAX_DOMAIN) return null;
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  // domainToASCII no valida igual las etiquetas xn-- en todas las versiones de Node 24: se
  // decodifican y se vuelven a codificar con punycode propio (RFC 3492).
  if (!labels.every(isValidAceLabel)) return null;
  // Termina en número y no es una IPv4: el algoritmo de URL lo trataría como IP inválida.
  if (/^\d+$/.test(labels.at(-1)!)) return null;
  return ascii;
}

/**
 * Host de un indicador domain: un nombre de dominio, una IPv4 (con puntos) o una IPv6. La IPv6
 * se guarda entre corchetes y comprimida, igual que el host de los enlaces indexados (WHATWG).
 */
export function normalizeHost(input: string): string | null {
  const s = input.trim();
  if (isIP(s) === 4) return s;
  const v6 = s.replace(/^\[(.*)\]$/, '$1');
  if (isIP(v6) === 6) {
    try {
      return new URL(`http://[${v6}]/`).hostname;
    } catch {
      return null;
    }
  }
  return normalizeDomainName(s);
}

function normalizeUrl(input: string): NormalizeResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return fail('url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('url');
  // Credenciales en la URL (http://usuario:clave@host): no se guardan nunca.
  if (url.username !== '' || url.password !== '' || url.hostname === '') return fail('url');
  // La misma normalización que los enlaces de M1 y M4: sin query ni fragmento, host en minúsculas y punycode.
  const link = normalizeLink({ raw: url.href, displayText: null }, 0);
  if (!link || `${url.protocol}//${url.host}${url.pathname}`.length > MAX_URL) return fail('url');
  return { ok: true, value: link.normalizedUrl, host: url.hostname };
}

function normalizeSender(input: string): NormalizeResult {
  const s = input.trim();
  const at = s.lastIndexOf('@');
  if (at <= 0) return fail('sender');
  const local = s.slice(0, at).toLowerCase();
  // El dominio va tal cual: normalizeDomainName lo pasa a minúsculas y antes revisa sus etiquetas xn--.
  const domain = normalizeDomainName(s.slice(at + 1));
  if (local.length > MAX_LOCAL_PART || !LOCAL_PART.test(local) || !domain) return fail('sender');
  const value = `${local}@${domain}`;
  if (value.length > MAX_ADDRESS) return fail('sender');
  return { ok: true, value, host: domain };
}

/** Normaliza el valor de un indicador según su tipo. */
export function normalizeIndicator(type: IndicatorType, input: string): NormalizeResult {
  switch (type) {
    case 'domain': {
      const host = normalizeHost(input);
      return host ? { ok: true, value: host, host } : fail('domain');
    }
    case 'url':
      return normalizeUrl(input);
    case 'sha256': {
      const value = input.trim().toLowerCase();
      return SHA256.test(value) ? { ok: true, value, host: null } : fail('sha256');
    }
    case 'sender':
      return normalizeSender(input);
  }
}

/** Forma desactivada para la API (D-017): `dominio[.]com`, `hxxps://…`, `rh@dominio[.]com`. */
export function defangIndicator(type: IndicatorType, value: string): string {
  switch (type) {
    case 'domain':
      return defangHost(value);
    case 'url':
      return defangUrlValue(value);
    case 'sender':
      return defangEmail(value);
    case 'sha256':
      return value;
  }
}
