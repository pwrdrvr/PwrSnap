-- The primary enrichment provider (e.g. "custom:<uuid>", "acp:kimi") a run
-- stood in for when it was answered by `ai.enrichmentFallback` because the
-- primary could not be reached. NULL: the run used the primary.
ALTER TABLE ai_runs ADD COLUMN fallback_from TEXT;
