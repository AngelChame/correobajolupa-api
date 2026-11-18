import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from 'express';
import type { Db } from '../db/client.js';
import type { Role } from '../generated/prisma/enums.js';
import { sendError } from '../http/errors.js';
import { randomToken, sha256Hex } from './crypto.js';

/** Nombre de la cookie de sesión (contrato v0, D-044). */
export const SESSION_COOKIE = 'cbl_session';

/** Vencimiento absoluto: una jornada. Pasado este tiempo hay que volver a entrar. */
export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
/** Vencimiento por inactividad (OWASP sugiere 15 a 30 min para aplicaciones de valor alto). */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** lastActivityAt se actualiza como mucho una vez por minuto para no escribir en cada petición. */
const TOUCH_INTERVAL_MS = 60 * 1000;

/**
 * SameSite=Lax y no Strict: con Strict, la primera navegación que llega desde un enlace externo
 * (por ejemplo un correo o un chat) no lleva la cookie, y si el front de Next.js lee la sesión en
 * el servidor (SSR) la persona aparecería sin sesión. Lax sigue sin enviar la cookie en POST
 * entre sitios, y además toda petición que modifica datos exige el token CSRF.
 */
export const SESSION_SAME_SITE = 'lax' as const;

/** El token es de 32 bytes en base64url; cualquier otra cosa se descarta sin ir a la base. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: Date;
};

export type AuthContext = { sessionId: string; csrfToken: string; user: SessionUser };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Sesión válida de la petición; la deja loadSession. */
      auth?: AuthContext;
    }
  }
}

export function cookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: SESSION_SAME_SITE, path: '/' };
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(secure), maxAge: SESSION_ABSOLUTE_TTL_MS });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(secure));
}

/** Lee el token de la cabecera Cookie sin decodificarlo ni aceptar formatos raros. */
export function readSessionToken(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const parte of header.split(';')) {
    const igual = parte.indexOf('=');
    if (igual === -1) continue;
    if (parte.slice(0, igual).trim() !== SESSION_COOKIE) continue;
    const valor = parte.slice(igual + 1).trim();
    return TOKEN_FORMAT.test(valor) ? valor : undefined;
  }
  return undefined;
}

/** Crea una sesión nueva. Devuelve el token en claro solo para ponerlo en la cookie. */
export async function createSession(db: Db, userId: string, now = new Date()) {
  const token = randomToken();
  const csrfToken = randomToken();
  const session = await db.session.create({
    data: {
      tokenHash: sha256Hex(token),
      userId,
      csrfToken,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
    },
  });
  return { token, csrfToken, sessionId: session.id };
}

export async function deleteSessionByToken(db: Db, token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
}

/**
 * Busca la sesión del token. Si venció (absoluta o por inactividad) o la cuenta está
 * desactivada, la borra y devuelve null.
 */
export async function findValidSession(db: Db, token: string, now = new Date()): Promise<AuthContext | null> {
  const session = await db.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
  if (!session) return null;

  const vencida = now >= session.expiresAt;
  const inactiva = now.getTime() - session.lastActivityAt.getTime() >= SESSION_IDLE_TIMEOUT_MS;
  if (vencida || inactiva || !session.user.active) {
    await db.session.deleteMany({ where: { id: session.id } });
    return null;
  }

  if (now.getTime() - session.lastActivityAt.getTime() >= TOUCH_INTERVAL_MS) {
    await db.session.updateMany({ where: { id: session.id }, data: { lastActivityAt: now } });
  }

  const { id, email, displayName, role, active, createdAt } = session.user;
  return { sessionId: session.id, csrfToken: session.csrfToken, user: { id, email, displayName, role, active, createdAt } };
}

/** Middleware global: si la cookie trae una sesión válida, la deja en req.auth. */
export function loadSession(db: Db, cookieSecure: boolean): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readSessionToken(req);
    if (token) {
      const auth = await findValidSession(db, token);
      if (auth) req.auth = auth;
      else clearSessionCookie(res, cookieSecure);
    }
    next();
  };
}

/** Exige una sesión válida; si no hay, 401 unauthenticated. */
export const requireSession: RequestHandler = (req, res, next) => {
  if (!req.auth) {
    sendError(req, res, 401, 'unauthenticated', 'Inicia sesión para continuar.');
    return;
  }
  next();
};
