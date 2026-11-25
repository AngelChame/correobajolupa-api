import { domainToUnicode } from 'node:url';
import type { Priority } from '../generated/prisma/enums.js';
import { familiesOfDeclared, familiesOfExtension, familyOfDetected } from './attachments.js';
import { ALLOWED_SCHEMES, isIpHost } from './links.js';
import { imitatedDomain } from './lookalike.js';
import { evaluarSenalesUrl, suficientesSenales } from './url-signals.js';
import type { AnalyzedAttachment, AnalyzedLink, RawEvidence, RawFinding } from './types.js';

/** Versión de las reglas: se guarda en cada hallazgo y en el reporte. Sube al cambiar una regla. */
export const RULES_VERSION = 'm9-2026.11';

/** Evidencias por hallazgo como mucho (un correo con 200 enlaces malos no genera 200). */
const MAX_EVIDENCE = 10;

type RuleId = RawFinding['ruleId'];

const RULES: Record<RuleId, { name: string; summary: string; weight: number }> = {
  R1: {
    name: 'Reply-To distinto del remitente',
    summary: 'Las respuestas irían a un dominio distinto del que aparece como remitente.',
    weight: 1,
  },
  R2: {
    name: 'Texto del enlace distinto del destino',
    summary: 'El texto visible parece una dirección, pero el enlace lleva a otro sitio.',
    weight: 2,
  },
  R3: {
    name: 'Dominio parecido a uno institucional',
    summary: 'Un dominio imita a un dominio institucional configurado.',
    weight: 2,
  },
  R4: {
    name: 'Dominio internacionalizado',
    summary: 'Un enlace usa un dominio con caracteres no ASCII que pueden imitar letras normales.',
    weight: 2,
  },
  R5: {
    name: 'Destino como dirección IP',
    summary: 'Un enlace apunta a una dirección IP en lugar de a un dominio.',
    weight: 2,
  },
  R6: {
    name: 'Esquema de URL no permitido',
    summary: 'Un enlace usa un esquema que puede ejecutar código o incrustar contenido (javascript:, data:...).',
    weight: 3,
  },
  R7: {
    name: 'Doble extensión o tipo de adjunto inconsistente',
    summary: 'Un adjunto disfraza su tipo: doble extensión, caracteres que invierten el nombre o un contenido que no coincide con su extensión o su tipo declarado.',
    // Peso provisional (decisión abierta nº 3).
    weight: 3,
  },
  R9: {
    name: 'Señales en la dirección de un enlace',
    summary: 'La forma de una dirección web presenta señales que conviene revisar; ninguna demuestra peligro por sí sola.',
    weight: 2,
  },
};

/** Última extensión que ejecuta código al abrir el archivo en Windows (R7, doble extensión). */
const EXECUTABLE_EXTENSIONS = new Set(['exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'hta', 'jar', 'msi', 'lnk', 'cpl']);
/** Penúltima extensión que hace pasar el archivo por documento o imagen. */
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'jpg', 'jpeg', 'png', 'gif']);

/**
 * ¿El adjunto disfraza su tipo? (R7). name: doble extensión o caracteres de dirección de texto.
 * content: los bytes tienen una firma conocida que contradice la extensión o el tipo declarado
 * (sin firma conocida no hay contradicción que mostrar; un octet-stream genérico no se compara).
 */
function disguised(a: AnalyzedAttachment): { name: boolean; content: boolean } {
  const name =
    a.hasBidiControls ||
    (a.extension !== null && a.previousExtension !== null && EXECUTABLE_EXTENSIONS.has(a.extension) && DOCUMENT_EXTENSIONS.has(a.previousExtension));
  const detected = familyOfDetected(a.detectedType);
  const byExtension = familiesOfExtension(a.extension);
  const byDeclared = familiesOfDeclared(a.declaredType);
  const content =
    detected !== null && ((byExtension !== null && !byExtension.includes(detected)) || (byDeclared !== null && !byDeclared.includes(detected)));
  return { name, content };
}

/** Dominio de una dirección de correo, en minúsculas. */
export function emailDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  const domain = at === -1 ? '' : address.slice(at + 1).trim().toLowerCase();
  return domain === '' ? null : domain;
}

