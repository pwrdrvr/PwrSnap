// Duplicate lineage read BACK from a bundle manifest.
//
// `captures.family_id` / `captures.duplicated_from` (migration 0035) are
// mirrored into every bundle manifest (`manifestLineage()` in
// bundle-store.ts), because SQLite is an index over the bundles and never
// the only copy of a user's work. This module is the other half: turning a
// manifest's lineage into rows. Two callers:
//
//   import   `.pwrsnap` opened from Finder (pwrsnap-import-service.ts). The
//            row is new, so the resolved lineage is simply written.
//   repair   the boot filename-maintenance pass, which already reads every
//            live bundle's manifest (bundle-filename-maintenance.ts). It
//            only FILLS columns the row lost; it never overwrites one.
//
// The rules, shared by both:
//
//   - Lineage ids are capture ids, and a capture id is global: the same id
//     means the same capture in every library. So a manifest's ids are kept
//     verbatim. A family whose root is not in this library (the bundle came
//     from another machine) keeps its foreign `family_id`; siblings imported
//     later carry the same id and regroup, and the root regroups with them
//     if it ever arrives. The Library already renders a family with no live
//     root (`rootId: null`) and a member whose parent is missing.
//   - The root's own row decides the family. If the root IS here with no
//     family yet, it is rooted (`family_id = id`), exactly as duplicating it
//     would, and its manifest owes a repack. If the root is here but is
//     itself a member of a different family, the claim contradicts the
//     library and the root's family wins (logged).
//   - A parent edge is dropped (logged) when following `duplicated_from`
//     up from the parent reaches this capture — that edge would close a
//     cycle — or when the parent is here in a different family.
//   - A root has no parent: `family_id = id` with a `duplicated_from` keeps
//     the family and drops the edge.
//
// Where the database and a manifest disagree on a value both hold, the
// database wins and the disagreement is logged. Lineage is write-once in
// normal operation (a root is rooted once, a copy is born with both
// columns), so a disagreement means one side was damaged or hand-edited —
// and the database is what the user has been looking at. Silently moving a
// capture between families on the strength of a file is the worse failure.

import type { BundleManifestV2 } from "@pwrsnap/shared";

import { getMainLogger } from "../log";
import { rootCaptureFamily } from "./capture-families-repo";
import { getDb } from "./db";
import { notifyFamiliesChanged } from "./family-change-signal";

const log = getMainLogger("pwrsnap:capture-lineage");

/** Upper bound on a `duplicated_from` walk. Real chains are a handful
 *  deep; this only has to outlast any honest one and stop a damaged one. */
const MAX_PARENT_WALK = 10_000;

export type LineageClaim = {
  familyId: string | null;
  duplicatedFrom: string | null;
};

export type LineageIssue =
  | "parent_without_family"
  | "self_parent"
  | "root_with_parent"
  | "root_in_other_family"
  | "cycle"
  | "parent_in_other_family";

export type ResolvedLineage = LineageClaim & {
  /** A capture in this library that has to be rooted for the family to
   *  hold — its row has no `family_id` yet. */
  rootToMark: string | null;
  issues: LineageIssue[];
};

/**
 * The lineage a manifest claims, restated for the capture id it will live
 * under. Only a self-reference changes. When an import remaps the capture
 * id (this library already holds `manifest.capture_id` with other content,
 * live or trashed), a bundle that was its family's ROOT cannot stay the
 * root — the root's id belongs to the capture already here. It keeps the
 * family and records itself as a copy of that capture: two independent
 * versions of one snap, which is what a duplicate is. A self-parent is
 * malformed and dropped.
 */
export function lineageClaimFromManifest(
  manifest: Pick<BundleManifestV2, "capture_id" | "family_id" | "duplicated_from">,
  captureId: string
): LineageClaim {
  const familyId = manifest.family_id ?? null;
  let duplicatedFrom = manifest.duplicated_from ?? null;
  if (duplicatedFrom === manifest.capture_id) duplicatedFrom = null;
  if (familyId === null) return { familyId: null, duplicatedFrom };
  if (captureId !== manifest.capture_id && familyId === manifest.capture_id) {
    return { familyId, duplicatedFrom: duplicatedFrom ?? manifest.capture_id };
  }
  return { familyId, duplicatedFrom };
}

/**
 * Resolve a claim against the library as it is now. Reads only; call it
 * inside the transaction that writes the result so the answer cannot go
 * stale before it lands.
 */
export function resolveLineageClaim(captureId: string, claim: LineageClaim): ResolvedLineage {
  const issues: LineageIssue[] = [];
  if (claim.familyId === null) {
    // Every writer puts family_id on a copy; a parent alone is malformed.
    if (claim.duplicatedFrom !== null) issues.push("parent_without_family");
    return { familyId: null, duplicatedFrom: null, rootToMark: null, issues };
  }

  let familyId = claim.familyId;
  let duplicatedFrom = claim.duplicatedFrom;
  let rootToMark: string | null = null;
  if (duplicatedFrom === captureId) {
    issues.push("self_parent");
    duplicatedFrom = null;
  }

  if (familyId !== captureId) {
    const root = familyRowOf(familyId);
    if (root !== null) {
      if (root.family_id === null) {
        rootToMark = familyId;
      } else if (root.family_id !== familyId) {
        issues.push("root_in_other_family");
        familyId = root.family_id;
      }
    }
  }

  if (familyId === captureId) {
    if (duplicatedFrom !== null) issues.push("root_with_parent");
    return { familyId, duplicatedFrom: null, rootToMark: null, issues };
  }

  if (duplicatedFrom !== null) {
    if (parentChainReaches(duplicatedFrom, captureId)) {
      issues.push("cycle");
      duplicatedFrom = null;
    } else {
      const parent = familyRowOf(duplicatedFrom);
      if (parent !== null && parent.family_id !== null && parent.family_id !== familyId) {
        issues.push("parent_in_other_family");
        duplicatedFrom = null;
      }
    }
  }

  return { familyId, duplicatedFrom, rootToMark, issues };
}

