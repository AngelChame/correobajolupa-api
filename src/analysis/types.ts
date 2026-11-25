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
  /** R8 es de indicadores; R9 y R10 se activarán en las fases siguientes. */
  ruleId: Exclude<RuleId, 'R8' | 'R9' | 'R10'>;
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

/** Familia de archivo según sus primeros bytes, su extensión o su tipo declarado (R7). */
export type FileFamily = 'executable' | 'pdf' | 'zip' | 'ole2' | 'rar' | '7z' | 'gzip' | 'image' | 'rtf' | 'text';

/** Adjunto extraído del correo (M2). Nunca se ejecuta ni se descomprime (D-018). */
export type AnalyzedAttachment = {
  /** Orden en el correo, desde 0. */
  position: number;
  /** Nombre saneado para guardar y mostrar (texto hostil); null si no traía. */
  fileName: string | null;
  /** Content-Type declarado, en minúsculas. */
  declaredType: string | null;
  /** Tipo por los primeros bytes; null si no se reconoce. */
  detectedType: string | null;
  sizeBytes: number;
  sha256: string;
  /** Última y penúltima extensión del nombre original (para R7; no se guardan). */
  extension: string | null;
  previousExtension: string | null;
  /** El nombre original traía caracteres de dirección de texto (U+202E...). */
  hasBidiControls: boolean;
  /**
   * Bytes decodificados, SOLO en memoria para el SHA-256 ya calculado y para ClamAV. Nunca se
   * guardan, nunca se registran y nunca se devuelven por la API.
   */
  content: Buffer;
};

export type Authentication = { [K in 'spf' | 'dkim' | 'dmarc']: z.infer<typeof AuthResult> };

export type AnalysisOptions = { institutionalDomains: readonly string[] };

export type AnalysisResult = {
  subject: string | null;
  fromAddress: string | null;
  /** Direcciones de Reply-To (hasta 10), las mismas que usan R1 y R3. Texto del correo. */
  replyTo: string[];
  status: 'completed' | 'limited';
  limitedReason: LimitedReason | null;
  hasHtml: boolean;
  authentication: Authentication | null;
  links: AnalyzedLink[];
  attachments: AnalyzedAttachment[];
  /** Adjuntos que pasaron del tope y no se registraron (solo el conteo va a los registros). */
  attachmentsIgnored: number;
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
