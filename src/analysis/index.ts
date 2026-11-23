// Analizador de correos (M1): puro, sin base de datos ni disco.
export { analyze } from './analyze.js';
export { defangEmail, defangHost, defangUrlValue } from './links.js';
export { RULES_VERSION } from './rules.js';
export type { AnalysisResult, AnalyzedAttachment, AnalyzedLink, Authentication, EvidenceKind, RawEvidence, RawFinding } from './types.js';
