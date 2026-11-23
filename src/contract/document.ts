import { z } from 'zod';
import { createDocument } from 'zod-openapi';
import { LoginBody, RegisterBody, Session, UpdateUserBody, User, UserList } from './schemas/auth.js';
import { ErrorResponse, PageQuery, Role, csrfHeader } from './schemas/common.js';
import {
  FindingList,
  PasteBody,
  ReportDetail,
  ReportList,
  ReportStatus,
  ReportSummary,
  UploadBody,
} from './schemas/reports.js';
import { AttachmentList } from './schemas/attachments.js';
import { AuditList, AuditQuery } from './schemas/audit.js';
import {
  AddIncidentIndicatorBody,
  AddIncidentReportBody,
  Comment,
  CreateCommentBody,
  CreateIncidentBody,
  IncidentDetail,
  IncidentList,
  IncidentQuery,
  UpdateIncidentBody,
} from './schemas/incidents.js';
import {
  CandidateList,
  CreateExclusionBody,
  Exclusion,
  ExclusionList,
  Indicator,
  IndicatorList,
  IndicatorQuery,
  ProposeIndicatorBody,
} from './schemas/indicators.js';
import {
  MailboxList,
  MessageDetail,
  MessageList,
  MessageQuery,
  SimulatedDeliveryBody,
  SimulatedDeliveryResult,
  SyncResult,
} from './schemas/lab.js';
import { ReportDocument } from './schemas/report-document.js';
import { ActionList, QuarantineRequest, QuarantineResponse, RestoreRequest, RestoreResponse } from './schemas/response.js';

/** Sube con cada cambio del contrato; los cambios que rompen algo se avisan a Cesar. */
export const CONTRACT_VERSION = '0.3.0';

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const error = (description: string) => ({ description, content: json(ErrorResponse) });

const e400 = error('Datos inválidos (`validation_error`).');
const e401 = error('No hay sesión activa (`unauthenticated`).');
const e403 = error('El rol no permite esta acción o falta el token CSRF (`forbidden`).');
const e404 = error('No existe o no es del usuario (`not_found`). Se usa 404 y no 403 para no revelar reportes ajenos.');
const e413 = error('Archivo o texto demasiado grande (`payload_too_large`).');
const e429 = error('Demasiadas peticiones (`rate_limited`).');
const e403Role = error('Rol insuficiente: solo analista o administrador (`forbidden`).');
const e403RoleCsrf = error(
  'Rol insuficiente (solo analista o administrador), o falta o no coincide el token CSRF (`forbidden`).',
);
const e403Csrf = error('Falta o no coincide el token CSRF (`forbidden`).');
const e404Any = error('No existe, el ID está mal formado o no se puede ver (`not_found`).');
const eNotReady = error('El análisis aún no termina: en cola o procesando (`report_not_ready`).');
const e503 = error('El servidor IMAP del laboratorio o ClamAV no responden (`service_unavailable`).');
const listError = error('Parámetros de paginación o filtro inválidos (`validation_error`).');

const mailboxId = z.object({ mailboxId: z.uuid() });
const messageId = z.object({ messageId: z.uuid() });
const indicatorId = z.object({ indicatorId: z.uuid() });
const exclusionId = z.object({ exclusionId: z.uuid() });
const incidentId = z.object({ incidentId: z.uuid() });
const actionId = z.object({ actionId: z.uuid() });

const reportId = z.object({ reportId: z.uuid() });
const setCookie = z.object({
  'set-cookie': z.string().meta({ description: 'Cookie de sesión `cbl_session` (HttpOnly, Secure, SameSite).' }),
});

