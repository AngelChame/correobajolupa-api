import type { z } from 'zod';
import type { AuthResult } from '../contract/schemas/reports.js';
import type { LimitedReason, Priority, ReportSource, RuleId } from '../generated/prisma/enums.js';

/**
 * Tipo de valor de una evidencia. El analizador la devuelve cruda; al guardarla en la base, las
 * de tipo url, domain y email se desactivan (D-017) según este tipo.
 */
export type EvidenceKind = 'url' | 'domain' | 'email' | 'text';

export type RawEvidence = { label: string; value: string; kind: EvidenceKind };

export type RawFinding = {
  ruleId: Exclude<RuleId, 'R7' | 'R8'>;
  ruleName: string;
  summary: string;
  evidence: RawEvidence[];
};

/** Enlace extraído del correo. Nunca se visita (D-017). */
export type AnalyzedLink = {
  /** Orden de aparición, desde 0. */
  position: number;
  /** Texto visible (solo enlaces del HTML); null para URL del texto plano. */
  displayText: string | null;
  /** href tal como venía (con entidades HTML ya decodificadas), recortado. Solo para evidencia. */
  raw: string;
  /** Esquema en minúsculas sin ":" (http, https, mailto, javascript...). */
  scheme: string;
  /** URL normalizada: esquema y host en minúsculas, host en punycode, sin credenciales, query ni fragmento. */
  normalizedUrl: string;
  /** Forma desactivada para mostrar; nunca clicable. */
  defangedUrl: string;
  /** Host (http/https) o dominio del destinatario (mailto); null en los demás. */
  domain: string | null;
};

export type Authentication = { [K in 'spf' | 'dkim' | 'dmarc']: z.infer<typeof AuthResult> };

export type AnalysisOptions = { institutionalDomains: readonly string[] };

export type AnalysisResult = {
  subject: string | null;
  fromAddress: string | null;
  status: 'completed' | 'limited';
  limitedReason: LimitedReason | null;
  hasHtml: boolean;
  authentication: Authentication | null;
  links: AnalyzedLink[];
  findings: RawFinding[];
  priority: Priority;
  rulesVersion: string;
  /**
   * Asunto, texto y HTML ya decodificados, unidos. SOLO para pruebas (decodedText de los fixtures):
   * el worker no lo guarda ni lo registra.
   */
  decodedText: string;
};

export type { ReportSource };
