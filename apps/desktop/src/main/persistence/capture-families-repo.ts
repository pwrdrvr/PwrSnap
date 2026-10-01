// Duplicate families — captures that share a `family_id` (migration 0035).
//
// A family is created the first time a capture is duplicated: the source
// gets `family_id = its own id` (it is the root) and the copy gets the same
// value plus `duplicated_from = source`. Neither column is a foreign key, so
// purging any member leaves the others — and the family — intact.

import type { CaptureFamilySummary, CaptureRecord } from "@pwrsnap/shared";
import {
  copyStem,
  copyTitle,
  nextCopyNumber,
  stripStemCopySuffix,
  stripTitleCopySuffix
} from "@pwrsnap/shared";

import { getCapturesByIds } from "./captures-repo";
import { getDb } from "./db";
import { notifyFamiliesChanged } from "./family-change-signal";

type FamilyRow = {
  family_id: string;
  root_live: number | null;
  live_count: number;
  trashed_count: number;
  newest_captured_at: string | null;
  newest_live_id: string | null;
};

/**
 * Every family with at least two members (trashed ones count), newest live
 * activity first. A root whose copies were all purged is just a snap again.
 * Families are rare (one per duplicated snap), so this is one grouped
 * scan over the partial `idx_captures_family` index.
 */
export function listCaptureFamilies(): CaptureFamilySummary[] {
  const rows = getDb()
    .prepare(
      `SELECT c.family_id,
              (SELECT CASE WHEN r.deleted_at IS NULL THEN 1 ELSE 0 END
                 FROM captures r WHERE r.id = c.family_id) AS root_live,
              SUM(CASE WHEN c.deleted_at IS NULL THEN 1 ELSE 0 END) AS live_count,
              SUM(CASE WHEN c.deleted_at IS NULL THEN 0 ELSE 1 END) AS trashed_count,
              MAX(CASE WHEN c.deleted_at IS NULL THEN c.captured_at END) AS newest_captured_at,
              (SELECT n.id FROM captures n
                WHERE n.family_id = c.family_id AND n.deleted_at IS NULL
                ORDER BY n.captured_at DESC, n.id DESC LIMIT 1) AS newest_live_id
         FROM captures c
        WHERE c.family_id IS NOT NULL
        GROUP BY c.family_id
       HAVING COUNT(*) > 1`
    )
    .all() as FamilyRow[];
  const families = rows.map((row): CaptureFamilySummary => ({
    familyId: row.family_id,
    rootId: row.root_live === null ? null : row.family_id,
    coverId: row.root_live === 1 ? row.family_id : row.newest_live_id,
    liveCount: row.live_count,
    trashedCount: row.trashed_count,
    newestCapturedAt: row.newest_captured_at ?? ""
  }));
  // Families with a live member first (newest first); all-trashed last.
  return families.sort((a, b) =>
    b.newestCapturedAt.localeCompare(a.newestCapturedAt)
  );
}

/** One family's members, trashed ones included, oldest first. */
export function listFamilyMembers(familyId: string): CaptureRecord[] {
  const ids = (
    getDb()
      .prepare(
        `SELECT id FROM captures
          WHERE family_id = ?
          ORDER BY captured_at ASC, id ASC`
      )
      .all(familyId) as Array<{ id: string }>
  ).map((row) => row.id);
  return ids.length === 0 ? [] : getCapturesByIds(ids);
}

/**
 * Root a new family at `sourceId` if it has none. Returns whether the row
 * changed; its bundle manifest then owes a repack to carry the lineage.
 *
 * Call it inside the transaction that inserts the copy, so the root and
 * its first copy commit together. Rooting ahead of the copy and undoing it
 * on failure raced: a second duplicate of the same snap, still copying
 * when the first one failed, saw its root un-rooted under it.
 */
export function rootCaptureFamily(sourceId: string): boolean {
  const rooted =
    getDb()
      .prepare("UPDATE captures SET family_id = id WHERE id = ? AND family_id IS NULL")
      .run(sourceId).changes === 1;
  if (rooted) notifyFamiliesChanged([sourceId]);
  return rooted;
}

