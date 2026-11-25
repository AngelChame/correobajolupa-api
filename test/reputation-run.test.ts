import { describe, expect, it } from 'vitest';
import { normalizeLink } from '../src/analysis/links.js';
import { reputationFinding, type ReputationReview } from '../src/reputation/run.js';

const item = (state: 'reported' | 'suspicious', malicious: number): ReputationReview => ({
  status: 'checked',
  items: [{
    displayUrl: 'hxxps://sitio[.]example/ruta',
    state, malicious, total: 12, analyzedAt: '2026-11-24T10:00:00.000Z',
  }],
});

describe('evidencia del informe externo', () => {
  it('tres motores y URL sin parámetros permiten prioridad alta con fuente y fecha', () => {
    const link = normalizeLink({ raw: 'https://sitio.example/ruta', displayText: null }, 0)!;
    const result = reputationFinding(item('reported', 3), [link]);
    expect(result.exactReported).toBe(true);
    expect(result.finding?.ruleId).toBe('R10');
    expect(result.finding?.evidence).toContainEqual({ label: 'Fuente', value: 'VirusTotal (informe existente)', kind: 'text' });
    expect(result.finding?.evidence).toContainEqual({ label: 'Fecha del informe', value: '2026-11-24T10:00:00.000Z', kind: 'text' });
  });

  it('la coincidencia sin query y una o dos marcas no se presentan como exactas', () => {
    const link = normalizeLink({ raw: 'https://sitio.example/ruta?token=MARCADOR_PRIVADO', displayText: null }, 0)!;
    const result = reputationFinding(item('reported', 3), [link]);
    expect(result.exactReported).toBe(false);
    expect(JSON.stringify(result.finding)).not.toContain('MARCADOR_PRIVADO');
    expect(result.finding?.evidence).toContainEqual({
      label: 'Coincidencia', value: 'Solo URL normalizada (parámetros omitidos)', kind: 'text',
    });
    expect(reputationFinding(item('suspicious', 1), [normalizeLink({ raw: 'https://sitio.example/ruta', displayText: null }, 0)!]).exactReported).toBe(false);
  });
});
