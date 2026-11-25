import { describe, expect, it } from 'vitest';
import { normalizeLink } from '../src/analysis/links.js';
import { MAX_REPUTATION_URLS, selectForReputation } from '../src/reputation/select.js';

const link = (raw: string, position: number, displayText: string | null = null) => normalizeLink({ raw, displayText }, position)!;

describe('selección local de URLs para reputación', () => {
  it('pone primero el destino distinto al texto visible y limita a cinco URLs', () => {
    const links = Array.from({ length: 8 }, (_, i) => link(`https://sitio${i}.example/ruta`, i));
    links.push(link('https://destino.example/ir?token=MARCADOR_DEMO', 8, 'https://institucion.example/portal'));
    const selected = selectForReputation(links);
    expect(selected).toHaveLength(MAX_REPUTATION_URLS);
    expect(selected[0]).toBe('https://destino.example/ir');
    expect(selected.join(' ')).not.toContain('MARCADOR_DEMO');
  });

  it('deduplica, no incluye esquemas ajenos a web y mantiene el orden original en empates', () => {
    const selected = selectForReputation([
      link('https://primero.example/a?x=1', 0),
      link('https://primero.example/a?x=2', 1),
      link('mailto:persona@ejemplo.example', 2),
      link('https://segundo.example/b', 3),
    ]);
    expect(selected).toEqual(['https://primero.example/a', 'https://segundo.example/b']);
  });
});
