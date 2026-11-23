-- M4: laboratorio IMAP (buzones y mensajes indexados). Solo agrega: no modifica tablas ni datos de M0 a M3.

-- CreateEnum
CREATE TYPE "mailbox_label" AS ENUM ('student', 'teacher', 'staff');

-- CreateEnum
CREATE TYPE "sync_status" AS ENUM ('ok', 'error', 'never');

-- CreateEnum
CREATE TYPE "message_location" AS ENUM ('inbox', 'quarantine');

-- CreateTable
CREATE TABLE "mailboxes" (
    "id" UUID NOT NULL,
    "label" "mailbox_label" NOT NULL,
    "address" VARCHAR(254) NOT NULL,
    "last_sync_at" TIMESTAMPTZ(3),
    "last_sync_status" "sync_status" NOT NULL DEFAULT 'never',
    "sync_started_at" TIMESTAMPTZ(3),

    CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexed_messages" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "location" "message_location" NOT NULL,
    "uid" BIGINT NOT NULL,
    "uid_validity" BIGINT NOT NULL,
    "subject" TEXT,
    "from_address" TEXT,
    "reply_to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "date" TIMESTAMPTZ(3),
    "has_attachments" BOOLEAN NOT NULL,
    "links_count" INTEGER NOT NULL,
    "authentication" JSONB,
    "rules_version" VARCHAR(32) NOT NULL,
    "priority" "report_priority" NOT NULL,
    "rule_ids" "rule_id"[] DEFAULT ARRAY[]::"rule_id"[],
    "indexed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indexed_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexed_message_links" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "display_text" TEXT,
    "normalized_url" TEXT NOT NULL,
    "defanged_url" TEXT NOT NULL,
    "domain" VARCHAR(253),

    CONSTRAINT "indexed_message_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexed_message_attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "file_name" VARCHAR(255),
    "declared_type" VARCHAR(255),
    "detected_type" VARCHAR(64),
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "scan_status" "scan_status" NOT NULL,
    "scan_detail" VARCHAR(200),
    "scanned_at" TIMESTAMPTZ(3),

    CONSTRAINT "indexed_message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_label_key" ON "mailboxes"("label");

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_address_key" ON "mailboxes"("address");

-- CreateIndex
CREATE UNIQUE INDEX "indexed_messages_mailbox_id_dedupe_key_key" ON "indexed_messages"("mailbox_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "indexed_messages_mailbox_id_location_uid_validity_uid_key" ON "indexed_messages"("mailbox_id", "location", "uid_validity", "uid");

-- CreateIndex
CREATE INDEX "indexed_message_links_domain_idx" ON "indexed_message_links"("domain");

-- CreateIndex
CREATE INDEX "indexed_message_links_normalized_url_idx" ON "indexed_message_links"("normalized_url");

-- CreateIndex
CREATE UNIQUE INDEX "indexed_message_links_message_id_position_key" ON "indexed_message_links"("message_id", "position");

-- CreateIndex
CREATE INDEX "indexed_message_attachments_sha256_idx" ON "indexed_message_attachments"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "indexed_message_attachments_message_id_position_key" ON "indexed_message_attachments"("message_id", "position");

-- AddForeignKey
ALTER TABLE "indexed_messages" ADD CONSTRAINT "indexed_messages_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indexed_message_links" ADD CONSTRAINT "indexed_message_links_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "indexed_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indexed_message_attachments" ADD CONSTRAINT "indexed_message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "indexed_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Agregado a mano (Prisma no modela CHECK ni NOT NULL en listas, ni datos iniciales).

-- Listas siempre presentes (vacías si no hay).
ALTER TABLE "indexed_messages" ALTER COLUMN "reply_to" SET NOT NULL;
ALTER TABLE "indexed_messages" ALTER COLUMN "rule_ids" SET NOT NULL;

-- UID y UIDVALIDITY: enteros de 32 bits sin signo, nunca 0 (RFC 3501).
ALTER TABLE "indexed_messages" ADD CONSTRAINT "indexed_messages_uid_check" CHECK ("uid" > 0 AND "uid" <= 4294967295);
ALTER TABLE "indexed_messages" ADD CONSTRAINT "indexed_messages_uid_validity_check" CHECK ("uid_validity" > 0 AND "uid_validity" <= 4294967295);
ALTER TABLE "indexed_messages" ADD CONSTRAINT "indexed_messages_dedupe_key_check" CHECK (length("dedupe_key") BETWEEN 1 AND 1000);
ALTER TABLE "indexed_messages" ADD CONSTRAINT "indexed_messages_links_count_check" CHECK ("links_count" >= 0);
ALTER TABLE "indexed_message_links" ADD CONSTRAINT "indexed_message_links_position_check" CHECK ("position" >= 0);
ALTER TABLE "indexed_message_attachments" ADD CONSTRAINT "indexed_message_attachments_position_check" CHECK ("position" >= 0);
ALTER TABLE "indexed_message_attachments" ADD CONSTRAINT "indexed_message_attachments_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "indexed_message_attachments" ADD CONSTRAINT "indexed_message_attachments_size_bytes_check" CHECK ("size_bytes" >= 0);
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_address_lowercase_check" CHECK ("address" = lower("address"));

-- Los 3 buzones del laboratorio (D-015). Idempotente.
INSERT INTO "mailboxes" ("id", "label", "address") VALUES
    (gen_random_uuid(), 'student', 'student@lab.example'),
    (gen_random_uuid(), 'teacher', 'teacher@lab.example'),
    (gen_random_uuid(), 'staff', 'staff@lab.example')
ON CONFLICT DO NOTHING;
