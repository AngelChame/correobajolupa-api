import type { z } from 'zod';
import type { Candidate, MatchLocation } from '../contract/schemas/indicators.js';
import type { Db } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { IndicatorType } from '../generated/prisma/enums.js';
import { MESSAGE_SUMMARY_SELECT, toMessageSummaryDto } from '../lab/dto.js';
import { defangIndicator } from './normalize.js';

/**
 * Búsqueda retrospectiva (M5, RF-20, RF-21): mensajes del laboratorio que coinciden con un
 * indicador confirmado, cada uno con la razón de cada coincidencia y sin puntuación (D-019).
 * Compartir un dominio no confirma una campaña: son candidatos, decide una persona.
 *
 * Coincidencia exacta (decisión de la parada de M5), sin subdominios ni ventana de fecha, en
 * INBOX y Cuarentena:
 * - domain: host de un enlace (nunca su texto visible), dominio del remitente o de un Reply-To.
 * - url: URL normalizada del enlace (sin query ni fragmento).
 * - sha256: adjuntos.
 * - sender: dirección del remitente.
 * Remitente y Reply-To se comparan con lower() porque M4 los guarda como vienen; esas dos
 * búsquedas no tienen índice (limitación aceptada: el laboratorio tiene decenas de mensajes).
 * Enlaces y adjuntos usan los índices de domain, normalized_url y sha256. Nunca se leen cuerpos.
 */

type Location = z.infer<typeof MatchLocation>;
type CandidateDto = z.infer<typeof Candidate>;

/** Orden fijo de las razones dentro de un candidato. */
const LOCATION_ORDER: Location[] = ['link', 'from', 'reply_to', 'attachment'];

/** Dominio de una dirección (lo que va después de la última @), en minúsculas. */
const domainOf = (column: Prisma.Sql) => Prisma.sql`lower(substring(${column} from '@([^@]+)$'))`;

/** Filas (mensaje, ubicación) que coinciden; una por ubicación aunque haya varios enlaces iguales. */
function matchesSql(type: IndicatorType, value: string): Prisma.Sql {
  switch (type) {
    case 'domain':
      return Prisma.sql`
        SELECT DISTINCT l.message_id, 'link'::text AS location FROM indexed_message_links l WHERE l.domain = ${value}
        UNION
        SELECT m.id, 'from' FROM indexed_messages m WHERE ${domainOf(Prisma.sql`m.from_address`)} = ${value}
        UNION
        SELECT m.id, 'reply_to' FROM indexed_messages m
        WHERE EXISTS (SELECT 1 FROM unnest(m.reply_to) AS r(address) WHERE ${domainOf(Prisma.sql`r.address`)} = ${value})`;
    case 'url':
      return Prisma.sql`SELECT DISTINCT l.message_id, 'link'::text AS location FROM indexed_message_links l WHERE l.normalized_url = ${value}`;
    case 'sha256':
      return Prisma.sql`SELECT DISTINCT a.message_id, 'attachment'::text AS location FROM indexed_message_attachments a WHERE a.sha256 = ${value}`;
    case 'sender':
      return Prisma.sql`SELECT m.id AS message_id, 'from'::text AS location FROM indexed_messages m WHERE lower(m.from_address) = ${value}`;
  }
}

export type CandidatePage = { items: CandidateDto[]; total: number };

/**
 * Una página de candidatos de un indicador. Orden: número de razones (desc), fecha del mensaje
 * (desc, sin fecha al final) e id (desc) para desempatar.
 */
export async function findCandidates(
  db: Db,
  indicator: { id: string; type: IndicatorType; value: string },
  page: { page: number; pageSize: number },
): Promise<CandidatePage> {
  const matches = matchesSql(indicator.type, indicator.value);
  const [filas, [conteo]] = await Promise.all([
    db.$queryRaw<{ id: string; locations: Location[] }[]>`
      WITH matches AS (${matches}),
      grouped AS (SELECT message_id, array_agg(location) AS locations, count(*) AS n FROM matches GROUP BY message_id)
      SELECT m.id, g.locations
      FROM grouped g JOIN indexed_messages m ON m.id = g.message_id
      ORDER BY g.n DESC, m.date DESC NULLS LAST, m.id DESC
      LIMIT ${page.pageSize} OFFSET ${(page.page - 1) * page.pageSize}`,
    db.$queryRaw<{ total: bigint }[]>`
      WITH matches AS (${matches})
      SELECT count(DISTINCT message_id) AS total FROM matches`,
  ]);

  const resumenes = await db.indexedMessage.findMany({ where: { id: { in: filas.map((f) => f.id) } }, select: MESSAGE_SUMMARY_SELECT });
  const porId = new Map(resumenes.map((r) => [r.id, r]));
  // El valor que coincidió es el del indicador (coincidencia exacta): sale desactivado (D-017).
  const matchedValue = defangIndicator(indicator.type, indicator.value);
  const items = filas.flatMap((f) => {
    const resumen = porId.get(f.id);
    // Borrado entre las dos consultas (una sincronización): se omite.
    if (!resumen) return [];
    const reasons = [...f.locations]
      .sort((a, b) => LOCATION_ORDER.indexOf(a) - LOCATION_ORDER.indexOf(b))
      .map((location) => ({ indicatorId: indicator.id, kind: indicator.type, location, matchedValue }));
    return [{ message: toMessageSummaryDto(resumen), reasons }];
  });
  return { items, total: Number(conteo?.total ?? 0) };
}
