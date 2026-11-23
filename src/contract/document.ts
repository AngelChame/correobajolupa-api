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

/** Sube con cada cambio del contrato; los cambios que rompen algo se avisan a Cesar. */
export const CONTRACT_VERSION = '0.2.1';

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const error = (description: string) => ({ description, content: json(ErrorResponse) });

const e400 = error('Datos inválidos (`validation_error`).');
const e401 = error('No hay sesión activa (`unauthenticated`).');
const e403 = error('El rol no permite esta acción o falta el token CSRF (`forbidden`).');
const e404 = error('No existe o no es del usuario (`not_found`). Se usa 404 y no 403 para no revelar reportes ajenos.');
const e413 = error('Archivo o texto demasiado grande (`payload_too_large`).');
const e429 = error('Demasiadas peticiones (`rate_limited`).');

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
        'Contrato v0 de M0 (cuentas) y M1 (reportes y hallazgos). Los demás módulos se agregan al llegar a ellos.',
        '',
        'Convenciones: rutas, campos y valores en inglés (camelCase / snake_case); textos para personas en español.',
        'Autenticación por cookie de sesión `cbl_session`; las peticiones que modifican datos llevan la cabecera `X-CSRF-Token`.',
        'El análisis es asíncrono: subir o pegar devuelve 202 y el estado se consulta con `GET /reports/{reportId}`.',
        'Todo texto de correo es contenido hostil: el front siempre lo escapa. Nunca se visitan los enlaces.',
      ].join('\n'),
    },
    servers: [{ url: '/api/v1', description: 'Mismo origen que el front (URL relativa, D-031).' }],
    tags: [
      { name: 'Salud' },
      { name: 'Cuenta' },
      { name: 'Usuarios' },
      { name: 'Reportes' },
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
            'Se sanea al pedirlo (D-035). Incrustar solo en `<iframe sandbox>` sin permisos; nunca `allow-scripts` junto con `allow-same-origin`.',
          requestParams: { path: reportId },
          responses: {
            200: {
              description: 'Documento HTML saneado.',
              headers: z.object({
                'content-security-policy': z
                  .string()
                  .meta({ description: "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'" }),
                'x-content-type-options': z.string().meta({ description: 'nosniff' }),
                'cache-control': z.string().meta({ description: 'no-store' }),
              }),
              content: { 'text/html': { schema: z.string() } },
            },
            401: e401,
            404: e404,
            409: error('El análisis aún no termina o el correo no trae HTML (`report_not_ready`).'),
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
    },
  });
}
