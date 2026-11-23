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

## Prueba de humo

`test/imap-smoke.test.ts` corre contra el Dovecot real: los tres usuarios entran, una contraseña incorrecta no, el servidor anuncia UIDPLUS y MOVE **después** de autenticarse (antes del login Dovecot 2.3 no los anuncia, como ya se vio el 13 nov), `APPEND` devuelve UID y UIDVALIDITY, el mensaje se lee igual byte a byte por UID y `UID MOVE` lo pasa a `Cuarentena`. Al final lo borra.

Como el 143 no se publica, la prueba se corre **dentro de `imap-net`** con el servicio `test-imap` (perfil `test`):

```bash
npm run test:imap:docker
```

Sin `IMAP_LAB_SMOKE=1` (por ejemplo en `npm test` y en el CI) la prueba se salta.

## Comprobaciones manuales (23 nov 2026)

- `docker compose restart imap`: el mensaje sigue y el UIDVALIDITY es el mismo.
- `docker compose port imap 143`: no hay puerto en el host (`:0`).
- Memoria en reposo: unos 4 MiB (`docker stats --no-stream`). Imagen: unos 192 MB.

## Pendiente

- **ACL de `Cuarentena` (decisión abierta nº 2):** en este paso la carpeta es una carpeta normal del usuario. La restricción para que el dueño del buzón no pueda sacar mensajes de ella llega en **M7**.
