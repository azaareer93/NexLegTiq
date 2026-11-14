-- The payer as it was when the receipt was issued (MVP-170 review, D-174): re-prints never show later office edits.
-- No payment exists outside development yet; the default only fills local rows and is dropped at once.
ALTER TABLE "platform_payments"
  ADD COLUMN "payer_name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "payer_address" TEXT,
  ADD COLUMN "payer_email" TEXT,
  ADD CONSTRAINT "platform_payments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "platform_payments" ALTER COLUMN "payer_name" DROP DEFAULT;
