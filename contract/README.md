# Contrato de la API

`openapi.json` es el contrato de la API (OpenAPI 3.1). **No se edita a mano**: se genera desde los
esquemas Zod de `src/contract/` con

```
npm run contract:generate
```

y `npm test` falla si el archivo commiteado no coincide con lo generado.

## Para quien consume la API (front)

- Las rutas son relativas a `/api/v1` (campo `servers`): el front y la API comparten origen.
- Autenticación por cookie `cbl_session` (HttpOnly): enviar siempre con credenciales.
- Las peticiones que modifican datos llevan la cabecera `X-CSRF-Token`; el valor viene en
  `GET /auth/me` y en las respuestas de registro y entrada.
- Tipos de TypeScript: `npx openapi-typescript contract/openapi.json -o src/api/schema.d.ts`.
- Todo texto de correo es contenido hostil: se escapa siempre. El HTML del correo solo se
  muestra con `GET /reports/{reportId}/html` dentro de un `<iframe sandbox>` sin permisos.
- Los cambios del contrato suben `info.version`; los que rompen algo se avisan.
- Las rutas de M2 a M7 están declaradas desde 0.3.0, pero la API real las sirve solo cuando llega su
  módulo. Mientras tanto se trabaja con un servidor simulado a partir de `openapi.json`.

## Regla de congelamiento (desde 0.3.0)

El contrato 0.3.0 quedó congelado el 22 nov 2026. A partir de ahí:

- **Solo se agregan cosas:** endpoints nuevos, campos opcionales nuevos y valores nuevos de un enum
  (estos últimos, avisados antes, porque un `switch` del front puede no esperarlos).
- **Lo que rompe algo** (quitar o renombrar un campo, una ruta o un valor, volver obligatorio un campo,
  cambiar un tipo o un código de respuesta ya documentado) sube de versión y se avisa antes.
- Lo marcado como **provisional** (por ejemplo `Attachment.detectedType`) puede ajustarse al implementar su
  módulo, con aviso.

## Cambios

- **0.3.0:** contrato de M2 a M7, declarado antes de implementarse (28 operaciones nuevas, solo agrega):
  - **M2 adjuntos:** `GET /reports/{reportId}/attachments` (`Attachment` con SHA-256 y `scanStatus`; `error`
    nunca es limpio).
  - **M3 informe:** `GET /reports/{reportId}/report` (`ReportDocument` con guía de plantilla; un reporte `failed`
    responde 200 con la nota `failed`).
  - **M4 laboratorio IMAP:** `GET /mailboxes`, `POST /mailboxes/{mailboxId}/sync`, `GET /messages`,
    `GET /messages/{messageId}` y `POST /mailboxes/{mailboxId}/simulated-delivery`.
  - **M5 indicadores:** `POST` y `GET /indicators`, `POST /indicators/{indicatorId}/confirm` y `/dismiss`,
    `GET /indicators/{indicatorId}/candidates` (razones sin puntuación), y `GET`, `POST /exclusions` y
    `DELETE /exclusions/{exclusionId}`.
  - **M6 incidentes:** `POST` y `GET /incidents`, `GET` y `PATCH /incidents/{incidentId}`, asociar y quitar
    reportes e indicadores, y `POST /incidents/{incidentId}/comments`.
  - **M7 respuesta y auditoría:** `POST /incidents/{incidentId}/quarantine`, `GET /incidents/{incidentId}/actions`,
    `POST /actions/{actionId}/restore` y `GET /audit`.
  - Nuevo código de error **`service_unavailable`** (503): el IMAP del laboratorio o ClamAV no responden.
  - `ReportLink.displayText` y `ReportLink.domain` se documentan como **desactivados** (`hxxp`, `[.]`), igual que
    `defangedUrl`; el tipo no cambia. La API los empieza a entregar así en una tarea aparte.
  - Todo endpoint que modifica declara 403 (CSRF y, donde aplica, rol) y todo endpoint con cuerpo declara 400.
- **0.2.2:** `GET /reports/{reportId}/html` responde **404 `not_found`** si el correo no trae parte HTML (antes
  se documentaba como 409); el **409 `report_not_ready`** queda solo para un análisis que no ha terminado. Su CSP
  documentada suma `frame-ancestors 'self'` y la ruta no envía `X-Frame-Options` (se incrusta en un iframe del
  mismo origen, D-052). No cambia la forma de ningún dato.
- **0.2.1:** `GET /reports` declara **400 `validation_error`** para paginación o filtro de estado inválidos,
  igual que `GET /users`. Solo agrega.
- **0.2.0:** `PATCH /users/{userId}` puede responder **409 `conflict`** (un administrador no puede quitarse el
  rol ni desactivarse, y siempre debe quedar al menos un administrador activo). `GET /users` declara **400
  `validation_error`** para paginación o filtro inválidos. Nuevo código de error `conflict`. Solo agrega.
- **0.1.0:** contrato inicial de M0 (cuentas y usuarios) y M1 (reportes y hallazgos).
