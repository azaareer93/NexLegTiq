-- D-140: clients and team members joining or leaving a file go on its timeline.
ALTER TYPE "TimelineEventType" ADD VALUE 'CLIENT_ADDED';
ALTER TYPE "TimelineEventType" ADD VALUE 'CLIENT_REMOVED';
ALTER TYPE "TimelineEventType" ADD VALUE 'TEAM_MEMBER_ADDED';
ALTER TYPE "TimelineEventType" ADD VALUE 'TEAM_MEMBER_REMOVED';

-- D-140: the PARALEGAL team role is the file's responsible paralegal (legal_files.responsible_paralegal_id): at most one,
-- like the responsible lawyer (D-095).
CREATE UNIQUE INDEX "file_team_members_one_paralegal_per_file" ON "file_team_members" ("file_id") WHERE "role" = 'PARALEGAL';
