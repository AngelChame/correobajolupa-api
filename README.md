# CorreoBajoLupa — API

Backend, trabajador de análisis, infraestructura (Docker Compose, servidor IMAP de laboratorio) y contrato OpenAPI de **CorreoBajoLupa**: una plataforma web con API REST que analiza correos sospechosos con reglas explicables, relaciona mensajes de una misma campaña y entrega un informe con guía de mitigación. En un laboratorio IMAP controlado permite buscar mensajes relacionados y ponerlos en cuarentena de forma autorizada y reversible.

> **Estado:** en desarrollo. M0 (cimientos: cuentas, usuarios, cabeceras y límites), M1 (entrada y análisis: subir o pegar un correo, worker con reglas R1 a R6, visor saneado y limpieza programada), M2 (adjuntos: SHA-256, ClamAV y regla R7) y M3 (informe con guía de mitigación) hechos; contrato OpenAPI 0.3.0 (declara también M4 a M7, que aún no se implementan). Proyecto académico de Seguridad Informática (Universidad Politécnica de Chiapas).

## Datos y seguridad

- El proyecto trabaja con correos de phishing. En este repositorio solo hay datos **sintéticos o anonimizados**; nunca se suben correos reales, contraseñas, llaves ni archivos `.env`.
- Los enlaces de los correos nunca se visitan; en informes se muestran desactivados.

## Requisitos

- Node.js 24 (LTS) y npm. La versión está en `.nvmrc`.
- Docker y Docker Compose.

## Cómo levantarlo

```bash
cp .env.example .env          # cambia las contraseñas de ejemplo
docker compose up -d --build  # PostgreSQL, migraciones, la API, el worker y ClamAV
curl http://127.0.0.1:3000/api/v1/health   # {"status":"ok"}
```

