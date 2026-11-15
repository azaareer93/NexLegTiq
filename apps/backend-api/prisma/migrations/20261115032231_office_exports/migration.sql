-- CreateEnum
CREATE TYPE "OfficeExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "office_exports" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "status" "OfficeExportStatus" NOT NULL DEFAULT 'QUEUED',
    "storage_key" TEXT,
    "size_bytes" BIGINT,
    "checksum" TEXT,
    "error_code" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "office_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "office_exports_office_id_created_at_idx" ON "office_exports"("office_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "office_exports_id_office_id_key" ON "office_exports"("id", "office_id");

-- AddForeignKey
ALTER TABLE "office_exports" ADD CONSTRAINT "office_exports_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "office_exports" ADD CONSTRAINT "office_exports_requested_by_id_office_id_fkey" FOREIGN KEY ("requested_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

