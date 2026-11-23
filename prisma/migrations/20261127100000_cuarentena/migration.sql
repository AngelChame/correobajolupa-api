-- M7: acciones de cuarentena y restauración (D-008, D-013). Solo agrega: no modifica tablas ni datos
-- de M0 a M6. Sin clave foránea hacia indexed_messages: la sincronización puede seguir borrando
-- filas cuando cambia el UIDVALIDITY; la acción guarda el mensaje, el buzón y la clave como datos propios.
-- CreateEnum
CREATE TYPE "action_type" AS ENUM ('quarantine', 'restore');

-- CreateEnum
CREATE TYPE "action_status" AS ENUM ('done', 'failed');

-- CreateTable
CREATE TABLE "quarantine_actions" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "type" "action_type" NOT NULL,
    "status" "action_status" NOT NULL,
    "original_location" "message_location" NOT NULL,
    "original_uid" BIGINT NOT NULL,
    "original_uid_validity" BIGINT NOT NULL,
    "new_location" "message_location",
    "new_uid" BIGINT,
    "new_uid_validity" BIGINT,
    "failure_code" VARCHAR(64),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quarantine_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quarantine_actions_incident_id_created_at_idx" ON "quarantine_actions"("incident_id", "created_at");

-- CreateIndex
CREATE INDEX "quarantine_actions_mailbox_id_dedupe_key_idx" ON "quarantine_actions"("mailbox_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "quarantine_actions_incident_id_message_id_type_key" ON "quarantine_actions"("incident_id", "message_id", "type");

-- AddForeignKey
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Agregado a mano (Prisma no modela CHECK).

-- UID y UIDVALIDITY son enteros de 32 bits sin signo y nunca 0 (RFC 3501).
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_original_uid_check" CHECK ("original_uid" BETWEEN 1 AND 4294967295);
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_original_uid_validity_check" CHECK ("original_uid_validity" BETWEEN 1 AND 4294967295);
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_new_uid_check" CHECK ("new_uid" IS NULL OR "new_uid" BETWEEN 1 AND 4294967295);
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_new_uid_validity_check" CHECK ("new_uid_validity" IS NULL OR "new_uid_validity" BETWEEN 1 AND 4294967295);

-- La ubicación nueva va completa o no va.
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_new_location_complete_check" CHECK (
  ("new_location" IS NULL AND "new_uid" IS NULL AND "new_uid_validity" IS NULL)
  OR ("new_location" IS NOT NULL AND "new_uid" IS NOT NULL AND "new_uid_validity" IS NOT NULL)
);

-- Cuarentena: de INBOX a Cuarentena. Restaurar: de Cuarentena a INBOX.
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_direction_check" CHECK (
  ("type" = 'quarantine' AND "original_location" = 'inbox' AND ("new_location" IS NULL OR "new_location" = 'quarantine'))
  OR ("type" = 'restore' AND "original_location" = 'quarantine' AND ("new_location" IS NULL OR "new_location" = 'inbox'))
);

-- done: hay evidencia de dónde quedó y no hay código de fallo. failed: no hay ubicación nueva y sí un código.
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_status_check" CHECK (
  ("status" = 'done' AND "new_location" IS NOT NULL AND "failure_code" IS NULL)
  OR ("status" = 'failed' AND "new_location" IS NULL AND "failure_code" IS NOT NULL)
);

ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_attempts_check" CHECK ("attempts" >= 1);
ALTER TABLE "quarantine_actions" ADD CONSTRAINT "quarantine_actions_updated_at_check" CHECK ("updated_at" >= "created_at");