export function buildDocument() {
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'CorreoBajoLupa API',
      version: CONTRACT_VERSION,
      description: [
        'Contrato de M0 (cuentas), M1 (reportes y hallazgos) y M2 a M7 (adjuntos, informe, laboratorio IMAP, indicadores, incidentes, cuarentena y auditoría).',
        'Las rutas de M2 a M7 se declaran antes de implementarse: hasta que llegue su módulo, la API real no las sirve.',
        'Regla de congelamiento: solo se agregan cosas (endpoints, campos opcionales, valores nuevos avisados); lo que rompa algo sube de versión y se avisa antes.',
        '',
        'Convenciones: rutas, campos y valores en inglés (camelCase / snake_case); textos para personas en español.',
        'Autenticación por cookie de sesión `cbl_session`; las peticiones que modifican datos llevan la cabecera `X-CSRF-Token`.',
        'El análisis es asíncrono: subir o pegar devuelve 202 y el estado se consulta con `GET /reports/{reportId}`.',
        'Todo texto de correo es contenido hostil: el front siempre lo escapa. Nunca se visitan los enlaces.',
        'Todo lo que salga de un correo y parezca enlace, dominio, IP o dirección se entrega desactivado (`hxxp`, `[.]`, D-017).',
        'Un ID mal formado o de un recurso que el usuario no puede ver responde 404 `not_found`; un rol insuficiente en una ruta solo de analista o administrador, 403 `forbidden`.',
      ].join('\n'),
    },
    servers: [{ url: '/api/v1', description: 'Mismo origen que el front (URL relativa, D-031).' }],
    tags: [
      { name: 'Salud' },
      { name: 'Cuenta' },
      { name: 'Usuarios' },
      { name: 'Reportes' },
      { name: 'Laboratorio' },
      { name: 'Indicadores' },
      { name: 'Exclusiones' },
      { name: 'Incidentes' },
      { name: 'Respuesta' },
      { name: 'Auditoría' },
    ],
    security: [{ sessionCookie: [] }],
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'cbl_session' },
      },
    },
    paths: {
      '/health': {
        get: {
          operationId: 'getHealth',
          tags: ['Salud'],
          security: [],
          summary: 'Estado del servicio',
          responses: {
            200: { description: 'El servicio responde.', content: json(z.object({ status: z.literal('ok') })) },
          },
        },
      },

      '/auth/register': {
        post: {
          operationId: 'register',
          tags: ['Cuenta'],
          security: [],
          summary: 'Crear cuenta (rol inicial: reportante) e iniciar sesión',
          requestBody: { required: true, content: json(RegisterBody) },
          responses: {
            201: { description: 'Cuenta creada con sesión iniciada.', headers: setCookie, content: json(Session) },
            400: e400,
            409: error('Ya existe una cuenta con ese correo (`email_taken`).'),
            429: e429,
          },
        },
      },
      '/auth/login': {
        post: {
          operationId: 'login',
          tags: ['Cuenta'],
          security: [],
          summary: 'Iniciar sesión',
          requestBody: { required: true, content: json(LoginBody) },
          responses: {
            200: { description: 'Sesión iniciada.', headers: setCookie, content: json(Session) },
            400: e400,
            401: error('Correo o contraseña incorrectos, o cuenta desactivada (`invalid_credentials`).'),
            429: e429,
          },
        },
      },
      '/auth/logout': {
        post: {
          operationId: 'logout',
          tags: ['Cuenta'],
          summary: 'Cerrar sesión',
          requestParams: { header: csrfHeader },
          responses: { 204: { description: 'Sesión cerrada.' }, 401: e401, 403: e403 },
        },
      },
      '/auth/me': {
        get: {
          operationId: 'getSession',
          tags: ['Cuenta'],
          summary: 'Usuario de la sesión actual y su token CSRF',
          responses: { 200: { description: 'Sesión activa.', content: json(Session) }, 401: e401 },
        },
      },

      '/users': {
        get: {
          operationId: 'listUsers',
          tags: ['Usuarios'],
          summary: 'Listar usuarios (solo administrador)',
          requestParams: { query: PageQuery.extend({ role: Role.optional() }) },
          responses: {
            200: { description: 'Página de usuarios.', content: json(UserList) },
            400: error('Parámetros de paginación o filtro inválidos (`validation_error`).'),
            401: e401,
            403: e403,
          },
        },
      },
      '/users/{userId}': {
        patch: {
          operationId: 'updateUser',
          tags: ['Usuarios'],
          summary: 'Cambiar rol o desactivar una cuenta (solo administrador)',
          requestParams: { path: z.object({ userId: z.uuid() }), header: csrfHeader },
          requestBody: { required: true, content: json(UpdateUserBody) },
          responses: {
            200: { description: 'Usuario actualizado; sus sesiones se cerraron.', content: json(User) },
            400: e400,
            401: e401,
            403: e403,
            404: e404,
            409: error(
              'El cambio dejaría al sistema sin administradores activos, o un administrador intenta quitarse el rol o desactivarse (`conflict`).',
            ),
          },
        },
      },

      '/reports': {
        post: {
          operationId: 'uploadReport',
          tags: ['Reportes'],
          summary: 'Subir un `.eml` para analizarlo',
          requestParams: { header: csrfHeader },
          requestBody: { required: true, content: { 'multipart/form-data': { schema: UploadBody } } },
          responses: {
            202: { description: 'Recibido; el análisis queda en cola.', content: json(ReportSummary) },
            400: e400,
            401: e401,
            403: e403,
            413: e413,
            415: error('El archivo no es un `.eml` (`unsupported_media_type`).'),
            429: e429,
          },
        },
        get: {
          operationId: 'listReports',
          tags: ['Reportes'],
          summary: 'Listar reportes (el reportante ve solo los suyos; analista y administrador, todos)',
          requestParams: { query: PageQuery.extend({ status: ReportStatus.optional() }) },
          responses: {
            200: { description: 'Página de reportes.', content: json(ReportList) },
            400: error('Parámetros de paginación o filtro inválidos (`validation_error`).'),
            401: e401,
          },
        },
      },
      '/reports/paste': {
        post: {
          operationId: 'pasteReport',
          tags: ['Reportes'],
          summary: 'Pegar el texto de un mensaje para analizarlo',
          requestParams: { header: csrfHeader },
          requestBody: { required: true, content: json(PasteBody) },
          responses: {
            202: { description: 'Recibido; el análisis queda en cola.', content: json(ReportSummary) },
            400: e400,
            401: e401,
            403: e403,
            413: e413,
            429: e429,
          },
        },
      },
      '/reports/{reportId}': {
        get: {
          operationId: 'getReport',
          tags: ['Reportes'],
          summary: 'Estado y datos de un reporte',
          requestParams: { path: reportId },
          responses: { 200: { description: 'Reporte.', content: json(ReportDetail) }, 401: e401, 404: e404 },
        },
        delete: {
          operationId: 'deleteReport',
          tags: ['Reportes'],
          summary: 'Borrar un reporte y sus archivos',
          requestParams: { path: reportId, header: csrfHeader },
          responses: { 204: { description: 'Borrado.' }, 401: e401, 403: e403, 404: e404 },
        },
      },
      '/reports/{reportId}/findings': {
        get: {
          operationId: 'listFindings',
          tags: ['Reportes'],
          summary: 'Hallazgos con regla y evidencia',
          requestParams: { path: reportId },
          responses: { 200: { description: 'Hallazgos (puede estar vacío).', content: json(FindingList) }, 401: e401, 404: e404 },
        },
      },
      '/reports/{reportId}/html': {
        get: {
          operationId: 'getReportHtml',
          tags: ['Reportes'],
          summary: 'HTML del correo ya saneado, para el `<iframe sandbox>`',
          description:
            'Se sanea al pedirlo (D-035). Incrustar solo en `<iframe sandbox>` sin permisos; nunca `allow-scripts` junto con `allow-same-origin`. Esta ruta no envía `X-Frame-Options`: la CSP `frame-ancestors \'self\'` permite incrustarla solo desde el mismo origen (D-052).',
          requestParams: { path: reportId },
          responses: {
            200: {
              description: 'Documento HTML saneado.',
              headers: z.object({
                'content-security-policy': z
                  .string()
                  .meta({ description: "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'" }),
                'x-content-type-options': z.string().meta({ description: 'nosniff' }),
                'cache-control': z.string().meta({ description: 'no-store' }),
              }),
              content: { 'text/html': { schema: z.string() } },
            },
            401: e401,
            404: error('No existe, no es del usuario o el correo no trae parte HTML (`not_found`).'),
            409: error('El análisis aún no termina (`report_not_ready`).'),
          },
        },
      },
      '/reports/{reportId}/text': {
        get: {
          operationId: 'getReportText',
          tags: ['Reportes'],
          summary: 'Texto plano del correo (pestaña de texto)',
          requestParams: { path: reportId },
          responses: {
            200: { description: 'Texto plano.', content: { 'text/plain': { schema: z.string() } } },
            401: e401,
            404: e404,
            409: error('El análisis aún no termina (`report_not_ready`).'),
          },
        },
      },

      '/reports/{reportId}/attachments': {
        get: {
          operationId: 'listAttachments',
          tags: ['Reportes'],
          summary: 'Adjuntos con SHA-256 y resultado de ClamAV (M2)',
          description: 'Nunca se descarga el contenido al navegador. La regla R7 sale en `/findings` como las demás.',
          requestParams: { path: reportId },
          responses: {
            200: { description: 'Adjuntos (puede estar vacío).', content: json(AttachmentList) },
            401: e401,
            404: e404,
            409: eNotReady,
          },
        },
      },
      '/reports/{reportId}/report': {
        get: {
          operationId: 'getReportDocument',
          tags: ['Reportes'],
          summary: 'Informe con guía de mitigación (M3)',
          description:
            'Texto determinista de plantilla (D-011). Un reporte `failed` responde 200 con la nota `failed` (D-004). La exportación a PDF queda fuera.',
          requestParams: { path: reportId },
          responses: {
            200: { description: 'Informe.', content: json(ReportDocument) },
            401: e401,
            404: e404,
            409: eNotReady,
          },
        },
      },

      '/mailboxes': {
        get: {
          operationId: 'listMailboxes',
          tags: ['Laboratorio'],
          summary: 'Buzones del laboratorio IMAP (analista o administrador)',
          responses: { 200: { description: 'Buzones.', content: json(MailboxList) }, 401: e401, 403: e403Role },
        },
      },
      '/mailboxes/{mailboxId}/sync': {
        post: {
          operationId: 'syncMailbox',
          tags: ['Laboratorio'],
          summary: 'Sincronizar un buzón ahora (analista o administrador)',
          description: 'Se hace al momento, con un tiempo máximo de 45 s. Si cambió UIDVALIDITY se informa en `uidValidityChanged` (P-12).',
          requestParams: { path: mailboxId, header: csrfHeader },
          responses: {
            200: { description: 'Sincronización terminada.', content: json(SyncResult) },
            401: e401,
            403: e403RoleCsrf,
            404: e404Any,
            409: error('Ya hay una sincronización de ese buzón en curso (`conflict`).'),
            503: e503,
          },
        },
      },
      '/mailboxes/{mailboxId}/simulated-delivery': {
        post: {
          operationId: 'simulatedDelivery',
          tags: ['Laboratorio'],
          summary: 'Entrega simulada de un reporte `.eml` en un buzón del laboratorio (analista o administrador)',
          description: 'Solo buzones del laboratorio y reportes subidos como `.eml`; siempre auditada. Usa IMAP `APPEND` con `UIDPLUS` (D-006).',
          requestParams: { path: mailboxId, header: csrfHeader },
          requestBody: { required: true, content: json(SimulatedDeliveryBody) },
          responses: {
            201: { description: 'Mensaje insertado.', content: json(SimulatedDeliveryResult) },
            400: error('Cuerpo inválido, o el reporte no se subió como `.eml` (`validation_error`).'),
            401: e401,
            403: e403RoleCsrf,
            404: error('El buzón o el reporte no existe o no se puede ver (`not_found`).'),
            409: error('Ya hay una sincronización o una entrega simulada de ese buzón en curso (`conflict`).'),
            503: e503,
          },
        },
      },
      '/messages': {
        get: {
          operationId: 'listMessages',
          tags: ['Laboratorio'],
          summary: 'Mensajes indexados, por fecha descendente (analista o administrador)',
          requestParams: { query: MessageQuery },
          responses: {
            200: { description: 'Página de mensajes.', content: json(MessageList) },
            400: listError,
            401: e401,
            403: e403Role,
          },
        },
      },
      '/messages/{messageId}': {
        get: {
          operationId: 'getMessage',
          tags: ['Laboratorio'],
          summary: 'Detalle de un mensaje indexado (analista o administrador)',
          requestParams: { path: messageId },
          responses: {
            200: { description: 'Mensaje.', content: json(MessageDetail) },
            401: e401,
            403: e403Role,
            404: e404Any,
          },
        },
      },

      '/indicators': {
        post: {
          operationId: 'proposeIndicator',
          tags: ['Indicadores'],
          summary: 'Proponer un indicador (el reportante, solo desde un reporte suyo)',
          requestParams: { header: csrfHeader },
          requestBody: { required: true, content: json(ProposeIndicatorBody) },
          responses: {
            201: { description: 'Indicador propuesto.', content: json(Indicator) },
            400: error('Cuerpo inválido, valor inválido para el tipo o, para el reportante, falta `reportId` (`validation_error`).'),
            401: e401,
            403: e403Csrf,
            404: error('El reporte no existe o no es del usuario (`not_found`).'),
            409: error('Ya existe ese indicador, o el dominio está en la lista de exclusión (P-11) (`conflict`).'),
          },
        },
        get: {
          operationId: 'listIndicators',
          tags: ['Indicadores'],
          summary: 'Listar indicadores (el reportante ve los que propuso; analista y administrador, todos)',
          requestParams: { query: IndicatorQuery },
          responses: {
            200: { description: 'Página de indicadores.', content: json(IndicatorList) },
            400: listError,
            401: e401,
          },
        },
      },
      '/indicators/{indicatorId}/confirm': {
        post: {
          operationId: 'confirmIndicator',
          tags: ['Indicadores'],
          summary: 'Confirmar un indicador (analista o administrador)',
          requestParams: { path: indicatorId, header: csrfHeader },
          responses: {
            200: { description: 'Indicador confirmado.', content: json(Indicator) },
            401: e401,
            403: e403RoleCsrf,
            404: e404Any,
            409: error('El indicador ya fue decidido (`conflict`).'),
          },
        },
      },
      '/indicators/{indicatorId}/dismiss': {
        post: {
          operationId: 'dismissIndicator',
          tags: ['Indicadores'],
          summary: 'Descartar un indicador (analista o administrador)',
          requestParams: { path: indicatorId, header: csrfHeader },
          responses: {
            200: { description: 'Indicador descartado.', content: json(Indicator) },
            401: e401,
            403: e403RoleCsrf,
            404: e404Any,
            409: error('El indicador ya fue decidido (`conflict`).'),
          },
        },
      },
      '/indicators/{indicatorId}/candidates': {
        get: {
          operationId: 'listCandidates',
          tags: ['Indicadores'],
          summary: 'Mensajes candidatos de un indicador confirmado, con sus razones (analista o administrador)',
          description: 'Sin puntuación: orden por número de razones y luego por fecha (D-019).',
          requestParams: { path: indicatorId, query: PageQuery },
          responses: {
            200: { description: 'Página de candidatos.', content: json(CandidateList) },
            400: listError,
            401: e401,
            403: e403Role,
            404: e404Any,
            409: error('El indicador no está confirmado (`conflict`).'),
          },
        },
      },
      '/exclusions': {
        get: {
          operationId: 'listExclusions',
          tags: ['Exclusiones'],
          summary: 'Lista de exclusión (analista o administrador)',
          description: 'Incluye, como solo lectura (`source: config`, `id: null`), los dominios institucionales de la configuración.',
          responses: { 200: { description: 'Exclusiones.', content: json(ExclusionList) }, 401: e401, 403: e403Role },
        },
        post: {
          operationId: 'createExclusion',
          tags: ['Exclusiones'],
          summary: 'Agregar un dominio a la lista de exclusión (analista o administrador)',
          requestParams: { header: csrfHeader },
          requestBody: { required: true, content: json(CreateExclusionBody) },
          responses: {
            201: { description: 'Exclusión creada.', content: json(Exclusion) },
            400: e400,
            401: e401,
            403: e403RoleCsrf,
            409: error('Ese dominio ya está excluido (`conflict`).'),
          },
        },
      },
      '/exclusions/{exclusionId}': {
        delete: {
          operationId: 'deleteExclusion',
          tags: ['Exclusiones'],
          summary: 'Quitar un dominio de la lista de exclusión (analista o administrador)',
          requestParams: { path: exclusionId, header: csrfHeader },
          responses: {
            204: { description: 'Exclusión borrada.' },
            401: e401,
            403: e403RoleCsrf,
            404: e404Any,
            409: error(
              'Las exclusiones de la configuración no se borran (`conflict`). Hoy no ocurre porque esas no tienen `id`; queda reservado.',
            ),
          },
        },
      },

      '/incidents': {
        post: {
          operationId: 'createIncident',
          tags: ['Incidentes'],
          summary: 'Crear un incidente (analista o administrador)',
          requestParams: { header: csrfHeader },
          requestBody: { required: true, content: json(CreateIncidentBody) },
          responses: {
            201: { description: 'Incidente creado.', content: json(IncidentDetail) },
            400: e400,
            401: e401,
            403: e403RoleCsrf,
          },
        },
        get: {
          operationId: 'listIncidents',
          tags: ['Incidentes'],
          summary: 'Listar incidentes (analista o administrador)',
          requestParams: { query: IncidentQuery },
          responses: {
            200: { description: 'Página de incidentes.', content: json(IncidentList) },
            400: listError,
            401: e401,
            403: e403Role,
          },
        },
      },
      '/incidents/{incidentId}': {
        get: {
          operationId: 'getIncident',
          tags: ['Incidentes'],
          summary: 'Detalle de un incidente (analista o administrador)',
          requestParams: { path: incidentId },
          responses: {
            200: { description: 'Incidente.', content: json(IncidentDetail) },
            401: e401,
            403: e403Role,
            404: e404Any,
          },
        },
        patch: {
          operationId: 'updateIncident',
          tags: ['Incidentes'],
          summary: 'Cambiar título, descripción o estado (analista o administrador)',
          requestParams: { path: incidentId, header: csrfHeader },
          requestBody: { required: true, content: json(UpdateIncidentBody) },
          responses: {
            200: { description: 'Incidente actualizado.', content: json(IncidentDetail) },
            400: e400,
            401: e401,
            403: e403RoleCsrf,
            404: e404Any,
            409: error('Transición de estado inválida, o el incidente ya es final (`conflict`).'),
          },
        },
      },
      '/incidents/{incidentId}/reports': {
        post: {
          operationId: 'addIncidentReport',
          tags: ['Incidentes'],
          summary: 'Asociar un reporte al incidente (analista o administrador)',
          requestParams: { path: incidentId, header: csrfHeader },
          requestBody: { required: true, content: json(AddIncidentReportBody) },
          responses: {
            200: { description: 'Incidente actualizado.', content: json(IncidentDetail) },
            400: error('Falta `reportId` o no es un UUID (`validation_error`).'),
            401: e401,
            403: e403RoleCsrf,
            404: error('El incidente o el reporte no existe (`not_found`).'),
            409: error('El reporte ya está asociado (`conflict`).'),
          },
        },
      },
      '/incidents/{incidentId}/reports/{reportId}': {
        delete: {
          operationId: 'removeIncidentReport',
          tags: ['Incidentes'],
          summary: 'Quitar un reporte del incidente (analista o administrador)',
          requestParams: { path: incidentId.extend(reportId.shape), header: csrfHeader },
          responses: {
            204: { description: 'Reporte quitado del incidente.' },
            401: e401,
            403: e403RoleCsrf,
            404: error('El incidente no existe o el reporte no está asociado (`not_found`).'),
          },
        },
      },
      '/incidents/{incidentId}/indicators': {
        post: {
          operationId: 'addIncidentIndicator',
          tags: ['Incidentes'],
          summary: 'Asociar un indicador al incidente (analista o administrador)',
          requestParams: { path: incidentId, header: csrfHeader },
          requestBody: { required: true, content: json(AddIncidentIndicatorBody) },
          responses: {
            200: { description: 'Incidente actualizado.', content: json(IncidentDetail) },
            400: error('Falta `indicatorId` o no es un UUID (`validation_error`).'),
            401: e401,
            403: e403RoleCsrf,
            404: error('El incidente o el indicador no existe (`not_found`).'),
            409: error('El indicador ya está asociado (`conflict`).'),
          },
        },
      },
      '/incidents/{incidentId}/indicators/{indicatorId}': {
        delete: {
          operationId: 'removeIncidentIndicator',
          tags: ['Incidentes'],
          summary: 'Quitar un indicador del incidente (analista o administrador)',
          requestParams: { path: incidentId.extend(indicatorId.shape), header: csrfHeader },
          responses: {
            204: { description: 'Indicador quitado del incidente.' },
            401: e401,
            403: e403RoleCsrf,
            404: error('El incidente no existe o el indicador no está asociado (`not_found`).'),
          },
        },
      },
      '/incidents/{incidentId}/comments': {
        post: {
          operationId: 'createComment',
          tags: ['Incidentes'],
          summary: 'Comentar un incidente (analista o administrador)',
          description: 'Los comentarios no se editan ni se borran.',
          requestParams: { path: incidentId, header: csrfHeader },
          requestBody: { required: true, content: json(CreateCommentBody) },
          responses: {
            201: { description: 'Comentario creado.', content: json(Comment) },
            400: e400,
            401: e401,
            403: e403RoleCsrf,
            404: e404Any,
            409: error('El incidente ya es final (`conflict`).'),
          },
        },
      },

      '/incidents/{incidentId}/quarantine': {
        post: {
          operationId: 'quarantineMessages',
          tags: ['Respuesta'],
          summary: 'Poner en cuarentena los mensajes aprobados uno por uno (analista o administrador)',
          description:
            'Aprobación mensaje por mensaje (D-013): solo actúa sobre los IDs enviados con `confirm: true`. Idempotente (P-13); verifica UIDVALIDITY antes de mover (P-12); un resultado por mensaje (P-14).',
          requestParams: { path: incidentId, header: csrfHeader },
          requestBody: { required: true, content: json(QuarantineRequest) },
          responses: {
            200: { description: 'Resultado por mensaje.', content: json(QuarantineResponse) },
            400: e400,
            401: e401,
            403: e403RoleCsrf,
            404: e404Any,
            409: error('El incidente no está en `analyzing` ni en `contained` (`conflict`).'),
            503: e503,
          },
        },
      },
      '/incidents/{incidentId}/actions': {
        get: {
          operationId: 'listIncidentActions',
          tags: ['Respuesta'],
          summary: 'Acciones de cuarentena y restauración de un incidente (analista o administrador)',
          requestParams: { path: incidentId },
          responses: {
            200: { description: 'Acciones.', content: json(ActionList) },
            401: e401,
            403: e403Role,
            404: e404Any,
          },
        },
      },
      '/actions/{actionId}/restore': {
        post: {
          operationId: 'restoreAction',
          tags: ['Respuesta'],
          summary: 'Restaurar un mensaje puesto en cuarentena (analista o administrador)',
          description: 'Reverifica el mensaje antes de devolverlo (D-008). Se permite en cualquier estado del incidente. Idempotente (P-13).',
          requestParams: { path: actionId, header: csrfHeader },
          requestBody: { required: true, content: json(RestoreRequest) },
          responses: {
            200: { description: 'Resultado de la restauración.', content: json(RestoreResponse) },
            400: e400,
            401: e401,
            403: e403RoleCsrf,
            404: e404Any,
            503: e503,
          },
        },
      },
      '/audit': {
        get: {
          operationId: 'listAuditEvents',
          tags: ['Auditoría'],
          summary: 'Eventos de auditoría, por fecha descendente (analista o administrador, solo lectura)',
          requestParams: { query: AuditQuery },
          responses: {
            200: { description: 'Página de eventos.', content: json(AuditList) },
            400: listError,
            401: e401,
            403: e403Role,
          },
        },
      },
    },
  });
}
