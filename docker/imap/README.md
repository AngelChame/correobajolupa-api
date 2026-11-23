# IMAP del laboratorio (M4)

Servidor IMAP de laboratorio de CorreoBajoLupa (D-043): **Dovecot** en su propio contenedor del Compose, con tres buzones **sintéticos** (D-015). Sobre él se harán la entrega simulada (`APPEND` con UIDPLUS, D-006) y la cuarentena con `UID MOVE` (D-008) en los pasos siguientes de M4 y en M7. Ningún buzón real se toca.

## Qué hay

| | |
| --- | --- |
| Imagen base | `ubuntu:22.04` fijada por digest (`sha256:f64b2ffc…21c0e6`, publicada el 17 nov 2026) |
| Dovecot | `dovecot-core` y `dovecot-imapd` **`1:2.3.16+dfsg1-3ubuntu2.9`** (`dovecot --version`: `2.3.16 (7e2e900c1a)`), la misma versión de la prueba del 13 nov. No se fijan en apt: Ubuntu retira las versiones viejas al publicar parches y la construcción se rompería. Al reconstruir, revisa `dpkg-query -W dovecot-core dovecot-imapd` y actualiza esta línea |
| Usuarios | `student@lab.example`, `teacher@lab.example` y `staff@lab.example` (dominio reservado `.example`, distinto de `INSTITUTIONAL_DOMAINS`) |
| Carpetas | `INBOX` y `Cuarentena`, creadas y suscritas solas para cada usuario |
| Buzones | Maildir en el volumen `imap-data` (`/var/vmail/lab.example/<usuario>/Maildir`): mensajes y UIDVALIDITY sobreviven a un reinicio |
| Red | `imap-net`, interna (sin salida a internet). Solo la API, el worker y el servicio de prueba `test-imap` están en ella |
| Puertos | 143 dentro de `imap-net`. **Ningún puerto se publica al host** |

Archivos: `Dockerfile`, `dovecot.conf` (configuración completa, sin `conf.d`), `arranque.sh` (arma los usuarios y arranca Dovecot) y `salud.sh` (healthcheck).

## Contraseña

Una sola para los tres buzones: `IMAP_LAB_PASSWORD` del `.env`, de **16 caracteres o más**. Sin ella, o si es más corta, el contenedor `imap` sale con error y no arranca; el resto de la pila sigue funcionando. Al arrancar, `arranque.sh` la convierte en hash con `doveadm pw -s SHA512-CRYPT` (sal aleatoria), escribe el archivo de usuarios en memoria (`/run/dovecot-lab/users`, permisos 600, nunca en el volumen ni en el repo) y la borra de su entorno antes de ceder el proceso a Dovecot. Nunca se imprime: ni el script ni Dovecot la registran (`auth_debug_passwords = no`).

Límite conocido: como todos los secretos del Compose, la variable queda en la configuración del contenedor (`docker inspect`). Quien puede usar Docker en la máquina ya puede leerla; es lo mismo que pasa con `POSTGRES_PASSWORD`.

## Seguridad del contenedor

- Todo corre como `vmail` (uid 5000), sin root: los procesos de login no hacen `chroot` (requeriría root).
- `read_only: true`, `cap_drop: [ALL]` y `no-new-privileges`. Solo escribe en el volumen y en tres carpetas en memoria (`tmpfs`).
- Sin SSH ni otros servicios: solo IMAP.
- **Texto plano consciente:** `ssl = no` y `disable_plaintext_auth = no` porque el 143 solo existe dentro de la red interna `imap-net` de Docker, el tráfico nunca sale de la máquina y así no hay que manejar certificados del laboratorio (el HTTPS público es otro tema, nº 28).

## Cómo levantarlo

Va con la pila normal (no tiene perfil):

```bash
# En el .env: IMAP_LAB_PASSWORD con 16 caracteres o más
docker compose up -d --build
docker compose ps imap            # debe decir (healthy)
docker compose logs imap          # "usuarios del laboratorio listos" y el arranque de Dovecot
```

La API y el worker están en `imap-net`, pero **no dependen** de `imap` (sin `depends_on`): el modo real no puede depender del laboratorio (D-003). Si la contraseña falta o es corta, solo `imap` se niega a arrancar (y `restart: unless-stopped` lo reintenta); la API, el worker y ClamAV arrancan igual, y las rutas del laboratorio responderán 503 mientras el IMAP no esté.

**Healthcheck** (`salud.sh`): Dovecot responde `* OK` en el 143 y `doveadm user student@lab.example` encuentra al usuario. No usa la contraseña.

## Sembrar los buzones

