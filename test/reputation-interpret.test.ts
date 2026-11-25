import { describe, expect, it } from 'vitest';
import { interpretReputation } from '../src/reputation/interpret.js';

describe('interpretación local de reputación, sin servicios externos', () => {
  it.each([
    [0, 90, 'no_detections'],
    [1, 90, 'suspicious'],
    [2, 90, 'suspicious'],
    [3, 90, 'reported'],
    [12, 90, 'reported'],
  ] as const)('%i de %i motores → %s', (malicious, total, state) => {
    const verdict = interpretReputation({ status: 'result', malicious, total });
    expect(verdict).toMatchObject({ state, malicious, total });
    expect(verdict.explanation).toContain(`${malicious} de ${total} motores`);
    expect(verdict.explanation.toLowerCase()).not.toMatch(/\bes maliciosa\b|\bes segura\b|\blimpia\b/);
  });

  it('distingue sin datos, error y no consultada de cero detecciones', () => {
    for (const state of ['no_data', 'error', 'not_checked'] as const) {
      const result = interpretReputation({ status: state });
      expect(result.state).toBe(state);
      expect(result.malicious).toBeNull();
      expect(result.explanation).toContain('no significa');
    }
    expect(interpretReputation({ status: 'result', malicious: 0, total: 0 }).state).toBe('no_data');
  });

  it('rechaza conteos inválidos sin tratar el error como limpio', () => {
    for (const [malicious, total] of [[-1, 90], [91, 90], [1.5, 90], [1, Number.NaN]] as const) {
      expect(interpretReputation({ status: 'result', malicious, total }).state).toBe('error');
    }
  });
});
