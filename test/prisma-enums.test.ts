import { describe, expect, it } from 'vitest';
import * as contrato from '../src/contract/schemas/reports.js';
import * as prisma from '../src/generated/prisma/enums.js';

// Los enums de la base (prisma/schema.prisma) y los del contrato deben tener exactamente
// los mismos valores, en el mismo orden: así lo que se guarda es lo que la API promete devolver.
const pares = [
  ['ReportStatus', prisma.ReportStatus, contrato.ReportStatus.options],
  ['ReportSource', prisma.ReportSource, contrato.ReportSource.options],
  ['Priority', prisma.Priority, contrato.Priority.options],
  ['LimitedReason', prisma.LimitedReason, contrato.LimitedReason.options],
  ['RuleId', prisma.RuleId, contrato.RuleId.options],
] as const;

describe('enums de Prisma = enums del contrato', () => {
  it.each(pares)('%s', (_nombre, deLaBase, delContrato) => {
    expect(Object.values(deLaBase)).toEqual([...delContrato]);
  });
});
