-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PAID', 'OVERDUE', 'VOID');

-- CreateEnum
CREATE TYPE "InvoicePaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CARD', 'OTHER');

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "file_id" UUID,
    "invoice_number" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "issue_date" DATE,
    "due_date" DATE,
    "subtotal" DECIMAL(14,3) NOT NULL,
    "tax_rate_percent" DECIMAL(5,2) NOT NULL,
    "tax_amount" DECIMAL(14,3) NOT NULL,
    "total" DECIMAL(14,3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "payment_method" "InvoicePaymentMethod",
    "payment_reference" TEXT,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "file_id" UUID,
    "time_entry_id" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(8,2) NOT NULL,
    "unit_price" DECIMAL(14,3) NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_number_sequences" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoices_office_id_created_at_idx" ON "invoices"("office_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "invoices_office_id_client_id_idx" ON "invoices"("office_id", "client_id");

-- CreateIndex
CREATE INDEX "invoices_office_id_file_id_idx" ON "invoices"("office_id", "file_id");

-- CreateIndex
CREATE INDEX "invoices_office_id_status_due_date_idx" ON "invoices"("office_id", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_id_office_id_key" ON "invoices"("id", "office_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_office_id_invoice_number_key" ON "invoices"("office_id", "invoice_number");

-- CreateIndex
CREATE INDEX "invoice_line_items_office_id_invoice_id_position_idx" ON "invoice_line_items"("office_id", "invoice_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_number_sequences_office_id_year_key" ON "invoice_number_sequences"("office_id", "year");

-- CreateIndex
CREATE INDEX "time_entries_office_id_invoice_id_idx" ON "time_entries"("office_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_invoice_id_office_id_fkey" FOREIGN KEY ("invoice_id", "office_id") REFERENCES "invoices"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_office_id_fkey" FOREIGN KEY ("client_id", "office_id") REFERENCES "clients"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_id_office_id_fkey" FOREIGN KEY ("created_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_office_id_fkey" FOREIGN KEY ("invoice_id", "office_id") REFERENCES "invoices"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoice_number_sequences" ADD CONSTRAINT "invoice_number_sequences_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Raw SQL Prisma cannot express ──────────────────────────────────────────────────────────────────────────────

-- D-162: amounts are never negative; the tax rate is a percentage; currency is an ISO-4217 code.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts_check" CHECK ("subtotal" >= 0 AND "tax_amount" >= 0 AND "total" >= 0 AND "tax_rate_percent" BETWEEN 0 AND 100);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
-- The number and the issue date are set exactly when the invoice has left DRAFT; paid_at exactly while PAID.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_number_check" CHECK (("status" = 'DRAFT') = ("invoice_number" IS NULL) AND ("status" = 'DRAFT') = ("issue_date" IS NULL));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_check" CHECK (("status" = 'PAID') = ("paid_at" IS NOT NULL));
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_amounts_check" CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "amount" >= 0);
ALTER TABLE "invoice_number_sequences" ADD CONSTRAINT "invoice_number_sequences_value_check" CHECK ("last_value" >= 0);