Con el front de Cesar, ver [Pila completa con el front](#pila-completa-con-el-front).

Al arrancar, el servicio `migrate` aplica las migraciones pendientes (`prisma migrate deploy`) y termina; la API espera a que salga bien. La imagen de la API no lleva la CLI de Prisma ni las migraciones.

El Compose solo pasa a la API las variables que usa (lista en `compose.yaml`); lo demás del `.env` se queda fuera del contenedor.

Para desarrollar sin construir la imagen: `npm ci` y `npm test` (pruebas unitarias, no necesitan base). `npm run dev` necesita `DATABASE_URL` apuntando a un PostgreSQL al que llegues desde tu máquina.

## Cuentas y sesiones (`/api/v1/auth`)

| Ruta | Qué hace |
| --- | --- |
| `POST /auth/register` | Crea la cuenta (rol `reporter`) e inicia sesión. 409 `email_taken` si el correo ya existe |
| `POST /auth/login` | Inicia sesión. 401 `invalid_credentials` con el mismo mensaje exista o no la cuenta |
| `POST /auth/logout` | Cierra la sesión (requiere `X-CSRF-Token`) |
| `GET /auth/me` | Usuario de la sesión y su token CSRF |

- **Contraseñas:** Argon2id de Node (`crypto.argon2`, Node ≥ 24.7) con los parámetros base de OWASP (19 MiB, t=2, p=1). Nunca se registran ni se devuelven.
- **Sesión:** cookie `cbl_session` (`HttpOnly`, `SameSite=Lax`, `Secure`) con un token aleatorio; la base guarda solo su SHA-256. Vence a las 8 h o tras 30 min sin actividad.
- **CSRF:** toda petición que modifica datos (salvo registro y entrada) exige `X-CSRF-Token` con el valor de `GET /auth/me`; sin sesión responde 401 y con un token incorrecto, 403.
- **Límites:** registro 10 por hora por IP; login 30 cada 15 min por IP y 5 fallos cada 15 min por correo (los aciertos no cuentan). Se cambian con las variables `RATE_LIMIT_*`.
- **Primer administrador:** con `FIRST_ADMIN_EMAIL` y `FIRST_ADMIN_PASSWORD` en el `.env`, la API lo crea al arrancar si no hay ningún admin (queda en la auditoría como `system.bootstrap_admin`).
- **Invitación:** con `INVITE_CODE` definido, el registro exige ese código.

## Usuarios y roles (`/api/v1/users`, solo administrador)

| Ruta | Qué hace |
| --- | --- |
| `GET /users?page=&pageSize=&role=` | Lista paginada (orden estable por fecha de alta e id). 400 si los parámetros son inválidos |
| `PATCH /users/{userId}` | Cambia `role` y/o `active` (requiere `X-CSRF-Token`). 404 si no existe; 409 `conflict` si un admin intenta quitarse el rol o desactivarse, o si no quedaría ningún admin activo |

- Roles: `reporter` (por defecto al registrarse), `analyst` y `admin`. Las rutas se protegen con `requireRole(db, ...roles)`: sin sesión 401; rol insuficiente 403, que queda en la auditoría como `authz.denied`.
- Cambiar el rol o desactivar una cuenta cierra todas sus sesiones en la misma transacción (D-034); reactivarla no. Quedan en la auditoría `user.role_change` (rol anterior y nuevo), `user.deactivate` y `user.activate`.

## Cabeceras y límites de toda la API

- Cabeceras (helmet): `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY` y `Cache-Control: no-store`. HSTS (6 meses) solo en producción con `COOKIE_SECURE=true`.
- Una ruta puede sobrescribir esas cabeceras a propósito (la última escritura gana): el visor `GET /reports/{id}/html` pone su propia CSP y quita `X-Frame-Options` (D-035, D-052).
- Sin CORS: el front y la API comparten origen (D-031).
- Límite global: `RATE_LIMIT_GLOBAL_PER_MINUTE` peticiones por minuto por IP en `/api/v1` (300 por defecto), salvo `/health`.

Compromisos conocidos de esta etapa (M0):

- El 409 `email_taken` revela que un correo ya tiene cuenta (lo pide el contrato); el límite por IP lo frena.
- Con 5 fallos por correo, alguien puede bloquear 15 min la entrada de una cuenta concreta.
- Los contadores de los límites viven en memoria: se reinician al reiniciar la API (D-054 dejó fuera Redis; si hiciera falta compartirlos, por decidir dónde).
- **`trust proxy`** depende de `TRUST_PROXY_HOPS` (0 por defecto, apagado). Sin proxy, dentro del Compose la API ve la IP del puente de Docker, así que los límites por IP (también el global) los comparten todas las personas. Con el front delante (perfil `web`) va `TRUST_PROXY_HOPS=1`; ver [Pila completa con el front](#pila-completa-con-el-front).

Prueba rápida con `curl` (la pila levantada):

```bash
curl -s -c cookies.txt -H 'Content-Type: application/json'   -d '{"email":"ana@ejemplo.invalid","password":"una-clave-larga-123","displayName":"Ana"}'   http://127.0.0.1:3000/api/v1/auth/register        # guarda el csrfToken de la respuesta
curl -s -b cookies.txt http://127.0.0.1:3000/api/v1/auth/me
curl -s -b cookies.txt -X POST -H "X-CSRF-Token: <csrfToken>" http://127.0.0.1:3000/api/v1/auth/logout
```

## Reportes y análisis (`/api/v1/reports`, M1)

| Ruta | Qué hace |
| --- | --- |
| `POST /reports` | Sube un `.eml` (multipart, campo `file`, hasta `MAX_EML_BYTES`). 202 con el reporte en cola; 413, 415 o 400 |
| `POST /reports/paste` | Pega el texto del mensaje (`{ text }`, hasta `MAX_PASTE_BYTES`). 202 |
| `GET /reports` | Lista paginada (más recientes primero), filtro `status`. El reportante ve solo los suyos |
| `GET /reports/{id}` y `/findings` | Detalle con enlaces desactivados y hallazgos con regla y evidencia |
| `GET /reports/{id}/html` | HTML saneado al pedirlo, para un `<iframe sandbox>` (D-035). 409 mientras se analiza; 404 si no trae HTML |
| `GET /reports/{id}/text` | Texto plano con todas las URL desactivadas |
| `GET /reports/{id}/attachments` | Adjuntos con SHA-256 y resultado de ClamAV (M2). 409 mientras se analiza |
| `GET /reports/{id}/report` | Informe con guía de mitigación (M3). 409 mientras se analiza |
| `DELETE /reports/{id}` | Borra el reporte, sus adjuntos y su carpeta |

- Un reporte ajeno o un id que no es UUID responde 404, no 403. Cuota por cuenta: `REPORTS_PER_USER_PER_HOUR`.
- El archivo se guarda tal cual en el volumen `reports-data` (una carpeta por reporte, nombre aleatorio; D-038) con su SHA-256.
- **Worker** (`node dist/worker.js`, servicio `worker`): la cola es la propia tabla `reports` (D-054). Toma trabajos con `FOR UPDATE SKIP LOCKED` y un arriendo de `JOB_LEASE_SECONDS`; si un worker muere, otro retoma el reporte. Reintenta hasta `JOB_MAX_ATTEMPTS` y después lo deja `failed`.
- **Reglas** R1 a R7 (versión `m2-2026.11`) con evidencia; SPF, DKIM y DMARC solo informativos (D-016). R8 (indicadores confirmados) llega al final.
- Nunca se visitan los enlaces y en las respuestas salen desactivados (`hxxp://dominio[.]com`, D-017). Los registros no llevan asuntos, remitentes ni contenido.

## Adjuntos y ClamAV (M2)

Cuando el worker analiza un `.eml`, saca sus adjuntos **en memoria** (mailparser ya decodificó el base64), calcula su SHA-256, mira sus primeros bytes para saber qué son y los manda a ClamAV uno por uno. **Los bytes de los adjuntos no se guardan en ningún lado**: en la base quedan solo los metadatos (tabla `attachments`). Nada se ejecuta ni se descomprime: un `.zip` se escanea y se registra como un solo archivo (D-018).

- **Estados** (`scanStatus`): `not_detected` (ClamAV respondió OK; no quiere decir "seguro"), `detected` (`scanDetail` = nombre de la firma; el reporte sube a prioridad `high`), `unsupported` (vacío, mayor que `CLAMAV_MAX_SCAN_BYTES` o más allá de los primeros `MAX_ATTACHMENTS_SCANNED`) y `error` (ClamAV caído, sin respuesta, tiempo agotado o respuesta rara). **Un `error` nunca se trata como limpio**, y el reporte sigue `completed`.
- **Topes:** se registran hasta 50 adjuntos por reporte y se escanean los primeros 20. Cada escaneo tiene `CLAMAV_TIMEOUT_MS` y todos juntos `CLAMAV_TOTAL_BUDGET_MS`; lo que no alcance queda `error` ("tiempo de escaneo agotado").
- **Regla R7** (peso provisional 3): doble extensión que esconde un ejecutable (`factura.pdf.exe`), caracteres de dirección de texto en el nombre (U+202E…) o bytes cuya firma contradice la extensión o el tipo declarado. Los contenedores legítimos (`docx`, `xlsx`, `jar`… son ZIP; `doc`, `xls`, `msi` son OLE2) y el `application/octet-stream` genérico no disparan.
- **Nombre del adjunto:** se guarda saneado (controles y caracteres de dirección escritos como `[U+202E]`, URL desactivadas, 255 caracteres). Nunca se usa como ruta ni va a los registros, que solo llevan conteos por estado.
- **Correos que no se leen completos:** si el `.eml` tiene más de 15 niveles de multipart, solo se leen los encabezados: no hay adjuntos y el reporte queda `limited / parse_error`.

**Para el front (Cesar):**

- `GET /reports/{id}/attachments` con un reporte `failed` responde 200 con `items: []`. Eso **no** quiere decir "sin adjuntos": el correo no se pudo leer. Lo mismo puede pasar con `limited`. Mira siempre el `status` del reporte antes de decir "este correo no trae adjuntos".
- `fileName`, `declaredType` y `scanDetail` son texto que viene del correo o de ClamAV: escápalos siempre, nunca los uses en un `href` ni como HTML.
- `error` se muestra como "no se pudo escanear", nunca como limpio; `not_detected` como "ClamAV no detectó nada", no como "seguro".

**ClamAV en el Compose:** servicio `clamav` con la imagen oficial `clamav/clamav:1.5.5`, sin puertos publicados y en una red `clamav-net` que solo comparte con el worker. Necesita **al menos 3 GiB de RAM**, y el primer arranque descarga las firmas (varios minutos; quedan en el volumen `clamav-db`). Mientras carga, los adjuntos salen `error`. El worker no espera a que esté sano: si ClamAV se cae, sigue analizando y marca `error` (P-05).

**Prueba de humo contra un ClamAV real** (opcional; el CI no la corre):

```bash
docker run -d --rm --name cbl-clamav-smoke -e CLAMAV_NO_MILTERD=true -p 127.0.0.1:3310:3310 clamav/clamav:1.5.5
docker logs -f cbl-clamav-smoke        # esperar "clamd started"
CLAMAV_TEST_HOST=127.0.0.1 npx vitest run test/clamav-smoke.test.ts
docker stop cbl-clamav-smoke
```

El archivo de prueba EICAR se arma en memoria al correr la prueba (`test/eicar.ts`); la cadena completa no está en el repositorio.

## Informe y guía de mitigación (M3)

`GET /reports/{id}/report` devuelve un `ReportDocument` armado **solo con texto de plantilla** (D-011): nada se genera al pedirlo, no hay ningún modelo de lenguaje y la misma entrada da el mismo informe. Los textos están en `src/report/guide-texts.ts` con su versión (`guideVersion`, hoy `g1-2026.11`); si cambia un texto, sube la versión. El armado es una función pura (`src/report/build.ts`) y la respuesta se valida contra el contrato antes de salir.

- **Acceso:** el reportante ve el informe de sus reportes (D-014); analista y administrador, el de cualquiera. Ajeno o id mal formado → 404. `queued` o `processing` → 409 `report_not_ready`. `failed` → 200 con la nota `failed` y sin hallazgos, indicadores ni adjuntos (D-004).
- **Contenido:** resumen (`summary`), un hallazgo por fila de `findings` con su guía (qué significa, por qué es riesgoso, qué hacer, qué revisa el analista) y la evidencia ya desactivada, indicadores, adjuntos y notas. **No copia nada del correo:** ni asunto, ni cuerpo, ni encabezados, ni el texto visible de los enlaces.
- **Orden de los hallazgos:** `R8, R6, R7, R2, R3, R4, R5, R1` (lo más grave o accionable primero) y, dentro de una regla, por fecha e id. Una regla sin guía usa un texto genérico y no tumba el informe.
- **Indicadores** (máximo 25, sin repetidos): el remitente (`usuario[@]dominio[.]com`), cada dominio o IP distinto de los enlaces (`dominio[.]com`) y el SHA-256 de cada adjunto. Que algo aparezca ahí **no** quiere decir que sea malicioso: son los elementos del correo que sirven para buscar.
- **Registros:** la ruta solo registra id, estado y conteos; nunca textos del informe, nombres de archivo ni indicadores (P-18).

**Para el front (Cesar):**

- `fileName`, la evidencia y los indicadores son texto hostil: escápalos siempre y nunca los pongas en un `href`, en `innerHTML` ni en una plantilla. Ya vienen desactivados (`hxxp://`, `[.]`, `[@]`); no los "reactives".
- No pongas ningún botón que abra un enlace, visite un dominio o ejecute o descargue un adjunto. El informe es para leer.
- Muestra los hallazgos en el orden en que llegan. R8 (coincide con un indicador confirmado) solo aparecerá desde M5.
- **Notas** (`notes`), en este orden: `failed` (el análisis no terminó), `limited` (análisis limitado, con el motivo), `no_findings` (sin hallazgos no significa seguro) y `auth_informative` (SPF, DKIM y DMARC solo como información; nunca cambian la prioridad). Muéstralas todas.
- Un reporte `limited` o `failed`, o un adjunto en `error` o `unsupported`, **nunca** se muestra como "seguro" ni como "limpio". Un adjunto `detected` ya cambia el encabezado del resumen.
- El texto de la sección de indicadores (por ejemplo "estos elementos sirven para buscar; no son prueba de nada") lo pone el front.

### Limpieza programada

El worker limpia al arrancar y cada `CLEANUP_INTERVAL_MIN` minutos (60 por defecto):

- reportes vencidos (7 días, D-012): fila y carpeta;
- sesiones vencidas por tiempo absoluto (8 h) o por inactividad (30 min) (D-034);
- carpetas del volumen sin reporte (D-038), solo si su nombre es un UUID y tienen más de una hora. El margen existe porque la subida guarda el archivo antes de crear la fila.

Con varios workers, un candado de PostgreSQL (`pg_try_advisory_xact_lock`) hace que solo uno limpie a la vez. Cada vuelta deja en la auditoría `system.cleanup` con los conteos.

## Pila completa con el front

El front (repo de Cesar) se construye desde una carpeta al lado de esta (D-031):

```text
correobajolupa/
├── correobajolupa-api/   ← este repo
└── correobajolupa-web/   ← front (o define WEB_REPO_DIR en el .env)
```

```bash
# En el .env: TRUST_PROXY_HOPS=1 (ver abajo)
docker compose --profile web up -d --build
# Front: http://127.0.0.1:8080   (WEB_PORT para cambiarlo); la API sigue en 127.0.0.1:3000
```

nginx sirve la aplicación y reenvía `/api/*` a la API (mismo origen, sin CORS). Sin el perfil `web`, el Compose no necesita el repo del front.

**Por qué `TRUST_PROXY_HOPS=1` y nunca `true`.** Con nginx delante, la API recibe todas las conexiones desde nginx; la IP real viene en `X-Forwarded-For`. nginx agrega al final de esa cabecera la IP que ve, pero deja lo que el cliente haya escrito antes. Con `1`, Express toma solo el último valor (el que puso nginx). Con `true` confiaría en toda la cadena, y cualquiera podría escribir otra IP en `X-Forwarded-For` y saltarse los límites por IP (D-052). Sin el perfil `web`, déjalo en 0.

**Windows y finales de línea.** Si Git convierte el repo del front a CRLF (`core.autocrlf=true`), el contenedor `web` no arranca (`exec /usr/local/bin/cbl-entrypoint.sh: no such file or directory`), porque el script queda con `#!/bin/sh` seguido de un retorno de carro. Mientras el repo del front no fije LF en `.gitattributes`, clónalo con `git clone -c core.autocrlf=false …`.

### Variables de M1

| Variable | Por defecto | Para qué |
| --- | --- | --- |
| `MAX_EML_BYTES` / `MAX_PASTE_BYTES` | 10 MiB / 1 MiB | Tamaño máximo de un `.eml` y de un texto pegado |
| `REPORTS_PER_USER_PER_HOUR` | 30 | Cuota de reportes por cuenta |
| `INSTITUTIONAL_DOMAINS` | (vacío) | Dominios institucionales para la regla 3, separados por comas |
| `WORKER_POLL_MS` / `JOB_LEASE_SECONDS` / `JOB_MAX_ATTEMPTS` | 1000 / 120 / 3 | Cola del worker |
| `CLEANUP_INTERVAL_MIN` | 60 | Limpieza programada |
| `TRUST_PROXY_HOPS` | 0 | Saltos de proxy de confianza (1 con el perfil `web`) |
| `WEB_PORT` / `WEB_REPO_DIR` | 8080 / `../correobajolupa-web` | Front con el perfil `web` |

`STORAGE_DIR` es fija en el Compose (`/data/reports`, volumen `reports-data`).

### Variables de M2 (solo el worker)

| Variable | Por defecto | Para qué |
| --- | --- | --- |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `clamav` / 3310 | Dónde está clamd (fijas en el Compose) |
| `CLAMAV_TIMEOUT_MS` | 10000 | Tiempo máximo de un escaneo |
| `CLAMAV_TOTAL_BUDGET_MS` | 20000 | Tiempo máximo de todos los escaneos de un reporte; no puede pasar de `JOB_LEASE_SECONDS * 1000 / 2` |
| `CLAMAV_MAX_SCAN_BYTES` | 10 MiB | Adjuntos más grandes quedan `unsupported` (debe ser ≤ `StreamMaxLength` de clamd, 100 MiB por defecto) |
| `MAX_ATTACHMENTS_SCANNED` | 20 | Cuántos adjuntos se escanean por reporte |

## Base de datos (Prisma 7)

- El modelo está en `prisma/schema.prisma` y las migraciones en `prisma/migrations/` (se versionan).
- La CLI lee la conexión de `DATABASE_URL` mediante `prisma.config.ts`; no carga ningún `.env`.
- El cliente se genera en `src/generated/` (fuera de git). `npm run typecheck` y `npm run build` lo generan solos; también puedes correr `npm run db:generate`.

### Crear una migración nueva

1. Cambia `prisma/schema.prisma` y revisa que sea válido: `npm run db:validate`.
2. Levanta una base desechable y genera la migración contra ella:

   ```bash
   docker compose --profile test up -d --wait db-test
   export DATABASE_URL=postgresql://cbl_test:cbl_test@127.0.0.1:5433/correobajolupa_test
   npx prisma migrate dev --name describe_el_cambio
   ```

3. Lee el `migration.sql` generado antes de commitearlo (si algo no lo modela Prisma, como el `CHECK` del email, se agrega a mano en ese archivo).
4. Corre las pruebas de integración y commitea el esquema junto con su migración. El CI falla si el esquema cambió sin migración.

En la instancia no se usa `migrate dev`: el servicio `migrate` del Compose aplica las migraciones con `migrate deploy`.

## Pruebas de integración

Corren contra un PostgreSQL real. **Vacían la base**, por eso solo aceptan una cuyo nombre termine en `_test`.

```bash
docker compose --profile test up -d --wait db-test     # PostgreSQL efímero en 127.0.0.1:5433
DATABASE_URL=postgresql://cbl_test:cbl_test@127.0.0.1:5433/correobajolupa_test npm run test:int
docker compose --profile test rm -sf db-test            # al terminar
```

En PowerShell: `$env:DATABASE_URL = "postgresql://cbl_test:cbl_test@127.0.0.1:5433/correobajolupa_test"; npm run test:int`.

**La referencia es el CI (Linux).** En Windows, Vitest a veces pierde un proceso de prueba con el código
`0xC0000409` (una caída nativa, intermitente, en archivos distintos; no se reproduce en Linux). Si pasa,
corre la integración dentro de un contenedor Linux:

```bash
npm run test:int:docker                                 # levanta db-test y corre las pruebas en node:24 Linux
docker compose --profile test rm -sf db-test test-int   # al terminar
```

`node_modules` y el cliente de Prisma del contenedor viven en volúmenes propios (`test-node-modules`,
`test-prisma-generated`); los de tu máquina no se tocan.

## Repositorio relacionado

El front vive en un repositorio aparte (`correobajolupa-web`, nombre por confirmar). El despliegue construye ambos juntos con Docker Compose.

## Licencia

Sin licencia: todos los derechos reservados.
