-- Reminder engine (D-117): one reminder row per reminder day and recipient (attending lawyer, file's responsible lawyer).
-- Rows written before the engine existed belong to the attending lawyer; nothing has been sent from them yet.
ALTER TABLE "session_reminders" ADD COLUMN "recipient_id" UUID;

UPDATE "session_reminders" r
SET "recipient_id" = s."attending_lawyer_id"
FROM "sessions" s
WHERE s."id" = r."session_id" AND s."office_id" = r."office_id";

ALTER TABLE "session_reminders" ALTER COLUMN "recipient_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "session_reminders_office_id_recipient_id_idx" ON "session_reminders"("office_id", "recipient_id");

-- AddForeignKey
ALTER TABLE "session_reminders" ADD CONSTRAINT "session_reminders_recipient_id_office_id_fkey" FOREIGN KEY ("recipient_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
