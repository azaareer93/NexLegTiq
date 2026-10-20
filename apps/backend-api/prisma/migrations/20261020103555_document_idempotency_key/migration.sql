-- D-126: a retried upload with the same Idempotency-Key returns the first document instead of storing a second one.
ALTER TABLE "documents" ADD COLUMN "idempotency_key" TEXT;

-- NULL keys never collide (uploads without the header).
CREATE UNIQUE INDEX "documents_office_id_uploaded_by_id_idempotency_key_key"
  ON "documents" ("office_id", "uploaded_by_id", "idempotency_key");
