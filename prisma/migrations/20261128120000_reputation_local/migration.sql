-- Preparación local: hashes y cuota compartida. No hay consultas externas en esta migración.
CREATE TABLE "reputation_cache" (
  "url_hash" CHAR(64) NOT NULL PRIMARY KEY,
  "state" VARCHAR(20) NOT NULL,
  "malicious" INTEGER,
  "total" INTEGER,
  "checked_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "reputation_cache_state_check" CHECK (
    "state" IN ('reported', 'suspicious', 'no_detections', 'no_data')
  ),
  CONSTRAINT "reputation_cache_counts_check" CHECK (
    ("state" = 'no_data' AND "malicious" IS NULL AND "total" IS NULL)
    OR ("state" <> 'no_data' AND "malicious" >= 0 AND "total" > 0 AND "malicious" <= "total")
  )
);
CREATE INDEX "reputation_cache_checked_at_idx" ON "reputation_cache"("checked_at");

CREATE TABLE "reputation_quota" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "day_utc" VARCHAR(10) NOT NULL,
  "used" INTEGER NOT NULL DEFAULT 0,
  "next_allowed_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "reputation_quota_single_row_check" CHECK ("id" = 1),
  CONSTRAINT "reputation_quota_used_check" CHECK ("used" >= 0)
);