/**
 * Root the capture a resolved lineage named, if it still has no family.
 * Returns the id when a row changed — its manifest then owes a repack.
 */
export function markResolvedRoot(resolved: ResolvedLineage): string | null {
  if (resolved.rootToMark === null) return null;
  return rootCaptureFamily(resolved.rootToMark) ? resolved.rootToMark : null;
}

export function logLineageIssues(
  context: "import" | "repair",
  captureId: string,
  claim: LineageClaim,
  resolved: ResolvedLineage
): void {
  if (resolved.issues.length === 0) return;
  log.warn("capture lineage: manifest claim adjusted", {
    context,
    captureId,
    issues: resolved.issues,
    claimedFamilyId: claim.familyId,
    claimedDuplicatedFrom: claim.duplicatedFrom,
    familyId: resolved.familyId,
    duplicatedFrom: resolved.duplicatedFrom
  });
}

export type LineageRepairOutcome =
  /** Nothing to do: the manifest carries no lineage, or the row already agrees. */
  | { status: "unchanged" }
  /** At least one empty column was filled. `rootedId` owes a repack. */
  | { status: "repaired"; rootedId: string | null }
  /** The row and the manifest hold different values. The row was kept. */
  | { status: "conflict" };

/**
 * Fill the lineage columns a row lost from its own bundle's manifest.
 * Never overwrites a value the row holds. Synchronous and transactional;
 * the caller owns the manifest read (and its TCC exposure).
 */
export function repairCaptureLineageFromManifest(
  captureId: string,
  manifest: Pick<BundleManifestV2, "capture_id" | "family_id" | "duplicated_from">
): LineageRepairOutcome {
  if (manifest.capture_id !== captureId) return { status: "unchanged" };
  if (manifest.family_id === undefined && manifest.duplicated_from === undefined) {
    return { status: "unchanged" };
  }
  const db = getDb();
  let changedFamilyId: string | null = null;
  const outcome = db.transaction((): LineageRepairOutcome => {
    const row = db
      .prepare<[string], { family_id: string | null; duplicated_from: string | null }>(
        "SELECT family_id, duplicated_from FROM captures WHERE id = ?"
      )
      .get(captureId);
    if (row === undefined) return { status: "unchanged" };

    const claim = lineageClaimFromManifest(manifest, captureId);
    const resolved = resolveLineageClaim(captureId, claim);
    if (resolved.familyId === null) {
      logLineageIssues("repair", captureId, claim, resolved);
      return { status: "unchanged" };
    }

    const familyAgrees =
      row.family_id === null ||
      row.family_id === resolved.familyId ||
      row.family_id === claim.familyId;
    const parentAgrees =
      row.duplicated_from === null ||
      claim.duplicatedFrom === null ||
      row.duplicated_from === claim.duplicatedFrom;
    if (!familyAgrees || !parentAgrees) {
      log.warn("capture lineage: database and manifest disagree; keeping the database", {
        captureId,
        dbFamilyId: row.family_id,
        dbDuplicatedFrom: row.duplicated_from,
        manifestFamilyId: claim.familyId,
        manifestDuplicatedFrom: claim.duplicatedFrom
      });
      return { status: "conflict" };
    }

    const familyId = row.family_id ?? resolved.familyId;
    const isRoot = familyId === captureId;
    // A parent is only filled under the family it was resolved against,
    // and never onto a row the database calls a root.
    const duplicatedFrom =
      row.duplicated_from ??
      (isRoot || familyId !== resolved.familyId ? null : resolved.duplicatedFrom);
    if (familyId === row.family_id && duplicatedFrom === row.duplicated_from) {
      return { status: "unchanged" };
    }

    logLineageIssues("repair", captureId, claim, resolved);
    db.prepare(
      "UPDATE captures SET family_id = ?, duplicated_from = ? WHERE id = ?"
    ).run(familyId, duplicatedFrom, captureId);
    const rootedId = familyId === resolved.familyId ? markResolvedRoot(resolved) : null;
    log.info("capture lineage restored from bundle manifest", {
      captureId,
      familyId,
      duplicatedFrom,
      filledFamily: row.family_id === null,
      filledParent: row.duplicated_from === null && duplicatedFrom !== null
    });
    changedFamilyId = familyId;
    return { status: "repaired", rootedId };
  })();

  if (changedFamilyId !== null) notifyFamiliesChanged([changedFamilyId]);
  return outcome;
}

function familyRowOf(id: string): { family_id: string | null } | null {
  return (
    getDb()
      .prepare<[string], { family_id: string | null }>(
        "SELECT family_id FROM captures WHERE id = ?"
      )
      .get(id) ?? null
  );
}

/** Whether walking `duplicated_from` up from `startId` reaches `targetId`.
 *  A loop already in the table, or a walk past the bound, counts as
 *  reaching it: an edge that cannot be proven acyclic is not added. */
function parentChainReaches(startId: string, targetId: string): boolean {
  const parentOf = getDb().prepare<[string], { duplicated_from: string | null }>(
    "SELECT duplicated_from FROM captures WHERE id = ?"
  );
  const seen = new Set<string>();
  let current: string | null = startId;
  for (let step = 0; current !== null; step += 1) {
    if (current === targetId) return true;
    if (seen.has(current) || step >= MAX_PARENT_WALK) return true;
    seen.add(current);
    current = parentOf.get(current)?.duplicated_from ?? null;
  }
  return false;
}
