-- The file retainer ledger (MVP-147, D-176).
-- CreateEnum
CREATE TYPE "RetainerEntryKind" AS ENUM ('DEPOSIT', 'INVOICE_PAYMENT');

-- AlterEnum
ALTER TYPE "InvoicePaymentMethod" ADD VALUE IF NOT EXISTS 'RETAINER';

-- AlterEnum
ALTER TYPE "TimelineEventType" ADD VALUE IF NOT EXISTS 'RETAINER_DEPOSITED';

-- AlterTable
ALTER TABLE "legal_files" ALTER COLUMN "retainer_balance" SET DATA TYPE DECIMAL(14,3);

-- CreateTable
CREATE TABLE "retainer_entries" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" "RetainerEntryKind" NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "method" "InvoicePaymentMethod",
    "reference" TEXT,
    "invoice_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retainer_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "retainer_entries_office_id_file_id_paid_at_idx" ON "retainer_entries"("office_id", "file_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "retainer_entries_invoice_id_office_id_key" ON "retainer_entries"("invoice_id", "office_id");

-- AddForeignKey
ALTER TABLE "retainer_entries" ADD CONSTRAINT "retainer_entries_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retainer_entries" ADD CONSTRAINT "retainer_entries_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "retainer_entries" ADD CONSTRAINT "retainer_entries_invoice_id_office_id_fkey" FOREIGN KEY ("invoice_id", "office_id") REFERENCES "invoices"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "retainer_entries" ADD CONSTRAINT "retainer_entries_created_by_id_office_id_fkey" FOREIGN KEY ("created_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- A deposit adds, an invoice payment subtracts and names its invoice; the method is the deposit's, or RETAINER.
-- (Compared as text: a new enum value cannot be used in the transaction that adds it.)
ALTER TABLE "retainer_entries"
  ADD CONSTRAINT "retainer_entries_sign_check" CHECK (
    ("kind" = 'DEPOSIT' AND "amount" > 0 AND "invoice_id" IS NULL AND "method"::text IS DISTINCT FROM 'RETAINER')
    OR ("kind" = 'INVOICE_PAYMENT' AND "amount" < 0 AND "invoice_id" IS NOT NULL AND "method"::text = 'RETAINER')
  ),
  ADD CONSTRAINT "retainer_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- The balance is the ledger's sum and can never go below zero: the backstop against two payments racing (D-176).
ALTER TABLE "legal_files" ADD CONSTRAINT "legal_files_retainer_balance_check" CHECK ("retainer_balance" >= 0);

-- Append-only: a mistaken deposit is corrected by a new entry, never edited or removed by the app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "retainer_entries" FROM nexlegtiq_app;
  END IF;
END
$$;