/** Texto visible con forma de URL o dominio (una sola palabra con TLD alfabético); su host o null. */
function hostInText(text: string): string | null {
  const t = text.trim();
  if (/\s/.test(t) || t.includes('@')) return null;
  const conEsquema = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
  let url: URL;
  try {
    url = new URL(conEsquema);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (!/^(?:[a-z0-9-]+\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(host)) return null;
  return host;
}

const sinWww = (host: string) => host.replace(/^www\./, '');

export type RuleInput = {
  fromAddress: string | null;
  replyTo: readonly string[];
  links: readonly AnalyzedLink[];
  attachments?: readonly AnalyzedAttachment[];
  institutionalDomains: readonly string[];
};

/** Hallazgo R9 para enlaces no excluidos; se puede recalcular con exclusiones manuales del worker. */
export function findUrlFinding(
  links: readonly AnalyzedLink[],
  institutionalDomains: readonly string[],
  excludedDomains: readonly string[] = [],
): RawFinding | null {
  const evidence: RawEvidence[] = [];
  const excluded = [...institutionalDomains, ...excludedDomains].map((d) => d.toLowerCase());
  for (const link of links) {
    if (link.scheme !== 'http' && link.scheme !== 'https') continue;
    const host = link.domain;
    if (!host || excluded.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    const signals = evaluarSenalesUrl(link.raw);
    if (!suficientesSenales(signals)) continue;
    if (evidence.length >= MAX_EVIDENCE) break;
    evidence.push({ label: 'Enlace', value: link.normalizedUrl, kind: 'url' });
    for (const s of signals) {
      if (evidence.length >= MAX_EVIDENCE) break;
      evidence.push({ label: 'Señal', value: s.label, kind: 'text' });
    }
  }
  return evidence.length > 0
    ? { ruleId: 'R9', ruleName: RULES.R9.name, summary: RULES.R9.summary, evidence }
    : null;
}

/** Aplica R1 a R7 y R9. Ninguna regla prueba phishing por sí sola. */
export function applyRules({ fromAddress, replyTo, links, attachments = [], institutionalDomains }: RuleInput): RawFinding[] {
  const evidence: Record<RuleId, RawEvidence[]> = { R1: [], R2: [], R3: [], R4: [], R5: [], R6: [], R7: [], R9: [] };
  const add = (rule: RuleId, ...items: RawEvidence[]) => {
    if (evidence[rule].length < MAX_EVIDENCE) evidence[rule].push(...items);
  };
  const fromDomain = fromAddress ? emailDomain(fromAddress) : null;

  // R1: Reply-To con otro dominio (mismo dominio y otro buzón no dispara).
  if (fromAddress && fromDomain) {
    for (const address of replyTo) {
      const d = emailDomain(address);
      if (d && d !== fromDomain) {
        add('R1', { label: 'Remitente (From)', value: fromAddress, kind: 'email' }, { label: 'Responder a (Reply-To)', value: address, kind: 'email' });
      }
    }
  }

  // R3 en el remitente y en Reply-To.
  for (const [label, address] of [['Remitente (From)', fromAddress], ...replyTo.map((a) => ['Responder a (Reply-To)', a])] as const) {
    const d = address ? emailDomain(address) : null;
    const inst = d ? imitatedDomain(d, institutionalDomains) : null;
    if (d && inst) add('R3', { label, value: d, kind: 'domain' }, { label: 'Dominio institucional', value: inst, kind: 'domain' });
  }

  for (const link of links) {
    // R6: esquema fuera de la lista permitida (después de que WHATWG quitó tabs y saltos).
    if (!ALLOWED_SCHEMES.has(link.scheme)) {
      add('R6', { label: 'Enlace', value: link.raw, kind: 'url' }, { label: 'Esquema', value: `${link.scheme}:`, kind: 'text' });
      continue;
    }
    const web = link.scheme === 'http' || link.scheme === 'https';
    const host = web ? link.domain : null;

    if (host) {
      // R5: el host es una IP (WHATWG ya convirtió decimal y hexadecimal a la forma con puntos).
      if (isIpHost(host)) {
        add('R5', { label: 'Enlace', value: link.raw, kind: 'url' }, { label: 'Dirección IP', value: host, kind: 'domain' });
      }
      // R4: etiquetas en punycode (new URL pasa a punycode cualquier carácter no ASCII).
      if (host.split('.').some((l) => l.startsWith('xn--')) || /[^\x00-\x7f]/.test(host)) {
        add('R4', { label: 'Dominio (punycode)', value: host, kind: 'domain' }, { label: 'Dominio (Unicode)', value: domainToUnicode(host), kind: 'domain' });
      }
      // R2: el texto visible parece una dirección con otro host.
      const textHost = link.displayText ? hostInText(link.displayText) : null;
      if (textHost && sinWww(textHost) !== sinWww(host)) {
        add('R2', { label: 'Texto visible', value: link.displayText!, kind: 'url' }, { label: 'Destino', value: link.normalizedUrl, kind: 'url' });
      }
    }
    // R3 en enlaces (web y mailto).
    const inst = link.domain && !isIpHost(link.domain) ? imitatedDomain(link.domain, institutionalDomains) : null;
    if (link.domain && inst) {
      add('R3', { label: 'Dominio del enlace', value: link.domain, kind: 'domain' }, { label: 'Dominio institucional', value: inst, kind: 'domain' });
    }
  }

  // R7: adjuntos con el tipo disfrazado. El nombre ya viene saneado y es texto, no un enlace.
  for (const a of attachments) {
    const { name, content } = disguised(a);
    if (!name && !content) continue;
    const items: RawEvidence[] = [
      { label: 'Archivo adjunto', value: a.fileName ?? '(sin nombre)', kind: 'text' },
      { label: 'Tipo declarado', value: a.declaredType ?? '(sin tipo)', kind: 'text' },
    ];
    if (content && a.detectedType) items.push({ label: 'Tipo detectado', value: a.detectedType, kind: 'text' });
    add('R7', ...items);
  }

  const findings = (Object.keys(RULES) as RuleId[])
    .filter((id) => evidence[id].length > 0)
    .map((id) => ({ ruleId: id, ruleName: RULES[id].name, summary: RULES[id].summary, evidence: evidence[id] }));
  const urlFinding = findUrlFinding(links, institutionalDomains);
  return urlFinding ? [...findings, urlFinding] : findings;
}

/** Prioridad provisional (pesos R1=1; R2-R5=2; R6 y R7=3): < 2 low, 2-3 medium, ≥ 4 high. */
export function priorityOf(findings: readonly RawFinding[]): Priority {
  const total = findings.reduce((sum, f) => sum + RULES[f.ruleId].weight, 0);
  return total >= 4 ? 'high' : total >= 2 ? 'medium' : 'low';
}