Los buzones arrancan vacíos. Para cargar los 21 mensajes sintéticos del laboratorio (`test/fixtures/lab/`, detalle en `test/fixtures/README.md`):

```bash
npm run lab:seed     # servicio lab-seed, perfil tools, dentro de imap-net
```

Imprime solo conteos, por ejemplo `student@lab.example: insertados 7, saltados 0`. Es **idempotente**: antes de insertar busca el `Message-ID` en `INBOX` y en `Cuarentena`, así que una segunda corrida dice `insertados 0, saltados 7` y nunca duplica. Cada mensaje entra a `INBOX` con `APPEND` y su fecha interna es la del encabezado `Date`. El script (`src/lab/seed.ts`) valida el manifiesto y que cada `.eml` exista antes de conectarse; se niega sin `IMAP_LAB_PASSWORD` o si el destino no es `IMAP_LAB_HOST`. El repo se monta de solo lectura en el contenedor.

| Buzón | Mensajes (7 cada uno) |
| --- | --- |
| `student@lab.example` | A1, B3, C1, D3, LA1, LB1, LD1 |
| `teacher@lab.example` | A2, B1, D1, LA2, LB2, LC1, LD2 |
| `staff@lab.example` | A3, B2, C2, D2, LA3, LC2, LD3 |

Para empezar de cero: `docker compose down` y borrar el volumen `imap-data` (`docker volume rm correobajolupa_imap-data`); al volver a levantar, sembrar de nuevo.

## Pruebas de humo

`test/imap-smoke.test.ts` corre contra el Dovecot real: los tres usuarios entran, una contraseña incorrecta no, el servidor anuncia UIDPLUS y MOVE **después** de autenticarse (antes del login Dovecot 2.3 no los anuncia, como ya se vio el 13 nov), `APPEND` devuelve UID y UIDVALIDITY, el mensaje se lee igual byte a byte por UID y `UID MOVE` lo pasa a `Cuarentena`. Al final lo borra.

`test/lab-seed-smoke.test.ts` siembra dos veces: cada mensaje queda una sola vez (7 por buzón) y la segunda corrida inserta 0. Deja los buzones sembrados.

`test/mail-imap-smoke.test.ts` prueba el proveedor de correo (`src/mail/imap.ts`): lista `INBOX` de un buzón sembrado con UIDVALIDITY estable, baja un mensaje igual byte a byte al `.eml`, devuelve `null` si pasa del tope y hace `append` con UID y UIDVALIDITY coherentes (con un `Message-ID` único que borra al terminar).

Como el 143 no se publica, las tres se corren **dentro de `imap-net`** con el servicio `test-imap` (perfil `test`), un archivo a la vez:

```bash
npm run test:imap:docker
```

Sin `IMAP_LAB_SMOKE=1` (por ejemplo en `npm test` y en el CI) se saltan.

## Sincronización de un buzón (`POST /mailboxes/{id}/sync`)

`syncMailbox` (`src/lab/sync.ts`) deja el índice de la base igual a lo que hay en `INBOX` y `Cuarentena` de un buzón. La ruta `POST /mailboxes/{id}/sync` (analista o administrador) la llama con quién y con qué petición, para la auditoría.

**Tablas** (migración `20261124100000_laboratorio`, que además inserta los 3 buzones):

| Tabla | Qué guarda |
| --- | --- |
| `mailboxes` | Etiqueta, dirección, `last_sync_at`, `last_sync_status` (`ok`, `error` o `never`) y el arriendo `sync_started_at` |
| `indexed_messages` | Un mensaje por (buzón, clave de deduplicación): carpeta, UID y UIDVALIDITY (BIGINT, 32 bits sin signo), asunto, remitente, Reply-To, fecha del `Date`, prioridad, reglas que disparó (`rule_ids`), autenticación y versión de reglas |
| `indexed_message_links` | Enlaces como en los reportes: URL normalizada y dominio crudos (para buscar en M5) y la forma desactivada |
| `indexed_message_attachments` | Nombre saneado, tipos, tamaño y SHA-256. **Nunca los bytes.** `scan_status = unsupported` |

**Nada de bytes de correo en la base.** Asunto, remitente, Reply-To y nombres de archivo son texto del correo: se guardan tal cual y el front los escapa.

**Cómo funciona:**

