import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const URL_VALIDA = 'postgresql://usuario:MARCADOR_SECRETO@db:5432/correobajolupa';

function mensajeDeError(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('loadConfig', () => {
  it('acepta una DATABASE_URL de PostgreSQL y aplica los valores por defecto', () => {
    const config = loadConfig({ DATABASE_URL: URL_VALIDA });
    expect(config.DATABASE_URL).toBe(URL_VALIDA);
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.COOKIE_SECURE).toBe(true);
    expect(config.INVITE_CODE).toBeUndefined();
    expect(config).toMatchObject({
      RATE_LIMIT_REGISTER_PER_IP: 10,
      RATE_LIMIT_REGISTER_WINDOW_MIN: 60,
      RATE_LIMIT_LOGIN_PER_IP: 30,
      RATE_LIMIT_LOGIN_FAILS_PER_EMAIL: 5,
      RATE_LIMIT_LOGIN_WINDOW_MIN: 15,
      RATE_LIMIT_GLOBAL_PER_MINUTE: 300,
    });
  });

  it('falla si falta DATABASE_URL y nombra la variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rechaza una URL que no es de PostgreSQL sin imprimir su valor', () => {
    const mensaje = mensajeDeError({ DATABASE_URL: 'mysql://usuario:MARCADOR_SECRETO@db:3306/x' });
    expect(mensaje).toContain('DATABASE_URL');
    expect(mensaje).not.toContain('MARCADOR_SECRETO');
  });

  it('no arranca en producción con COOKIE_SECURE=false', () => {
    const mensaje = mensajeDeError({ DATABASE_URL: URL_VALIDA, NODE_ENV: 'production', COOKIE_SECURE: 'false' });
    expect(mensaje).toContain('COOKIE_SECURE');
  });

  it('permite COOKIE_SECURE=false solo fuera de producción', () => {
    expect(loadConfig({ DATABASE_URL: URL_VALIDA, NODE_ENV: 'development', COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });

  it('exige FIRST_ADMIN_EMAIL y FIRST_ADMIN_PASSWORD juntas, sin imprimir la contraseña', () => {
    const solo = mensajeDeError({ DATABASE_URL: URL_VALIDA, FIRST_ADMIN_PASSWORD: 'MARCADOR_CLAVE_ADMIN' });
    expect(solo).toContain('FIRST_ADMIN_EMAIL');
    expect(solo).not.toContain('MARCADOR_CLAVE_ADMIN');

    const corta = mensajeDeError({ DATABASE_URL: URL_VALIDA, FIRST_ADMIN_EMAIL: 'admin@ejemplo.invalid', FIRST_ADMIN_PASSWORD: 'corta' });
    expect(corta).toContain('FIRST_ADMIN_PASSWORD');
    expect(corta).not.toContain('corta,');
  });

  it('trata las variables vacías como no definidas', () => {
    const config = loadConfig({ DATABASE_URL: URL_VALIDA, FIRST_ADMIN_EMAIL: '', FIRST_ADMIN_PASSWORD: '', INVITE_CODE: '' });
    expect(config.FIRST_ADMIN_EMAIL).toBeUndefined();
    expect(config.INVITE_CODE).toBeUndefined();
  });

  it('un límite vacío toma su valor por defecto y uno inválido falla', () => {
    expect(loadConfig({ DATABASE_URL: URL_VALIDA, RATE_LIMIT_LOGIN_PER_IP: '' }).RATE_LIMIT_LOGIN_PER_IP).toBe(30);
    expect(loadConfig({ DATABASE_URL: URL_VALIDA, RATE_LIMIT_LOGIN_PER_IP: '7' }).RATE_LIMIT_LOGIN_PER_IP).toBe(7);
    expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, RATE_LIMIT_LOGIN_PER_IP: '0' })).toContain('RATE_LIMIT_LOGIN_PER_IP');
  });
});
