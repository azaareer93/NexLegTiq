-- MVP-150 (D-188): invoices a client may see on the portal, and the timeline event of sharing one.
-- AlterEnum
ALTER TYPE "TimelineEventType" ADD VALUE 'INVOICE_SHARED';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "shared_with_client" BOOLEAN NOT NULL DEFAULT false;

