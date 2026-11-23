-- M5: indicadores y lista de exclusión. Solo agrega: no modifica tablas ni datos de M0 a M4.
-- CreateEnum
CREATE TYPE "indicator_type" AS ENUM ('domain', 'url', 'sha256', 'sender');

-- CreateEnum
CREATE TYPE "indicator_status" AS ENUM ('proposed', 'confirmed', 'dismissed');

-- CreateTable
CREATE TABLE "indicators" (
    "id" UUID NOT NULL,
    "type" "indicator_type" NOT NULL,
    "value" VARCHAR(2048) NOT NULL,
    "status" "indicator_status" NOT NULL DEFAULT 'proposed',
    "report_id" UUID,
    "proposed_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "indicators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exclusions" (
    "id" UUID NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "reason" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "indicators_proposed_by_id_created_at_idx" ON "indicators"("proposed_by_id", "created_at");

-- CreateIndex
CREATE INDEX "indicators_status_created_at_idx" ON "indicators"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "exclusions_domain_key" ON "exclusions"("domain");

-- AddForeignKey
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exclusions" ADD CONSTRAINT "exclusions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;




-- Agregado a mano (Prisma no modela CHECK ni índices parciales sin una función en vista previa).

-- Un mismo (tipo, valor) solo una vez entre los indicadores no descartados: descartar libera el
-- valor para volver a proponerlo, y el historial de descartados se conserva.
CREATE UNIQUE INDEX "indicators_type_value_active_key" ON "indicators"("type", "value") WHERE "status" <> 'dismissed';

-- Valores normalizados: nunca vacíos; dominio, SHA-256 y remitente en minúsculas (la ruta de una
-- URL distingue mayúsculas, por eso url no); SHA-256 de 64 hexadecimales.
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_value_length_check" CHECK (length("value") BETWEEN 1 AND 2048);
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_value_lowercase_check" CHECK ("type" = 'url' OR "value" = lower("value"));
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_sha256_check" CHECK ("type" <> 'sha256' OR "value" ~ '^[0-9a-f]{64}$');
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_domain_length_check" CHECK ("type" <> 'domain' OR length("value") <= 253);
-- Un indicador propuesto no tiene fecha de decisión; uno decidido, sí.
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_decided_at_check" CHECK (("status" = 'proposed') = ("decided_at" IS NULL));

ALTER TABLE "exclusions" ADD CONSTRAINT "exclusions_domain_check" CHECK (length("domain") BETWEEN 1 AND 253 AND "domain" = lower("domain"));
