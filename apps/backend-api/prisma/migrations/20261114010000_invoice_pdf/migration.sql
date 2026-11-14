-- The stored invoice PDF (MVP-92, D-171): one object per invoice, re-rendered when the invoice changes.
ALTER TABLE "invoices"
  ADD COLUMN "pdf_storage_key" TEXT,
  ADD COLUMN "pdf_language" "OfficeLanguage",
  ADD COLUMN "pdf_rendered_for" TIMESTAMPTZ(3),
  ADD CONSTRAINT "invoices_pdf_storage_key_check"
    CHECK ("pdf_storage_key" IS NULL OR "pdf_storage_key" LIKE "office_id"::text || '/%');
