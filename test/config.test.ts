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

  it('aplica los valores por defecto de M1 (reportes, cola y proxy)', () => {
    expect(loadConfig({ DATABASE_URL: URL_VALIDA })).toMatchObject({
      TRUST_PROXY_HOPS: 0,
      STORAGE_DIR: '/data/reports',
      MAX_EML_BYTES: 10 * 1024 * 1024,
      MAX_PASTE_BYTES: 1024 * 1024,
      REPORTS_PER_USER_PER_HOUR: 30,
      INSTITUTIONAL_DOMAINS: [],
      WORKER_POLL_MS: 1000,
      JOB_LEASE_SECONDS: 120,
      JOB_MAX_ATTEMPTS: 3,
      CLEANUP_INTERVAL_MIN: 60,
    });
  });

  it('aplica los valores por defecto de M2 (ClamAV) y valida host y presupuesto', () => {
    expect(loadConfig({ DATABASE_URL: URL_VALIDA })).toMatchObject({
      CLAMAV_HOST: 'clamav',
      CLAMAV_PORT: 3310,
      CLAMAV_TIMEOUT_MS: 10_000,
      CLAMAV_TOTAL_BUDGET_MS: 20_000,
      CLAMAV_MAX_SCAN_BYTES: 10 * 1024 * 1024,
      MAX_ATTACHMENTS_SCANNED: 20,
    });
    for (const valor of ['http://clamav', 'clamav:3310', 'a b', '-clamav']) {
      expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, CLAMAV_HOST: valor }), valor).toContain('CLAMAV_HOST');
    }
    expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, MAX_ATTACHMENTS_SCANNED: '51' })).toContain('MAX_ATTACHMENTS_SCANNED');
    // Arriendo de 30 s: el escaneo puede usar como mucho 15 s.
    expect(loadConfig({ DATABASE_URL: URL_VALIDA, JOB_LEASE_SECONDS: '30', CLAMAV_TOTAL_BUDGET_MS: '15000' }).CLAMAV_TOTAL_BUDGET_MS).toBe(15_000);
    expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, JOB_LEASE_SECONDS: '30' })).toContain('CLAMAV_TOTAL_BUDGET_MS');
  });

  it('TRUST_PROXY_HOPS acepta solo un número de saltos, nunca true', () => {
    expect(loadConfig({ DATABASE_URL: URL_VALIDA, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
    expect(loadConfig({ DATABASE_URL: URL_VALIDA, TRUST_PROXY_HOPS: '' }).TRUST_PROXY_HOPS).toBe(0);
    for (const valor of ['true', 'false', '-1', '1.5', 'loopback', '99']) {
      expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, TRUST_PROXY_HOPS: valor }), valor).toContain('TRUST_PROXY_HOPS');
    }
  });

  it('INSTITUTIONAL_DOMAINS se lee como lista en minúsculas y rechaza lo que no es dominio', () => {
    const config = loadConfig({ DATABASE_URL: URL_VALIDA, INSTITUTIONAL_DOMAINS: ' Universidad-Ejemplo.example , ,otra.example ' });
    expect(config.INSTITUTIONAL_DOMAINS).toEqual(['universidad-ejemplo.example', 'otra.example']);
    for (const valor of ['203.0.113.4', 'https://sitio.example', 'sin-punto', 'a b.example', '-mal.example']) {
      expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, INSTITUTIONAL_DOMAINS: valor }), valor).toContain('INSTITUTIONAL_DOMAINS');
    }
  });

  it('STORAGE_DIR debe ser una ruta absoluta', () => {
    expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, STORAGE_DIR: 'datos/reportes' })).toContain('STORAGE_DIR');
  });

  it('los tamaños y la cola rechazan ceros y valores fuera de rango', () => {
    expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, MAX_EML_BYTES: '0' })).toContain('MAX_EML_BYTES');
    expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, JOB_MAX_ATTEMPTS: '0' })).toContain('JOB_MAX_ATTEMPTS');
    expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, WORKER_POLL_MS: '10' })).toContain('WORKER_POLL_MS');
    expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, CLEANUP_INTERVAL_MIN: '0' })).toContain('CLEANUP_INTERVAL_MIN');
    expect(mensajeDeError({ DATABASE_URL: URL_VALIDA, CLEANUP_INTERVAL_MIN: '2000' })).toContain('CLEANUP_INTERVAL_MIN');
  });
});
