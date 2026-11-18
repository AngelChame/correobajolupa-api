import type { Db } from './db/client.js';
import type { Prisma } from './generated/prisma/client.js';
import type { AuditResult } from './generated/prisma/enums.js';

/**
 * Acciones de auditoría conocidas. Las que no vienen de una petición HTTP llevan el prefijo
 * "system." y no tienen requestId (D-047).
 */
export const AuditAction = {
  register: 'auth.register',
  login: 'auth.login',
  logout: 'auth.logout',
  authzDenied: 'authz.denied',
  roleChange: 'user.role_change',
  deactivate: 'user.deactivate',
  activate: 'user.activate',
  bootstrapAdmin: 'system.bootstrap_admin',
} as const;

export type AuditEntry = {
  action: (typeof AuditAction)[keyof typeof AuditAction];
  result: AuditResult;
  requestId?: string;
  actorId?: string | null;
  targetType?: string;
  targetId?: string;
  /** Solo datos no sensibles: IDs, motivos, roles. Nunca correos intentados, contraseñas ni tokens. */
  metadata?: Prisma.InputJsonObject;
};

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditEvent.create({
    data: {
      action: entry.action,
      result: entry.result,
      requestId: entry.requestId ?? null,
      actorId: entry.actorId ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    },
  });
}
