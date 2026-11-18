import type { RequestHandler } from 'express';
import helmet from 'helmet';
import type { Config } from '../config.js';

/** HSTS de unos 6 meses (en segundos). */
const HSTS_MAX_AGE = 180 * 24 * 60 * 60;

/**
 * Cabeceras de seguridad para toda la API (helmet 8, configurado de forma explícita).
 * La API solo devuelve JSON, así que la CSP no permite cargar nada ni ser incrustada.
 *
 * Va al principio de la cadena, antes de las rutas. Una ruta que necesite otra política la fija
 * después con res.setHeader y la REEMPLAZA (la última escritura gana). Así lo hará el visor del
 * HTML del correo en M1 (D-035) con su `Content-Security-Policy: sandbox …`: no hay que tocar
 * este middleware ni excluir rutas. test/security-headers.test.ts lo comprueba.
 */
export function securityHeaders(config: Config): RequestHandler {
  // HSTS solo en producción y con cookies Secure, es decir, cuando la API se sirve por HTTPS.
  // En local por HTTP no sirve, y si alguna vez llegara por HTTPS a localhost el navegador
  // quedaría obligado a usar HTTPS en ese nombre durante meses. Sin includeSubDomains ni preload:
  // el dominio todavía no se decide (nº 28) y preload es muy difícil de deshacer.
  const hsts = config.NODE_ENV === 'production' && config.COOKIE_SECURE;

  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: hsts ? { maxAge: HSTS_MAX_AGE, includeSubDomains: false, preload: false } : false,
    xContentTypeOptions: true,
    xFrameOptions: { action: 'deny' },
    // Resto de helmet con sus valores por defecto (inofensivos en una API JSON):
    // Origin-Agent-Cluster, X-DNS-Prefetch-Control, X-Download-Options,
    // X-Permitted-Cross-Domain-Policies y X-XSS-Protection: 0.
  });
}

/**
 * Cache-Control: no-store por defecto en toda la API: las respuestas llevan datos de cuentas y
 * de correos que no deben quedar en cachés del navegador ni intermedias. Una ruta que necesite
 * otro valor lo sobrescribe a propósito (la última escritura gana).
 */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
