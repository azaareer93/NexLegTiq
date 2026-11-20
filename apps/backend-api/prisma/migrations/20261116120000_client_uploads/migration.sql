-- MVP-99 (D-187): client uploads wait here for a lawyer's review; accepting creates the Document.
-- CreateEnum
CREATE TYPE "ClientUploadStatus" AS ENUM ('SCANNING', 'PENDING_REVIEW', 'ACCEPTED', 'REJECTED', 'QUARANTINED', 'FAILED');

-- CreateTable
CREATE TABLE "client_uploads" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "client_user_id" UUID NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "status" "ClientUploadStatus" NOT NULL DEFAULT 'SCANNING',
    "rejection_reason" TEXT,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "document_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "client_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_uploads_storage_key_key" ON "client_uploads"("storage_key");

-- CreateIndex
CREATE INDEX "client_uploads_office_id_file_id_status_idx" ON "client_uploads"("office_id", "file_id", "status");

-- CreateIndex
CREATE INDEX "client_uploads_office_id_client_id_idx" ON "client_uploads"("office_id", "client_id");

-- CreateIndex
CREATE INDEX "client_uploads_client_user_id_idx" ON "client_uploads"("client_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_uploads_document_id_office_id_key" ON "client_uploads"("document_id", "office_id");

-- AddForeignKey
ALTER TABLE "client_uploads" ADD CONSTRAINT "client_uploads_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_uploads" ADD CONSTRAINT "client_uploads_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_uploads" ADD CONSTRAINT "client_uploads_client_id_office_id_fkey" FOREIGN KEY ("client_id", "office_id") REFERENCES "clients"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_uploads" ADD CONSTRAINT "client_uploads_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_uploads" ADD CONSTRAINT "client_uploads_reviewed_by_id_office_id_fkey" FOREIGN KEY ("reviewed_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "client_uploads" ADD CONSTRAINT "client_uploads_document_id_office_id_fkey" FOREIGN KEY ("document_id", "office_id") REFERENCES "documents"("id", "office_id") ON DELETE SET NULL ("document_id") ON UPDATE RESTRICT;


-- Integrity as for documents (D-119): keys inside the office's prefix, lower-case hex checksums.
ALTER TABLE "client_uploads" ADD CONSTRAINT "client_uploads_storage_key_check" CHECK (starts_with("storage_key", "office_id"::text || '/'));
ALTER TABLE "client_uploads" ADD CONSTRAINT "client_uploads_checksum_check" CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$');
-- A reason exactly when rejected; an accepted upload names its document (until a purge removes it).
ALTER TABLE "client_uploads" ADD CONSTRAINT "client_uploads_rejection_check" CHECK (("status" = 'REJECTED') = ("rejection_reason" IS NOT NULL));
ALTER TABLE "client_uploads" ADD CONSTRAINT "client_uploads_review_check" CHECK ("status" NOT IN ('ACCEPTED', 'REJECTED') OR ("reviewed_by_id" IS NOT NULL AND "reviewed_at" IS NOT NULL));
