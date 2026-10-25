-- D-142: the monthly Vision page budget sums the office's paid versions since the start of the month.
CREATE INDEX "document_texts_vision_budget_idx" ON "document_texts" ("office_id", "extracted_at") WHERE "ocr_cost_usd" IS NOT NULL;
