import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const URL_VALIDA = 'postgresql://usuario:MARCADOR_SECRETO@db:5432/correobajolupa';

describe('loadConfig', () => {
  it('acepta una DATABASE_URL de PostgreSQL y aplica los valores por defecto', () => {
    const config = loadConfig({ DATABASE_URL: URL_VALIDA });
    expect(config.DATABASE_URL).toBe(URL_VALIDA);
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('falla si falta DATABASE_URL y nombra la variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rechaza una URL que no es de PostgreSQL sin imprimir su valor', () => {
    const mala = 'mysql://usuario:MARCADOR_SECRETO@db:3306/x';
    let mensaje = '';
    try {
      loadConfig({ DATABASE_URL: mala });
    } catch (error) {
      mensaje = (error as Error).message;
    }
    expect(mensaje).toContain('DATABASE_URL');
    expect(mensaje).not.toContain('MARCADOR_SECRETO');
  });
});
