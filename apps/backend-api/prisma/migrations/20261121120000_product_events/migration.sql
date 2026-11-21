-- Product analytics (MVP-110, D-215): first-party events counted per office, and the office's opt-out.

-- CreateEnum
CREATE TYPE "ProductEventType" AS ENUM ('SIGNUP_COMPLETED', 'ONBOARDING_STEP_COMPLETED', 'ONBOARDING_COMPLETED', 'FIRST_CASE_CREATED', 'HEARING_SCHEDULED', 'DOCUMENT_UPLOADED', 'AI_SUMMARY_GENERATED', 'INVITE_SENT', 'PORTAL_INVITE_SENT', 'APP_ACTIVE');

-- AlterTable
ALTER TABLE "office_settings" ADD COLUMN     "enable_product_analytics" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "product_events" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "event" "ProductEventType" NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_events_office_id_event_created_at_idx" ON "product_events"("office_id", "event", "created_at");

-- CreateIndex
CREATE INDEX "product_events_event_created_at_idx" ON "product_events"("event", "created_at");

-- AddForeignKey: analytics never blocks deleting an office.
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