1. **Arriendo** (como la cola, D-054): un `UPDATE … RETURNING` toma `sync_started_at` solo si está libre o tiene más de 60 s. Si no, `SyncInProgressError` (409 `conflict`). La entrega simulada usa el mismo arriendo. Se libera siempre al terminar.
2. **Lista** las dos carpetas con el proveedor de correo (`src/mail/`, D-007), sin bajar cuerpos.
3. **UIDVALIDITY** (D-008): si el de una carpeta cambió, se borran sus filas viejas (esos UID ya no significan nada), se reindexa y el resultado dice `uidValidityChanged: true`.
4. **Clave de deduplicación** (RF-07): el `Message-ID` sin espacios y en minúsculas; si no trae, `sha256:` del crudo (hay que bajarlo para calcularla). Un mensaje que pasa de `INBOX` a `Cuarentena` conserva su clave: se actualizan carpeta y UID en la **misma fila** (`updated`), no se duplica.
5. **Mensajes nuevos:** se bajan con tope `MAX_EML_BYTES` (los más grandes no se indexan y se cuentan), se analizan con el mismo analizador de los reportes y se guardan en una transacción por mensaje (`added`).
6. **Lo que desapareció** del servidor sale del índice.
7. **Topes:** `SYNC_MAX_MESSAGES` (500; primero Cuarentena, luego INBOX del más nuevo al más viejo) y `SYNC_BUDGET_MS` (45 s). Si se acaba el tiempo, lo ya indexado se queda, el estado pasa a `error` y se lanza `SyncTimeoutError` (503). Si Dovecot no responde, rechaza el acceso o falta la contraseña: `MailUnavailableError` (503). Las respuestas de error llevan un mensaje fijo: nada del servidor IMAP, direcciones ni contraseñas. Un buzón que no existe da 404.

**Resultado:** `{ mailboxId, fetched, added, updated, uidValidityChanged, finishedAt }` (como `SyncResult` del contrato). `fetched` cuenta los mensajes que se bajaron del servidor, no los que ya se conocían.

**Adjuntos sin escanear:** la sincronización corre en la API, que no está en `clamav-net`, y no se amplía esa exposición. Por eso quedan `unsupported` con el detalle "No se escanea al sincronizar el laboratorio." (D-018: nunca "limpio"). M5 compara por SHA-256.

**Registros y auditoría (P-18):** solo `mailboxId`, conteos (`fetched`, `added`, `updated`, `deleted`, `ignored`, `tooLarge`) y tiempos. Nunca asuntos, remitentes, direcciones, `Message-ID` ni contenido. Cada corrida deja un evento `mailbox.sync` (`success` o `failure` con `reason`).

**Pruebas:** `test/integration/lab-routes.test.ts` (las 5 rutas de punta a punta), `test/integration/lab-sync.test.ts` (PostgreSQL real con un proveedor en memoria; `npm run test:int:docker`) y `test/mail-imap-smoke.test.ts` (el proveedor IMAP contra el Dovecot real; `npm run test:imap:docker`).

## Entrega simulada (`POST /mailboxes/{id}/simulated-delivery`)

**Es una simulación local:** copia un correo a un buzón del Dovecot del laboratorio con IMAP `APPEND`. No envía correo a ningún sitio externo, no resuelve ningún dominio y no visita enlaces (D-017).

- **Entrada:** `{ reportId }` de un reporte subido como `.eml` (un reporte pegado da 400). El original se lee **del almacenamiento del reporte** (D-038), nunca se recibe del cliente. Reporte, archivo o buzón inexistente: 404.
- **Qué hace:** `APPEND` a INBOX con la fecha del `Date` del correo; el UID y el UIDVALIDITY salen de la respuesta del servidor (UIDPLUS, D-006): si no los da, 503 en vez de adivinar. Luego indexa ese mensaje con el mismo `indexMessage` de la sincronización (mismas reglas, adjuntos `unsupported`) y responde 201 con el `MessageSummary`.
- **Idempotente:** si el buzón ya tiene indexado un mensaje con la misma clave de deduplicación, no hay otro `APPEND` y responde el existente (201). Una sincronización posterior lo reconoce y no cambia nada.
- **Arriendo:** no corre a la vez que una sincronización del mismo buzón (409).
- **Auditoría:** `mailbox.simulated_delivery` con `reportId` y `appended` (1 o 0), o `reason` si falló. Registros solo con IDs.

## Comprobaciones manuales (23 nov 2026)

- `docker compose restart imap`: el mensaje sigue y el UIDVALIDITY es el mismo.
- `docker compose port imap 143`: no hay puerto en el host (`:0`).
- Memoria en reposo: unos 4 MiB (`docker stats --no-stream`). Imagen: unos 192 MB.

## Pendiente

- **ACL de `Cuarentena` (decisión abierta nº 2):** en este paso la carpeta es una carpeta normal del usuario. La restricción para que el dueño del buzón no pueda sacar mensajes de ella llega en **M7**.
