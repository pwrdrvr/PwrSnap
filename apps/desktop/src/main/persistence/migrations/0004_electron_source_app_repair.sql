-- 0004_electron_source_app_repair - normalize Electron dev-shell
-- captures that macOS reports under Electron's default bundle id.
--
-- Electron's stock development bundle id is `com.github.Electron`.
-- Older renderer code mapped the `github` vendor segment to the
-- curated GitHub app bucket, so existing local libraries can show
-- Electron dev-app captures under GitHub. The display mapper now
-- treats this bundle id as an open fallback; this one-time repair
-- makes the persisted user-facing name explicit for any old rows
-- that arrived with a missing or misleading name.
--
-- Do NOT rewrite `source_app_bundle_id`: it is the macOS truth and
-- future captures from unbranded Electron dev apps will continue to
-- report it. Real GitHub Desktop rows use `com.github.GitHubClient`
-- and are intentionally untouched.

UPDATE captures
SET source_app_name = 'Electron'
WHERE source_app_bundle_id = 'com.github.Electron'
  AND (
    source_app_name IS NULL
    OR source_app_name = ''
    OR source_app_name = 'GitHub'
    OR source_app_name = 'GitHub Desktop'
  );

-- Rebuild app_stats in the same one-shot migration so any database
-- that previously had stale source-app counts comes out coherent.
-- Match app_stats' uniqueness rule: NULL and empty-string bundle ids
-- are the same bucket via COALESCE(source_app_bundle_id, '').
DELETE FROM app_stats;

INSERT INTO app_stats (source_app_bundle_id, count)
SELECT
  CASE COALESCE(source_app_bundle_id, '')
    WHEN '' THEN NULL
    ELSE source_app_bundle_id
  END,
  COUNT(*)
FROM captures
WHERE deleted_at IS NULL
GROUP BY COALESCE(source_app_bundle_id, '');
