-- M6: incidentes, sus asociaciones con reportes e indicadores y comentarios. Solo agrega: no
-- modifica tablas ni datos de M0 a M5.
-- CreateEnum
CREATE TYPE "incident_status" AS ENUM ('received', 'analyzing', 'contained', 'closed', 'false_positive');

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000),
    "status" "incident_status" NOT NULL DEFAULT 'received',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_reports" (
    "incident_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "added_by_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_reports_pkey" PRIMARY KEY ("incident_id","report_id")
);

-- CreateTable
CREATE TABLE "incident_indicators" (
    "incident_id" UUID NOT NULL,
    "indicator_id" UUID NOT NULL,
    "added_by_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_indicators_pkey" PRIMARY KEY ("incident_id","indicator_id")
);

-- CreateTable
CREATE TABLE "incident_comments" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incidents_status_updated_at_idx" ON "incidents"("status", "updated_at");

-- CreateIndex
CREATE INDEX "incidents_updated_at_idx" ON "incidents"("updated_at");

-- CreateIndex
CREATE INDEX "incident_reports_report_id_idx" ON "incident_reports"("report_id");

-- CreateIndex
CREATE INDEX "incident_indicators_indicator_id_idx" ON "incident_indicators"("indicator_id");

-- CreateIndex
CREATE INDEX "incident_comments_incident_id_created_at_idx" ON "incident_comments"("incident_id", "created_at");

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_indicators" ADD CONSTRAINT "incident_indicators_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_indicators" ADD CONSTRAINT "incident_indicators_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_indicators" ADD CONSTRAINT "incident_indicators_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Agregado a mano (Prisma no modela CHECK ni triggers).

-- Mismas longitudes que el contrato (CreateIncidentBody, UpdateIncidentBody, CreateCommentBody).
-- El título no puede quedar vacío; la descripción puede ser nula o cadena vacía (el contrato no pide mínimo).
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_title_length_check" CHECK (length("title") BETWEEN 1 AND 120);
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_description_length_check" CHECK ("description" IS NULL OR length("description") <= 2000);
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_updated_at_check" CHECK ("updated_at" >= "created_at");
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_body_length_check" CHECK (length("body") BETWEEN 1 AND 2000);

-- Los comentarios no se editan: solo inserción (se borran solo junto con su incidente).
CREATE FUNCTION "incident_comments_reject_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'los comentarios de un incidente son solo de inserción';
END;
$$;

CREATE TRIGGER "incident_comments_no_update"
  BEFORE UPDATE ON "incident_comments"
  FOR EACH ROW EXECUTE FUNCTION "incident_comments_reject_update"();
