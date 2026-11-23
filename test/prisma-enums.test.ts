import { describe, expect, it } from 'vitest';
import { ScanStatus } from '../src/contract/schemas/attachments.js';
import { AuditResult } from '../src/contract/schemas/audit.js';
import { IncidentStatus } from '../src/contract/schemas/incidents.js';
import { IndicatorStatus, IndicatorType } from '../src/contract/schemas/indicators.js';
import { MailboxLabel, MessageLocation, SyncStatus } from '../src/contract/schemas/lab.js';
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
  ['AuditResult', prisma.AuditResult, AuditResult.options],
  ['ScanStatus', prisma.ScanStatus, ScanStatus.options],
  ['MailboxLabel', prisma.MailboxLabel, MailboxLabel.options],
  ['SyncStatus', prisma.SyncStatus, SyncStatus.options],
  ['MessageLocation', prisma.MessageLocation, MessageLocation.options],
  ['IndicatorType', prisma.IndicatorType, IndicatorType.options],
  ['IndicatorStatus', prisma.IndicatorStatus, IndicatorStatus.options],
  ['IncidentStatus', prisma.IncidentStatus, IncidentStatus.options],
] as const;

describe('enums de Prisma = enums del contrato', () => {
  it.each(pares)('%s', (_nombre, deLaBase, delContrato) => {
    expect(Object.values(deLaBase)).toEqual([...delContrato]);
  });
});
