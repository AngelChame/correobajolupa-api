# CorreoBajoLupa — API

Backend, trabajador de análisis, infraestructura (Docker Compose, servidor IMAP de laboratorio) y contrato OpenAPI de **CorreoBajoLupa**: una plataforma web con API REST que analiza correos sospechosos con reglas explicables, relaciona mensajes de una misma campaña y entrega un informe con guía de mitigación. En un laboratorio IMAP controlado permite buscar mensajes relacionados y ponerlos en cuarentena de forma autorizada y reversible.

> **Estado:** en desarrollo (M0: cimientos). Ya hay contrato OpenAPI v0, el modelo de datos inicial con Prisma, las cuentas (`/api/v1/auth/*`), la administración de usuarios (`/api/v1/users`), cabeceras de seguridad y límites de peticiones. Proyecto académico de Seguridad Informática (Universidad Politécnica de Chiapas).

## Datos y seguridad

- El proyecto trabaja con correos de phishing. En este repositorio solo hay datos **sintéticos o anonimizados**; nunca se suben correos reales, contraseñas, llaves ni archivos `.env`.
- Los enlaces de los correos nunca se visitan; en informes se muestran desactivados.

## Requisitos

- Node.js 24 (LTS) y npm. La versión está en `.nvmrc`.
- Docker y Docker Compose.

## Cómo levantarlo

```bash
cp .env.example .env          # cambia las contraseñas de ejemplo
docker compose up -d --build  # PostgreSQL, migraciones y la API
curl http://127.0.0.1:3000/api/v1/health   # {"status":"ok"}
```

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
- Una ruta puede sobrescribir esas cabeceras a propósito (la última escritura gana): así pondrá su propia CSP el visor del HTML del correo en M1 (D-035).
- Sin CORS: el front y la API comparten origen (D-031).
- Límite global: `RATE_LIMIT_GLOBAL_PER_MINUTE` peticiones por minuto por IP en `/api/v1` (300 por defecto), salvo `/health`.

Compromisos conocidos de esta etapa (M0):

- El 409 `email_taken` revela que un correo ya tiene cuenta (lo pide el contrato); el límite por IP lo frena.
- Con 5 fallos por correo, alguien puede bloquear 15 min la entrada de una cuenta concreta.
- Los contadores de los límites viven en memoria: se reinician al reiniciar la API (D-054 dejó fuera Redis; si hiciera falta compartirlos, por decidir dónde).
- **`trust proxy` está apagado** hasta que exista el proxy inverso (decisión nº 28). Sin proxy, dentro del Compose la API ve la IP del puente de Docker, así que los límites por IP (también el global) los comparten todas las personas. Al poner el proxy hay que activar `trust proxy` con el número exacto de saltos y revisar los límites.

Prueba rápida con `curl` (la pila levantada):

```bash
curl -s -c cookies.txt -H 'Content-Type: application/json'   -d '{"email":"ana@ejemplo.invalid","password":"una-clave-larga-123","displayName":"Ana"}'   http://127.0.0.1:3000/api/v1/auth/register        # guarda el csrfToken de la respuesta
curl -s -b cookies.txt http://127.0.0.1:3000/api/v1/auth/me
curl -s -b cookies.txt -X POST -H "X-CSRF-Token: <csrfToken>" http://127.0.0.1:3000/api/v1/auth/logout
```

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

## Repositorio relacionado

El front vive en un repositorio aparte (`correobajolupa-web`, nombre por confirmar). El despliegue construye ambos juntos con Docker Compose.

## Licencia

Sin licencia: todos los derechos reservados.
