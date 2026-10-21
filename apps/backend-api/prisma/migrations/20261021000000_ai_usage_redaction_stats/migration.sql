-- Counts per kind of what the PII redactor replaced (D-131): an audit trail of redaction without any of the values.
ALTER TABLE "ai_usages" ADD COLUMN "redaction_stats" JSONB NOT NULL DEFAULT '{}';
