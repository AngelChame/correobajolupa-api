/**
 * Interpretación local de un conteo de motores ya obtenido. No conoce servicios externos,
 * credenciales ni URLs y no realiza consultas. Ningún resultado afirma que un enlace sea seguro.
 */
export type ReputationState = 'reported' | 'suspicious' | 'no_detections' | 'no_data' | 'error' | 'not_checked';

export type ReputationVerdict = {
  state: ReputationState;
  malicious: number | null;
  total: number | null;
  /** Texto fijo salvo los dos conteos enteros; no incluye contenido del correo. */
  explanation: string;
};

const unavailable = (state: 'error' | 'not_checked' | 'no_data', explanation: string): ReputationVerdict => ({
  state,
  malicious: null,
  total: null,
  explanation,
});

export function interpretReputation(
  input:
    | { status: 'result'; malicious: number; total: number }
    | { status: 'no_data' | 'error' | 'not_checked' },
): ReputationVerdict {
  if (input.status === 'error') return unavailable('error', 'No se pudo consultar la fuente de reputación; no significa que el enlace sea seguro.');
  if (input.status === 'not_checked') return unavailable('not_checked', 'Este enlace no se consultó; no significa que sea seguro.');
  if (input.status === 'no_data') return unavailable('no_data', 'La fuente no tiene datos sobre este enlace; no significa que sea seguro.');
  if (input.status !== 'result') return unavailable('error', 'Resultado no reconocido; no significa que el enlace sea seguro.');

  const { malicious, total } = input;
  if (!Number.isSafeInteger(malicious) || !Number.isSafeInteger(total) || malicious < 0 || total < 0 || malicious > total) {
    return unavailable('error', 'La fuente devolvió un resultado inválido; no significa que el enlace sea seguro.');
  }
  if (total === 0) return unavailable('no_data', 'La fuente no tiene análisis disponibles; no significa que el enlace sea seguro.');
  const count = `Marcada por ${malicious} de ${total} motores`;
  if (malicious >= 3) return { state: 'reported', malicious, total, explanation: `${count}; revisa la evidencia antes de decidir.` };
  if (malicious >= 1) return { state: 'suspicious', malicious, total, explanation: `${count}; conviene revisarla, no es una confirmación.` };
  return { state: 'no_detections', malicious, total, explanation: `${count} en este análisis; sin detecciones no significa segura.` };
}
