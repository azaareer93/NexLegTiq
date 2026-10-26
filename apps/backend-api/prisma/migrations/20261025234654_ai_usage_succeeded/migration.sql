-- D-144: the monthly AI quota counts successful operations only; an answer that failed validation (AI-004) is still
-- recorded (it was paid for) but no longer uses the office's quota. Existing rows count as before.
ALTER TABLE "ai_usages" ADD COLUMN "succeeded" BOOLEAN NOT NULL DEFAULT true;
