import type { Logger } from 'pino';
import { AuditAction, recordAudit } from '../audit.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { normalizeEmail } from '../db/email.js';
import { hashPassword } from './password.js';

export const FIRST_ADMIN_DISPLAY_NAME = 'Administrador';

export type BootstrapResult = 'skipped' | 'admin_exists' | 'email_in_use' | 'created';

/**
 * Primer administrador (D-010): al arrancar, si FIRST_ADMIN_EMAIL y FIRST_ADMIN_PASSWORD están
 * definidas y no hay ningún admin, se crea uno. Es idempotente: si ya hay un admin no hace nada.
 * Si el correo ya pertenece a otra cuenta no la toca (ni rol ni contraseña).
 * Nunca registra la contraseña ni el correo.
 */
export async function ensureFirstAdmin(db: Db, config: Config, logger: Logger): Promise<BootstrapResult> {
  const { FIRST_ADMIN_EMAIL, FIRST_ADMIN_PASSWORD } = config;
  if (!FIRST_ADMIN_EMAIL || !FIRST_ADMIN_PASSWORD) return 'skipped';

  if ((await db.user.count({ where: { role: 'admin' } })) > 0) return 'admin_exists';

  const email = normalizeEmail(FIRST_ADMIN_EMAIL);
  if (await db.user.findUnique({ where: { email }, select: { id: true } })) {
    logger.warn('FIRST_ADMIN_EMAIL ya pertenece a una cuenta que no es administradora; no se modifica');
    return 'email_in_use';
  }

  const passwordHash = await hashPassword(FIRST_ADMIN_PASSWORD);
  let id: string;
  try {
    ({ id } = await db.user.create({
      data: { email, displayName: FIRST_ADMIN_DISPLAY_NAME, passwordHash, role: 'admin' },
      select: { id: true },
    }));
  } catch (error) {
    // Otra instancia lo creó al mismo tiempo: el resultado es el mismo.
    if ((error as { code?: unknown }).code === 'P2002') return 'admin_exists';
    throw error;
  }

  // Evento del sistema (D-047): sin requestId ni actor; el objetivo es la cuenta creada.
  await recordAudit(db, { action: AuditAction.bootstrapAdmin, result: 'success', targetType: 'user', targetId: id });
  logger.info({ userId: id }, 'administrador inicial creado');
  return 'created';
}
