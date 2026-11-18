# CorreoBajoLupa — API

Backend, trabajador de análisis, infraestructura (Docker Compose, servidor IMAP de laboratorio) y contrato OpenAPI de **CorreoBajoLupa**: una plataforma web con API REST que analiza correos sospechosos con reglas explicables, relaciona mensajes de una misma campaña y entrega un informe con guía de mitigación. En un laboratorio IMAP controlado permite buscar mensajes relacionados y ponerlos en cuarentena de forma autorizada y reversible.

> **Estado:** en desarrollo (M0: cimientos). Ya hay contrato OpenAPI v0, un servidor mínimo con `/api/v1/health` y el modelo de datos inicial (usuarios, sesiones y auditoría) con Prisma. Proyecto académico de Seguridad Informática (Universidad Politécnica de Chiapas).

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
