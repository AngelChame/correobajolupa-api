import express, { type Request, type Response } from 'express';
import { AuditAction, recordAudit } from '../audit.js';
import type { Config } from '../config.js';
import { LoginBody, RegisterBody } from '../contract/schemas/auth.js';
import type { Db } from '../db/client.js';
import { normalizeEmail } from '../db/email.js';
import { sendError } from '../http/errors.js';
import { parseBody } from '../http/validate.js';
import { safeEqual } from './crypto.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  clearSessionCookie,
  createSession,
  deleteSessionByToken,
  readSessionToken,
  requireSession,
  setSessionCookie,
  type SessionUser,
} from './session.js';

export type AuthDeps = {
  db: Db;
  config: Config;
  /** Hash señuelo calculado al arrancar (ver createDecoyHash). */
  decoyHash: string;
};

/** Forma `User` del contrato. Nunca incluye el hash de la contraseña. */
export function toUserDto(user: SessionUser) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt.toISOString(),
  };
}

const requestId = (req: Request) => String(req.id);

/** Mismo mensaje exista o no la cuenta, esté o no desactivada: no revela qué correos existen. */
const CREDENCIALES_INVALIDAS = 'Correo o contraseña incorrectos.';

export function createAuthRouter({ db, config, decoyHash }: AuthDeps) {
  const router = express.Router();
  const secure = config.COOKIE_SECURE;

  async function iniciarSesion(res: Response, user: SessionUser, status: number) {
    const { token, csrfToken } = await createSession(db, user.id);
    setSessionCookie(res, token, secure);
    res.status(status).json({ user: toUserDto(user), csrfToken });
  }

  router.post('/register', async (req, res) => {
    const body = parseBody(RegisterBody, req, res);
    if (!body) return;

    if (config.INVITE_CODE && !(body.inviteCode && safeEqual(body.inviteCode, config.INVITE_CODE))) {
      sendError(req, res, 400, 'validation_error', 'Revisa los datos enviados.', [
        { field: 'inviteCode', message: 'El código de invitación no es válido.' },
      ]);
      return;
    }

    const displayName = body.displayName.trim();
    if (!displayName) {
      sendError(req, res, 400, 'validation_error', 'Revisa los datos enviados.', [
        { field: 'displayName', message: 'El nombre no puede estar vacío.' },
      ]);
      return;
    }

    // Compromiso aceptado: el 409 revela que el correo ya tiene cuenta (lo pide el contrato).
    // Lo mitigan el límite de peticiones por IP y que el login no lo revela.
    const email = normalizeEmail(body.email);
    if (await db.user.findUnique({ where: { email }, select: { id: true } })) {
      sendError(req, res, 409, 'email_taken', 'Ya existe una cuenta con ese correo.');
      return;
    }

    const passwordHash = await hashPassword(body.password);
    let user: SessionUser;
    try {
      user = await db.user.create({ data: { email, displayName, passwordHash } });
    } catch (error) {
      // Dos registros simultáneos con el mismo correo: gana uno, el otro recibe 409.
      if ((error as { code?: unknown }).code === 'P2002') {
        sendError(req, res, 409, 'email_taken', 'Ya existe una cuenta con ese correo.');
        return;
      }
      throw error;
    }

    await recordAudit(db, { action: AuditAction.register, result: 'success', requestId: requestId(req), actorId: user.id });
    await iniciarSesion(res, user, 201);
  });

  router.post('/login', async (req, res) => {
    const body = parseBody(LoginBody, req, res);
    if (!body) return;

    // Si ya traía una sesión, se borra: cada login empieza con una sesión nueva.
    const previo = readSessionToken(req);
    if (previo) await deleteSessionByToken(db, previo);

    const user = await db.user.findUnique({ where: { email: normalizeEmail(body.email) } });
    // Siempre se calcula un Argon2id: con la cuenta real o con el señuelo si no existe,
    // para que el tiempo de respuesta no revele qué correos están registrados.
    const coincide = await verifyPassword(body.password, user?.passwordHash ?? decoyHash);

    if (!user || !coincide || !user.active) {
      const reason = !user ? 'unknown_account' : !coincide ? 'bad_password' : 'inactive';
      // Nunca se guarda el correo intentado ni la contraseña: solo el motivo y, si existe, la cuenta.
      await recordAudit(db, {
        action: AuditAction.login,
        result: 'failure',
        requestId: requestId(req),
        actorId: user?.id ?? null,
        metadata: { reason },
      });
      clearSessionCookie(res, secure);
      sendError(req, res, 401, 'invalid_credentials', CREDENCIALES_INVALIDAS);
      return;
    }

    await recordAudit(db, { action: AuditAction.login, result: 'success', requestId: requestId(req), actorId: user.id });
    await iniciarSesion(res, user, 200);
  });

  // csrfGuard (global) ya exigió sesión y X-CSRF-Token antes de llegar aquí.
  router.post('/logout', requireSession, async (req, res) => {
    const auth = req.auth!;
    await db.session.deleteMany({ where: { id: auth.sessionId } });
    await recordAudit(db, { action: AuditAction.logout, result: 'success', requestId: requestId(req), actorId: auth.user.id });
    clearSessionCookie(res, secure);
    res.status(204).end();
  });

  router.get('/me', requireSession, (req, res) => {
    const auth = req.auth!;
    res.json({ user: toUserDto(auth.user), csrfToken: auth.csrfToken });
  });

  return router;
}
