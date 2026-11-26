-- MVP-117, D-235: indexes the load test asked for (docs/perf/baseline.md).
-- The dashboard's recent activity: the office's newest timeline events, read in index order instead of sorting them all.
CREATE INDEX "case_timeline_events_office_id_occurred_at_id_idx" ON "case_timeline_events"("office_id", "occurred_at" DESC, "id" DESC);

-- The dashboard's "new documents": documents uploaded since a date.
CREATE INDEX "documents_office_id_created_at_idx" ON "documents"("office_id", "created_at");
