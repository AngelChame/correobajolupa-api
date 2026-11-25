-- Nueva tabla independiente de reportes y hallazgos: no modifica datos existentes.
ALTER TABLE "reports" ADD COLUMN "feed_unavailable" JSONB;

CREATE TABLE "feed_sources" (
  "source" VARCHAR(20) NOT NULL PRIMARY KEY,
  "last_good_at" TIMESTAMPTZ(3),
  "last_error_at" TIMESTAMPTZ(3)
);

CREATE TABLE "feed_entries" (
  "source" VARCHAR(20) NOT NULL,
  "url_hash" CHAR(64) NOT NULL,
  "host_hash" CHAR(64) NOT NULL,
  "has_query" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "feed_entries_pkey" PRIMARY KEY ("source", "url_hash"),
  CONSTRAINT "feed_entries_source_fkey" FOREIGN KEY ("source")
    REFERENCES "feed_sources"("source") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "feed_entries_host_hash_idx" ON "feed_entries"("host_hash");
