-- Notification types are UPPER_SNAKE like every enum value (D-016, D-149): rename the ones written before.
UPDATE "notifications" SET "type" = CASE "type"
  WHEN 'SESSION_REMINDER' THEN 'HEARING_REMINDER'
  WHEN 'task.assigned' THEN 'TASK_ASSIGNED'
  WHEN 'file.reassigned' THEN 'FILE_REASSIGNED'
  WHEN 'file.teamAdded' THEN 'FILE_TEAM_ADDED'
  WHEN 'invitation.accepted' THEN 'INVITE_ACCEPTED'
  ELSE "type"
END
WHERE "type" IN ('SESSION_REMINDER', 'task.assigned', 'file.reassigned', 'file.teamAdded', 'invitation.accepted');

-- The daily retention purge (90 days) scans by age across offices.
CREATE INDEX "notifications_created_at_idx" ON "notifications" ("created_at");
