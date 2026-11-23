# API de CorreoBajoLupa. Node 24 (D-032).
# Versión exacta fijada (D-032); al actualizarla, cambia los dos FROM a la vez.

# Etapas de construcción: dependencias completas (incluye la CLI de Prisma).
# openssl lo necesita el motor de migraciones de Prisma; la imagen final no lo lleva.
FROM node:24.22.3-bookworm-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# Genera el cliente de Prisma en src/generated y compila todo a dist/.
RUN npm run build

# Trabajo de migraciones: corre `prisma migrate deploy` y termina (servicio "migrate" del Compose).
# Es la única imagen con la CLI de Prisma y los archivos de migración.
FROM deps AS migrate
COPY prisma.config.ts ./
COPY prisma ./prisma
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# Imagen final de la API: solo dependencias de producción y el código compilado.
# Sin CLI de Prisma, sin migraciones, sin TypeScript ni herramientas de prueba.
FROM node:24.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=optional: @prisma/client declara la CLI de Prisma como peer opcional (y esta a TypeScript),
# así que npm las marca "devOptional" y --omit=dev solo no las quita. Sin esta opción la imagen
# final llevaría la CLI, el motor de migraciones y tsc. Lo único opcional de producción que se
# pierde es pg-cloudflare, que solo sirve en Cloudflare Workers.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/dist ./dist
# Carpeta del volumen de reportes (D-038), de node y solo para node. Un volumen con nombre nuevo
# copia dueño y permisos de esta carpeta; sin ella Docker la crearía de root y node no podría escribir.
RUN mkdir -p /data/reports && chown node:node /data/reports && chmod 700 /data/reports
# Sin privilegios de root dentro del contenedor.
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server.js"]
