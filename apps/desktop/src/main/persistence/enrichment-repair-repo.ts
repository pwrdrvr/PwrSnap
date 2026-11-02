// Read side of the enrichment repair job: which live captures have a
// failed (or cancelled) latest run, or have never been through AI at all.
//
// A capture's enrichment status is the status of `capture_enrichments`'
// latest run. "Never ran" is a NULL status, which covers both a capture
// with no `capture_enrichments` row and one whose row lost its run
// (`latest_ai_run_id` is ON DELETE SET NULL). Queued and running captures
// match neither, so a repair never piles a second run onto a live one.
//
// Apps are keyed the way the Library sidebar keys them: the lowercased
// bundle id, with `""` standing in for "no recorded source app".

import type {
  EnrichmentRepairAppCount,
  EnrichmentRepairCriteria,
  EnrichmentRepairPreview,
  EnrichmentRepairStatus
} from "@pwrsnap/shared";
import { getDb } from "./db";

const APP_KEY_SQL = "LOWER(COALESCE(c.source_app_bundle_id, ''))";

const FROM_SQL = `FROM captures c
  LEFT JOIN capture_enrichments e ON e.capture_id = c.id
  LEFT JOIN ai_runs r ON r.id = e.latest_ai_run_id`;

const STATUS_SQL: Record<EnrichmentRepairStatus, string> = {
  failed: "r.status IN ('failed', 'cancelled')",
  never: "r.status IS NULL"
};

type Clauses = { where: string[]; params: Record<string, unknown> };

function baseClauses(): Clauses {
  return { where: ["c.deleted_at IS NULL"], params: {} };
}

function pushStatuses(clauses: Clauses, statuses: readonly EnrichmentRepairStatus[]): void {
  const parts = [...new Set(statuses)].map((status) => STATUS_SQL[status]);
  clauses.where.push(parts.length > 0 ? `(${parts.join(" OR ")})` : "0 = 1");
}

function pushWindow(clauses: Clauses, criteria: EnrichmentRepairCriteria): void {
  if (criteria.since !== null) {
    clauses.where.push("c.captured_at >= @since");
    clauses.params.since = criteria.since;
  }
  if (criteria.until !== null) {
    clauses.where.push("c.captured_at < @until");
    clauses.params.until = criteria.until;
  }
}

function pushApps(clauses: Clauses, criteria: EnrichmentRepairCriteria): void {
  const appIds = [...new Set(criteria.apps.appIds)];
  if (appIds.length === 0) return;
  const names = appIds.map((appId, index) => {
    const key = `app${index}`;
    clauses.params[key] = appId;
    return `@${key}`;
  });
  const op = criteria.apps.mode === "exclude" ? "NOT IN" : "IN";
  clauses.where.push(`${APP_KEY_SQL} ${op} (${names.join(", ")})`);
}

function whereSql(clauses: Clauses): string {
  return `WHERE ${clauses.where.join(" AND ")}`;
}

function countWhere(clauses: Clauses): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n ${FROM_SQL} ${whereSql(clauses)}`)
    .get(clauses.params) as { n: number };
  return row.n;
}

export function previewEnrichmentRepair(criteria: EnrichmentRepairCriteria): EnrichmentRepairPreview {
  const byStatus = {} as Record<EnrichmentRepairStatus, number>;
  for (const status of ["failed", "never"] as const) {
    const clauses = baseClauses();
    pushStatuses(clauses, [status]);
    pushWindow(clauses, criteria);
    pushApps(clauses, criteria);
    byStatus[status] = countWhere(clauses);
  }

  const appClauses = baseClauses();
  pushStatuses(appClauses, criteria.statuses);
  pushWindow(appClauses, criteria);
  const apps = getDb()
    .prepare(
      `SELECT ${APP_KEY_SQL} AS app_key,
              MAX(c.source_app_bundle_id) AS bundle_id,
              MAX(NULLIF(c.source_app_name, '')) AS name,
              COUNT(*) AS count
       ${FROM_SQL}
       ${whereSql(appClauses)}
       GROUP BY app_key
       ORDER BY count DESC, app_key ASC`
    )
    .all(appClauses.params) as Array<{
      app_key: string;
      bundle_id: string | null;
      name: string | null;
      count: number;
    }>;

  return {
    // The two statuses are disjoint, so the batch is the sum of the picked ones.
    total: [...new Set(criteria.statuses)].reduce((sum, status) => sum + byStatus[status], 0),
    byStatus,
    apps: apps.map(
      (row): EnrichmentRepairAppCount => ({
        appKey: row.app_key,
        bundleId: row.bundle_id,
        name: row.name,
        count: row.count
      })
    )
  };
}

/** Every matching capture id, newest first — the order a repair runs in,
 *  so the snaps the user is most likely to look for come back first. */
export function listEnrichmentRepairCaptureIds(criteria: EnrichmentRepairCriteria): string[] {
  const clauses = baseClauses();
  pushStatuses(clauses, criteria.statuses);
  pushWindow(clauses, criteria);
  pushApps(clauses, criteria);
  const rows = getDb()
    .prepare(`SELECT c.id ${FROM_SQL} ${whereSql(clauses)} ORDER BY c.captured_at DESC, c.id DESC`)
    .all(clauses.params) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** Where a capture stands now. `other` is queued, running or completed;
 *  `gone` is deleted or trashed. */
export function enrichmentRepairStatusOf(
  captureId: string
): EnrichmentRepairStatus | "other" | "gone" {
  const row = getDb()
    .prepare(`SELECT c.deleted_at, r.status ${FROM_SQL} WHERE c.id = ?`)
    .get(captureId) as { deleted_at: string | null; status: string | null } | undefined;
  if (row === undefined || row.deleted_at !== null) return "gone";
  if (row.status === null) return "never";
  if (row.status === "failed" || row.status === "cancelled") return "failed";
  return "other";
}
