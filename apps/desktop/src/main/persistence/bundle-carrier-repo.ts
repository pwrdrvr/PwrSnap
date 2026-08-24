import { BundleAIRunRecordV2, normalizeTagLabel } from "@pwrsnap/shared";
import type { BundleDocumentV2 } from "@pwrsnap/shared";

import { getDb } from "./db";

export type PortableBundleCarrier = {
  fullDescription: string | null;
  projectedDescription: string | null;
  projectedTagKeys: string[];
  aiRuns: BundleDocumentV2["ai_runs"];
};

export function writePortableBundleCarrier(
  captureId: string,
  document: Pick<BundleDocumentV2, "tags" | "description" | "ai_runs">
): void {
  getDb()
    .prepare(
      `INSERT INTO capture_bundle_carriers (
         capture_id, full_description, projected_description,
         projected_tags_json, ai_runs_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(capture_id) DO UPDATE SET
         full_description = excluded.full_description,
         projected_description = excluded.projected_description,
         projected_tags_json = excluded.projected_tags_json,
         ai_runs_json = excluded.ai_runs_json`
    )
    .run(
      captureId,
      document.description,
      projectPortableDescription(document.description),
      JSON.stringify(canonicalPortableTagKeys(document.tags)),
      JSON.stringify(document.ai_runs)
    );
}

export function readPortableBundleCarrier(
  captureId: string
): PortableBundleCarrier | null {
  const row = getDb()
    .prepare(
      `SELECT full_description, projected_description, projected_tags_json,
              ai_runs_json
         FROM capture_bundle_carriers
        WHERE capture_id = ?`
    )
    .get(captureId) as
    | {
        full_description: string | null;
        projected_description: string | null;
        projected_tags_json: string;
        ai_runs_json: string;
      }
    | undefined;
  if (row === undefined) return null;
  const parsed = JSON.parse(row.ai_runs_json) as unknown;
  const aiRuns = BundleAIRunRecordV2.array().max(1_024).parse(parsed);
  const projectedTagKeys = JSON.parse(row.projected_tags_json) as unknown;
  if (
    !Array.isArray(projectedTagKeys) ||
    !projectedTagKeys.every((value) => typeof value === "string")
  ) {
    throw new Error("Invalid portable bundle tag projection.");
  }
  return {
    fullDescription: row.full_description,
    projectedDescription: row.projected_description,
    projectedTagKeys,
    aiRuns
  };
}

export function canonicalPortableTagKeys(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => normalizeTagLabel(tag)))].sort();
}

export function projectPortableDescription(description: string | null): string | null {
  const trimmed = description?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed.slice(0, 2_000);
}
