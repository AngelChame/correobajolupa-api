import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { extractAttachments } from './attachments.js';
import { readAuthentication } from './authentication.js';
import { extractHtmlLinks, extractTextUrls, MAX_LINKS, normalizeLink } from './links.js';
import { applyRules, priorityOf, RULES_VERSION } from './rules.js';
import { headerBlock, PARSER_OPTIONS, prepareInput } from './read.js';
import type { AnalysisOptions, AnalysisResult, AnalyzedLink, ReportSource } from './types.js';

/** Recortes del asunto y el remitente: texto del correo, se guarda y se muestra escapado. */
const MAX_SUBJECT = 300;
const MAX_ADDRESS = 254;

const recortar = (s: string | undefined | null, max: number) => {
  const t = s?.trim();
  return t ? (t.length > max ? t.slice(0, max) : t) : null;
};

function addresses(field: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  return list.flatMap((a) => a.value.flatMap((v) => (v.address ? [v.address] : [])));
}

/**
 * Analiza un correo (.eml o texto pegado) sin base de datos ni disco. Nunca lanza por un correo
 * hostil: si algo no se puede leer, el resultado queda `limited` y se analiza lo que se pudo.
 *
 * - limited / parse_error: multipart truncado o con más de 15 niveles (se mira antes de parsear;
 *   si pasa de 15 solo se leen los encabezados).
 * - limited / missing_headers: falta From o Date, o el texto pegado no trae encabezados.
 */
export async function analyze(bytes: Uint8Array, source: ReportSource, options: AnalysisOptions): Promise<AnalysisResult> {
  const { input, missingHeaders, structure } = prepareInput(bytes, source);
  const parseError = structure.truncated || structure.tooDeep;

  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(structure.tooDeep ? headerBlock(input) : input, PARSER_OPTIONS);
  } catch {
    // Último recurso: solo encabezados; y si ni eso, un resultado vacío y limitado.
    try {
      parsed = await simpleParser(headerBlock(input), PARSER_OPTIONS);
    } catch {
      return emptyResult();
    }
    return finish(parsed, true, missingHeaders, options, false);
  }
  return finish(parsed, parseError, missingHeaders, options, !structure.tooDeep);
}

function finish(parsed: ParsedMail, parseError: boolean, missingHeaders: boolean, options: AnalysisOptions, withBody: boolean): AnalysisResult {
  const fromAddress = recortar(addresses(parsed.from)[0], MAX_ADDRESS);
  const replyTo = addresses(parsed.replyTo).slice(0, 10);
  const lacksHeaders = missingHeaders || !parsed.headers.has('from') || !parsed.headers.has('date');

  const html = withBody && typeof parsed.html === 'string' ? parsed.html : '';
  const text = withBody && typeof parsed.text === 'string' ? parsed.text : '';

  // Primero los del HTML (traen texto visible); luego las URL del texto plano que no estaban ya.
  // Duplicados fuera: mismo destino y mismo texto, o una URL del texto plano ya vista en el HTML.
  const links: AnalyzedLink[] = [];
  const pares = new Set<string>();
  const destinos = new Set<string>();
  for (const candidate of [...extractHtmlLinks(html), ...extractTextUrls(text)]) {
    if (links.length >= MAX_LINKS) break;
    const link = normalizeLink(candidate, links.length);
    if (!link) continue;
    const par = `${link.normalizedUrl}\n${link.displayText ?? ''}`;
    if (pares.has(par) || (link.displayText === null && destinos.has(link.normalizedUrl))) continue;
    pares.add(par);
    destinos.add(link.normalizedUrl);
    links.push(link);
  }

  // Si solo se leyeron encabezados (tooDeep o el parseo completo falló), no hay adjuntos.
  const { attachments, ignored } = withBody ? extractAttachments(parsed.attachments) : { attachments: [], ignored: 0 };

  const findings = applyRules({ fromAddress, replyTo, links, institutionalDomains: options.institutionalDomains });
  const limitedReason = parseError ? 'parse_error' : lacksHeaders ? 'missing_headers' : null;
  return {
    subject: recortar(parsed.subject, MAX_SUBJECT),
    fromAddress,
    status: limitedReason ? 'limited' : 'completed',
    limitedReason,
    hasHtml: html !== '',
    authentication: readAuthentication(parsed.headerLines),
    links,
    attachments,
    attachmentsIgnored: ignored,
    findings,
    priority: priorityOf(findings),
    rulesVersion: RULES_VERSION,
    decodedText: [parsed.subject ?? '', text, html].join('\n'),
  };
}

function emptyResult(): AnalysisResult {
  return {
    subject: null,
    fromAddress: null,
    status: 'limited',
    limitedReason: 'parse_error',
    hasHtml: false,
    authentication: null,
    links: [],
    attachments: [],
    attachmentsIgnored: 0,
    findings: [],
    priority: 'low',
    rulesVersion: RULES_VERSION,
    decodedText: '',
  };
}
