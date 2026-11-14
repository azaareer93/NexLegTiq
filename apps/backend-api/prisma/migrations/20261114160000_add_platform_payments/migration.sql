-- Manual payments to the platform and their receipt numbers (MVP-170, D-174).
-- CreateEnum
CREATE TYPE "PlatformPaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'OTHER');

-- CreateTable
CREATE TABLE "platform_payments" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method" "PlatformPaymentMethod" NOT NULL,
    "reference" TEXT,
    "paid_at" DATE NOT NULL,
    "recorded_by_id" UUID NOT NULL,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_id" UUID,
    "void_reason" TEXT,
    "pdf_storage_key" TEXT,
    "pdf_language" "OfficeLanguage",
    "pdf_rendered_for" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_number_sequences" (
    "id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "receipt_number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_payments_receipt_number_key" ON "platform_payments"("receipt_number");

-- CreateIndex
CREATE INDEX "platform_payments_office_id_paid_at_idx" ON "platform_payments"("office_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_number_sequences_year_key" ON "receipt_number_sequences"("year");

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "platform_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A payment is a positive amount with a well-formed receipt number; void fields go together; the PDF lives under the office.
ALTER TABLE "platform_payments"
  ADD CONSTRAINT "platform_payments_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "platform_payments_receipt_number_check" CHECK ("receipt_number" ~ '^RCT-[0-9]{4}-[0-9]{4,}$'),
  ADD CONSTRAINT "platform_payments_void_check" CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL)),
  ADD CONSTRAINT "platform_payments_pdf_storage_key_check"
    CHECK ("pdf_storage_key" IS NULL OR "pdf_storage_key" LIKE "office_id"::text || '/%');

-- Never deleted (owner 2A): a mistaken payment is voided and keeps its number.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    REVOKE DELETE, TRUNCATE ON "platform_payments" FROM nexlegtiq_app;
  END IF;
END
$$;
