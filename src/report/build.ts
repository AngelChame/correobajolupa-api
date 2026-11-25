import { z } from 'zod';
import { defangHost } from '../analysis/links.js';
import type { ScanStatus } from '../contract/schemas/attachments.js';
import type { ReportDocument } from '../contract/schemas/report-document.js';
import { EvidenceItem, type LimitedReason, type Priority, type ReportStatus, type RuleId } from '../contract/schemas/reports.js';
import { defangAddress } from '../viewer/text.js';
import { GUIDE_VERSION, RULE_GUIDES, UNKNOWN_RULE_GUIDE, type GuideText } from './guide-texts.js';
import { buildNotes, buildSummary, type Authentication } from './summary.js';

/**
 * Armado del informe (M3, D-011, D-014). Función pura: no lee la base ni el reloj. La misma
 * entrada da el mismo JSON (salvo generatedAt, que es `ahora`). La ruta valida el resultado con
 * ReportDocument antes de responder.
 *
 * Nada del correo se copia (ni asunto, ni cuerpo, ni encabezados, ni texto visible de enlaces):
 * solo hallazgos con su evidencia ya desactivada, indicadores desactivados, nombres de adjunto
 * saneados y textos de plantilla.
 */

export type ReportDocumentDto = z.infer<typeof ReportDocument>;
type RuleIdValue = z.infer<typeof RuleId>;

export type ReportInput = {
  id: string;
  status: z.infer<typeof ReportStatus>;
  limitedReason: z.infer<typeof LimitedReason> | null;
  priority: z.infer<typeof Priority> | null;
  rulesVersion: string | null;
  /** Remitente tal como lo guardó el analizador (crudo); sale solo desactivado. */
  fromAddress: string | null;
  authentication: Authentication | null;
  feedUnavailable?: unknown;
  findings: readonly { id: string; ruleId: string; evidence: unknown; createdAt: Date }[];
  /** Dominio (o IP) crudo de cada enlace; sale solo desactivado. */
  links: readonly { position: number; domain: string | null }[];
  attachments: readonly { position: number; fileName: string | null; sha256: string; scanStatus: z.infer<typeof ScanStatus> }[];
};

export type BuildOptions = {
  /** Se llama con el ruleId de cada hallazgo sin guía (la ruta lo registra; nada más). */
  onUnknownRule?: (ruleId: string) => void;
};

/** Orden fijo de los hallazgos: lo más grave o accionable primero. Una regla sin guía va al final. */
export const FINDING_ORDER: readonly RuleIdValue[] = ['R8', 'R10', 'R6', 'R7', 'R9', 'R2', 'R3', 'R4', 'R5', 'R1'];
export const MAX_INDICATORS = 25;

const Evidence = z.array(EvidenceItem);

function rango(ruleId: string): number {
  const i = (FINDING_ORDER as readonly string[]).indexOf(ruleId);
  return i === -1 ? FINDING_ORDER.length : i;
}

/** Comparación de cadenas por código, igual en cualquier configuración regional. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function guiaDe(ruleId: string): GuideText | undefined {
  return Object.hasOwn(RULE_GUIDES, ruleId) ? RULE_GUIDES[ruleId as RuleIdValue] : undefined;
}

/** Remitente, dominios de los enlaces y SHA-256 de los adjuntos, desactivados, sin repetidos y con tope. */
function indicadores(entrada: ReportInput): ReportDocumentDto['indicators'] {
  const salida: ReportDocumentDto['indicators'] = [];
  const vistos = new Set<string>();
  const agregar = (type: ReportDocumentDto['indicators'][number]['type'], displayValue: string) => {
    const clave = `${type}\u0000${displayValue}`;
    if (vistos.has(clave) || salida.length >= MAX_INDICATORS) return;
    vistos.add(clave);
    salida.push({ type, displayValue });
  };

  if (entrada.fromAddress) agregar('sender', defangAddress(entrada.fromAddress.toLowerCase()));
  for (const l of [...entrada.links].sort((a, b) => a.position - b.position)) {
    if (l.domain) agregar('domain', defangHost(l.domain.toLowerCase()));
  }
  for (const a of [...entrada.attachments].sort((x, y) => x.position - y.position)) agregar('sha256', a.sha256.toLowerCase());
  return salida;
}

export function buildReportDocument(entrada: ReportInput, ahora: Date, opciones: BuildOptions = {}): ReportDocumentDto {
  // Un análisis que no terminó no tiene resultados (D-004): ni hallazgos, ni indicadores, ni adjuntos.
  const fallido = entrada.status === 'failed';

  const findings = fallido
    ? []
    : [...entrada.findings]
        .sort((a, b) => rango(a.ruleId) - rango(b.ruleId) || a.createdAt.getTime() - b.createdAt.getTime() || cmp(a.id, b.id))
        .map((f) => {
          let guia = guiaDe(f.ruleId);
          if (!guia) {
            opciones.onUnknownRule?.(f.ruleId);
            guia = UNKNOWN_RULE_GUIDE;
          }
          return {
            ruleId: f.ruleId as RuleIdValue,
            title: guia.title,
            whatItMeans: guia.whatItMeans,
            whyRisky: guia.whyRisky,
            whatToDo: [...guia.whatToDo],
            forAnalyst: [...guia.forAnalyst],
            // Ya desactivada al guardarla (M1); se valida con el esquema del contrato.
            evidence: Evidence.parse(f.evidence),
          };
        });

  const attachments = fallido
    ? []
    : [...entrada.attachments]
        .sort((a, b) => a.position - b.position)
        // fileName es texto hostil ya saneado: sale tal cual y el front lo escapa.
        .map((a) => ({ fileName: a.fileName, sha256: a.sha256, scanStatus: a.scanStatus }));

  return {
    reportId: entrada.id,
    generatedAt: ahora.toISOString(),
    rulesVersion: entrada.rulesVersion,
    guideVersion: GUIDE_VERSION,
    status: entrada.status,
    limitedReason: entrada.limitedReason,
    priority: entrada.priority,
    summary: buildSummary({
      status: entrada.status,
      findingsCount: findings.length,
      priority: entrada.priority,
      scanStatuses: attachments.map((a) => a.scanStatus),
    }),
    findings,
    indicators: fallido ? [] : indicadores(entrada),
    attachments,
    notes: buildNotes({
      status: entrada.status,
      limitedReason: entrada.limitedReason,
      findingsCount: findings.length,
      authentication: entrada.authentication,
      feedUnavailable: Array.isArray(entrada.feedUnavailable)
        ? entrada.feedUnavailable.filter((s) => s === 'OpenPhish' || s === 'URLhaus')
        : [],
    }),
  };
}
