-- MVP-168: the server enforces the office's idle timeout on refresh. Existing sessions start counting now.
ALTER TABLE "refresh_tokens" ADD COLUMN "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
