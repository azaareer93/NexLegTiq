-- D-146: a user's digit style and notification preferences (channels turned off per category).
-- CreateEnum
CREATE TYPE "DigitStyle" AS ENUM ('WESTERN', 'ARABIC_INDIC');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "digit_style" "DigitStyle" NOT NULL DEFAULT 'WESTERN',
ADD COLUMN     "notification_prefs" JSONB NOT NULL DEFAULT '{}';


-- Preferences are an object of category → {email?, inApp?}; anything else is refused.
ALTER TABLE "users" ADD CONSTRAINT "users_notification_prefs_check" CHECK (jsonb_typeof("notification_prefs") = 'object');
