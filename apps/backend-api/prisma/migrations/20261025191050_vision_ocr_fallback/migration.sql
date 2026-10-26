-- AlterTable
ALTER TABLE "document_texts" ADD COLUMN     "ocr_cost_usd" DECIMAL(10,6);

-- AlterTable
ALTER TABLE "office_settings" ADD COLUMN     "enable_vision_ocr" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "ocr_pages_monthly" INTEGER NOT NULL DEFAULT 0;

-- D-142: a page budget is never negative; spend can't go below zero either.
ALTER TABLE "plans" ADD CONSTRAINT "plans_ocr_pages_monthly_check" CHECK ("ocr_pages_monthly" >= 0);
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_ocr_cost_usd_check" CHECK ("ocr_cost_usd" IS NULL OR "ocr_cost_usd" >= 0);
