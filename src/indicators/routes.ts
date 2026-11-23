import express from 'express';
import type { z } from 'zod';
import { AuditAction, recordAudit } from '../audit.js';
import { requireRole } from '../auth/roles.js';
import type { Config } from '../config.js';
import { CreateExclusionBody, Exclusion } from '../contract/schemas/indicators.js';
import type { Db } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { sendError } from '../http/errors.js';
import { parseBody } from '../http/validate.js';
import { uuidParam } from '../lab/routes.js';
import { configExclusions, isExcluded } from './exclusions.js';
import { defangIndicator, INVALID_VALUE, normalizeHost } from './normalize.js';

export type IndicatorsDeps = { db: Db; config: Config };

const EXCLUSION_TAKEN = 'Ese dominio ya está excluido.';

function toExclusionDto(row: { id: string | null; domain: string; reason: string | null; createdAt: Date | null }, source: 'config' | 'manual'): z.infer<typeof Exclusion> {
  return Exclusion.parse({
    id: row.id,
    // Desactivado (D-017): el dominio nunca sale clicable.
    domain: defangIndicator('domain', row.domain),
    source,
    reason: row.reason,
    createdAt: row.createdAt?.toISOString() ?? null,
  });
}

/**
 * Rutas de M5: lista de exclusión (y, en el siguiente paso, indicadores). En los registros y la
 * auditoría solo van IDs: nunca el dominio ni el valor de un indicador (P-18).
 */
export function createIndicatorsRouter({ db, config }: IndicatorsDeps) {
  const router = express.Router();
  const analista = requireRole(db, 'analyst', 'admin');

  // Los institucionales de la configuración van primero, como solo lectura (id null).
  router.get('/exclusions', analista, async (_req, res) => {
    const filas = await db.exclusion.findMany({ orderBy: [{ domain: 'asc' }] });
    res.json({
      items: [
        ...configExclusions(config.INSTITUTIONAL_DOMAINS).map((domain) => toExclusionDto({ id: null, domain, reason: null, createdAt: null }, 'config')),
        ...filas.map((f) => toExclusionDto(f, 'manual')),
      ],
    });
  });

  router.post('/exclusions', analista, async (req, res) => {
    const body = parseBody(CreateExclusionBody, req, res);
    if (!body) return;
    const domain = normalizeHost(body.domain);
    if (!domain) {
      sendError(req, res, 400, 'validation_error', 'Revisa los datos enviados.', [{ field: 'domain', message: INVALID_VALUE.domain }]);
      return;
    }
    // Ya cubierto (el mismo dominio o uno padre, en la tabla o en la configuración): 409.
    if (await isExcluded(db, config.INSTITUTIONAL_DOMAINS, domain)) {
      sendError(req, res, 409, 'conflict', EXCLUSION_TAKEN);
      return;
    }
    const actor = req.auth!.user;
    let fila;
    try {
      fila = await db.$transaction(async (tx) => {
        const creada = await tx.exclusion.create({ data: { domain, reason: body.reason ?? null, createdById: actor.id } });
        await recordAudit(tx, {
          action: AuditAction.exclusionCreate,
          result: 'success',
          requestId: String(req.id),
          actorId: actor.id,
          targetType: 'exclusion',
          targetId: creada.id,
        });
        return creada;
      });
    } catch (error) {
      // Otra petición lo excluyó al mismo tiempo.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        sendError(req, res, 409, 'conflict', EXCLUSION_TAKEN);
        return;
      }
      throw error;
    }
    res.status(201).json(toExclusionDto(fila, 'manual'));
  });

  router.delete('/exclusions/:exclusionId', analista, async (req, res) => {
    const id = uuidParam(req, res, 'exclusionId', 'La exclusión no existe.');
    if (!id) return;
    const actor = req.auth!.user;
    const borrada = await db.$transaction(async (tx) => {
      const { count } = await tx.exclusion.deleteMany({ where: { id } });
      if (count === 0) return false;
      await recordAudit(tx, {
        action: AuditAction.exclusionDelete,
        result: 'success',
        requestId: String(req.id),
        actorId: actor.id,
        targetType: 'exclusion',
        targetId: id,
      });
      return true;
    });
    if (!borrada) {
      sendError(req, res, 404, 'not_found', 'La exclusión no existe.');
      return;
    }
    res.status(204).end();
  });

  return router;
}