type EnrichmentCopyRow = {
  ocr_text: string | null;
  suggested_description: string | null;
  accepted_description: string | null;
  description_accepted_at: string | null;
  suggested_title: string | null;
  accepted_title: string | null;
  title_accepted_at: string | null;
  suggested_filename_stem: string | null;
  accepted_filename_stem: string | null;
  filename_accepted_at: string | null;
};

/**
 * Copy the source's enrichment onto the copy — OCR, description, title,
 * filename stem, and accepted tags — so the copy is searchable and named
 * without re-running the model. Title and stem get " copy" / "-copy",
 * numbered against the rest of the family ("copy 2", "-copy-2", …).
 *
 * The AI run is NOT linked (`latest_ai_run_id` / `ai_run_id` stay NULL):
 * the run belongs to the source, and pending tag suggestions (which hang
 * off that run) are not copied. Caller runs this inside its transaction.
 */
export function copyCaptureEnrichment(args: {
  fromId: string;
  toId: string;
  familyId: string;
}): void {
  const db = getDb();
  const source = db
    .prepare(
      `SELECT ocr_text, suggested_description, accepted_description,
              description_accepted_at, suggested_title, accepted_title,
              title_accepted_at, suggested_filename_stem,
              accepted_filename_stem, filename_accepted_at
         FROM capture_enrichments WHERE capture_id = ?`
    )
    .get(args.fromId) as EnrichmentCopyRow | undefined;

  if (source !== undefined) {
    const effectiveTitle = source.accepted_title ?? source.suggested_title;
    const effectiveStem = source.accepted_filename_stem ?? source.suggested_filename_stem;
    const titleBase = effectiveTitle === null ? null : stripTitleCopySuffix(effectiveTitle);
    const stemBase = effectiveStem === null ? null : stripStemCopySuffix(effectiveStem);
    const family = db
      .prepare(
        `SELECT COALESCE(e.accepted_title, e.suggested_title) AS title,
                COALESCE(e.accepted_filename_stem, e.suggested_filename_stem) AS stem
           FROM captures c
           LEFT JOIN capture_enrichments e ON e.capture_id = c.id
          WHERE c.family_id = ? AND c.id != ?`
      )
      .all(args.familyId, args.toId) as Array<{ title: string | null; stem: string | null }>;
    const n = nextCopyNumber({
      titleBase,
      stemBase,
      familyTitles: family.map((row) => row.title),
      familyStems: family.map((row) => row.stem)
    });
    const renameTitle = (value: string | null): string | null =>
      value === null ? null : copyTitle(stripTitleCopySuffix(value), n);
    const renameStem = (value: string | null): string | null =>
      value === null ? null : copyStem(stripStemCopySuffix(value), n);

    db.prepare(
      `INSERT INTO capture_enrichments (
         capture_id, latest_ai_run_id, ocr_text,
         suggested_description, accepted_description, description_accepted_at,
         suggested_title, accepted_title, title_accepted_at,
         suggested_filename_stem, accepted_filename_stem, filename_accepted_at
       ) VALUES (
         @capture_id, NULL, @ocr_text,
         @suggested_description, @accepted_description, @description_accepted_at,
         @suggested_title, @accepted_title, @title_accepted_at,
         @suggested_filename_stem, @accepted_filename_stem, @filename_accepted_at
       )`
    ).run({
      ...source,
      capture_id: args.toId,
      suggested_title: renameTitle(source.suggested_title),
      accepted_title: renameTitle(source.accepted_title),
      suggested_filename_stem: renameStem(source.suggested_filename_stem),
      accepted_filename_stem: renameStem(source.accepted_filename_stem)
    });
  }

  db.prepare(
    `INSERT OR IGNORE INTO capture_tags (capture_id, tag_id, source, ai_run_id, created_at)
     SELECT ?, tag_id, source, NULL, created_at
       FROM capture_tags WHERE capture_id = ?`
  ).run(args.toId, args.fromId);
}
