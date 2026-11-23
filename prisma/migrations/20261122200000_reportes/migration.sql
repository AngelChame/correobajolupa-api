-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('queued', 'processing', 'completed', 'limited', 'failed');

-- CreateEnum
CREATE TYPE "report_source" AS ENUM ('eml', 'paste');

-- CreateEnum
CREATE TYPE "report_priority" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "limited_reason" AS ENUM ('missing_headers', 'parse_error');

-- CreateEnum
CREATE TYPE "rule_id" AS ENUM ('R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8');

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "report_status" NOT NULL DEFAULT 'queued',
    "source" "report_source" NOT NULL,
    "subject" TEXT,
    "from_address" TEXT,
    "priority" "report_priority",
    "limited_reason" "limited_reason",
    "rules_version" VARCHAR(32),
    "analyzed_at" TIMESTAMPTZ(3),
    "has_html" BOOLEAN NOT NULL DEFAULT false,
    "authentication" JSONB,
    "storage_key" VARCHAR(128) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL DEFAULT (transaction_timestamp() + '7 days'::interval),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_error_code" VARCHAR(64),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "rule_id" "rule_id" NOT NULL,
    "rule_name" VARCHAR(120) NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "rules_version" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_links" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "display_text" TEXT,
    "normalized_url" TEXT NOT NULL,
    "defanged_url" TEXT NOT NULL,
    "domain" VARCHAR(253),

    CONSTRAINT "report_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_status_locked_until_idx" ON "reports"("status", "locked_until");

-- CreateIndex
CREATE INDEX "reports_user_id_created_at_idx" ON "reports"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "reports_expires_at_idx" ON "reports"("expires_at");

-- CreateIndex
CREATE INDEX "findings_report_id_idx" ON "findings"("report_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_links_report_id_position_key" ON "report_links"("report_id", "position");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_links" ADD CONSTRAINT "report_links_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Agregado a mano (Prisma no modela CHECK ni triggers).

-- D-004: "limited" siempre dice por qué, y solo "limited" lleva motivo.
ALTER TABLE "reports" ADD CONSTRAINT "reports_limited_reason_check"
  CHECK (("status" = 'limited') = ("limited_reason" IS NOT NULL));
-- SHA-256 en hexadecimal en minúsculas; tamaño y reintentos nunca negativos.
ALTER TABLE "reports" ADD CONSTRAINT "reports_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "reports" ADD CONSTRAINT "reports_size_bytes_check" CHECK ("size_bytes" >= 0);
ALTER TABLE "reports" ADD CONSTRAINT "reports_attempts_check" CHECK ("attempts" >= 0);
-- Posición de los enlaces desde 0; la evidencia de un hallazgo es siempre una lista.
ALTER TABLE "report_links" ADD CONSTRAINT "report_links_position_check" CHECK ("position" >= 0);
ALTER TABLE "findings" ADD CONSTRAINT "findings_evidence_array_check" CHECK (jsonb_typeof("evidence") = 'array');

-- Los hallazgos nunca se sobrescriben: se rechaza cualquier UPDATE. El DELETE sí se permite
-- para que el borrado del reporte (cascada, retención de 7 días) se lleve sus hallazgos.
CREATE FUNCTION "findings_reject_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'los hallazgos son solo de inserción';
END;
$$;

CREATE TRIGGER "findings_no_update"
  BEFORE UPDATE ON "findings"
  FOR EACH ROW EXECUTE FUNCTION "findings_reject_update"();
