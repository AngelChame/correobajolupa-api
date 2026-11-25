# Análisis de URL — línea base y mapa de integración (Fase 0)

Fecha: 24 nov 2026. Rama `m9-analisis-url`, creada desde `origin/main` en
`bf7a378` (`AngelChame/correobajolupa-api`). No modifica el analizador.

## Línea base

- `npm ci --no-audit --no-fund` y `npm run db:generate` después de cambiar de M0 a M7.
- `npm test`: **31 archivos pasan, 5 se omiten; 461 pruebas pasan, 17 se omiten**.
  No se ejecutaron pruebas de integración con PostgreSQL ni el Compose completo.
- El hook local `commit-msg` y las exclusiones locales están en `.git/` y no se
  versionan. Cada clon debe prepararlos de nuevo.
- Referencias de regresión: `test/fixtures/expected.json` (26 casos) y
  `test/fixtures/lab/manifest.json` (21 mensajes). Mantener especialmente
  `L06-boletin-real-anonimizado.eml` y los mensajes legítimos sin falsos positivos.

## Archivos y restricciones para las fases siguientes

| Tema | Ubicación actual | Implicación |
| --- | --- | --- |
| Reglas | `src/analysis/rules.ts`, `src/analysis/analyze.ts`, `src/analysis/types.ts` | `applyRules` crea R1–R7 y `priorityOf` usa pesos. R8 no se emite aquí. Para R9 se deben actualizar las evidencias, el mapa de reglas, el tipo y la versión de reglas. |
| Enlaces | `src/analysis/links.ts` | `normalizeLink` conserva `raw` recortado a 500 caracteres, pero `normalizedUrl` **quita query, fragmento y credenciales**. Los parámetros de redirección no pueden evaluarse sobre `normalizedUrl`; evaluar en memoria, con límites y sin persistir ni registrar el valor original. |
| Normalización M5 | `src/indicators/normalize.ts` | `normalizeIndicator('url', valor)` valida y comparte la normalización de los enlaces. Reutilizarla para valores de feeds; estudiar qué se entiende por coincidencia exacta cuando dos URLs difieren solo en query o fragmento. |
| Contrato y base | `src/contract/schemas/reports.ts`, `src/contract/document.ts`, `contract/openapi.json`, `prisma/schema.prisma` | `RuleId` existe tanto en Zod/OpenAPI como en el enum Prisma/PostgreSQL. Agregar R9/R10 también exige migración aditiva del enum y regenerar el cliente; la versión del contrato está en `CONTRACT_VERSION` (`0.3.0`). |
| Evidencia | `src/analysis/types.ts`, `src/queue/process.ts`, `src/contract/schemas/reports.ts` | El analizador produce `{label, value, kind}`; al guardar, `defangEvidence` transforma URL/dominio/correo en JSON `{label, value}`. Fuente, fecha y conteos se pueden representar con etiquetas y valores de texto controlado, pero hay que decidir cómo representar un estado de fuente no disponible **sin fingir un hallazgo**. No pasar contenido hostil como `kind: 'text'`. |
| Informe | `src/report/guide-texts.ts`, `src/report/build.ts` | `RULE_GUIDES` exige una entrada por regla; `GUIDE_VERSION` sube al editar textos. Actualizar pruebas que fijan versiones (`test/report-guide-texts.test.ts` y `test/analysis-attachments.test.ts`). |
| Worker | `src/worker.ts`, `src/queue/process.ts`, `src/queue/cleanup.ts` | `runCleanupSchedule` ya usa `pg_try_advisory_xact_lock`; el nuevo programador de feeds debe tener candado propio. El análisis tiene un tiempo máximo ligado al arriendo: la reputación remota no debe bloquear ni hacer fallar el reporte. |
| Redes | `compose.yaml` | `worker` está en `default`, `clamav-net` e `imap-net`; solo `imap-net` es `internal: true`. Hay una ruta de red prevista mediante `default`, **no se ha probado aún el acceso externo desde el contenedor**. |
| Front | `../correobajolupa-web/src/api/schema.d.ts`, `../correobajolupa-web/src/pages/ReportDetailPage.tsx`, `../correobajolupa-web/src/pages/ReportDocumentPage.tsx` | El tipo generado enumera R1–R8; las vistas muestran el ID y texto recibido, sin `switch` exhaustivo identificado. Regenerar los tipos y revisar textos antes de fusionar el contrato. |

## Pendiente antes de implementar cada capa

- Confirmar con Ángel la decisión D-069 y acordar el diseño del estado
  «fuente no disponible» y de un veredicto por URL: el contrato actual ofrece
  hallazgos y prioridad del **reporte**, no un campo de veredicto por enlace.
- Verificar formatos, condiciones de uso y límites vigentes de OpenPhish,
  URLhaus y VirusTotal antes de escribir parsers o clientes. No llamar a esos
  servicios en las pruebas.
- Validar salida a internet del worker en el Compose real. Si no hay salida,
  no alterar `imap-net` para conseguirla.
- Pedir una descripción o muestra anonimizada del enlace del profesor y crear
  únicamente un caso sintético equivalente; no incorporar la URL real.
