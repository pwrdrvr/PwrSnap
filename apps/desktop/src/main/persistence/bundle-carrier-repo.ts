import { BundleAIRunRecordV2, normalizeTagLabel } from "@pwrsnap/shared";
import type { BundleDocumentV2 } from "@pwrsnap/shared";

import { getDb } from "./db";
import {
  emptyPortableBundleMetadata,
  parsePortableBundleMetadata,
  serializePortableBundleMetadata,
  type PortableBundleMetadata
} from "./portable-bundle-metadata";

export type PortableBundleCarrier = {
  fullDescription: string | null;
  fullTags: string[] | null;
  projectedDescription: string | null;
  projectedTagKeys: string[];
  aiRuns: BundleDocumentV2["ai_runs"];
  portableMetadata: PortableBundleMetadata;
  layerOrder: string[] | null;
};

export function writePortableBundleCarrier(
  captureId: string,
  document: Pick<BundleDocumentV2, "layers" | "tags" | "description" | "ai_runs">,
  portableMetadata: PortableBundleMetadata = emptyPortableBundleMetadata()
): void {
  getDb()
    .prepare(
      `INSERT INTO capture_bundle_carriers (
         capture_id, full_description, projected_description,
         projected_tags_json, ai_runs_json, portable_metadata_json,
         full_tags_json, layer_order_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(capture_id) DO UPDATE SET
         full_description = excluded.full_description,
         projected_description = excluded.projected_description,
         projected_tags_json = excluded.projected_tags_json,
         ai_runs_json = excluded.ai_runs_json,
         portable_metadata_json = excluded.portable_metadata_json,
         full_tags_json = excluded.full_tags_json,
         layer_order_json = excluded.layer_order_json`
    )
    .run(
      captureId,
      document.description,
      projectPortableDescription(document.description),
      JSON.stringify(canonicalPortableTagKeys(document.tags)),
      JSON.stringify(document.ai_runs),
      serializePortableBundleMetadata(portableMetadata),
      JSON.stringify(document.tags),
      JSON.stringify(document.layers.map((layer) => layer.id))
    );
}

export function readPortableBundleCarrier(
  captureId: string
): PortableBundleCarrier | null {
  const row = getDb()
    .prepare(
      `SELECT full_description, projected_description, projected_tags_json,
              ai_runs_json, portable_metadata_json, full_tags_json, layer_order_json
         FROM capture_bundle_carriers
        WHERE capture_id = ?`
    )
    .get(captureId) as
    | {
        full_description: string | null;
        projected_description: string | null;
        projected_tags_json: string;
        ai_runs_json: string;
        portable_metadata_json: string;
        full_tags_json: string | null;
        layer_order_json: string | null;
      }
    | undefined;
  if (row === undefined) return null;
  const parsed = JSON.parse(row.ai_runs_json) as unknown;
  const aiRuns = BundleAIRunRecordV2.array().max(1_024).parse(parsed);
  const fullTags = parseStringArray(row.full_tags_json, 256, 64);
  const projectedTagKeys = JSON.parse(row.projected_tags_json) as unknown;
  if (
    !Array.isArray(projectedTagKeys) ||
    !projectedTagKeys.every((value) => typeof value === "string")
  ) {
    throw new Error("Invalid portable bundle tag projection.");
  }
  const layerOrder = parseStringArray(row.layer_order_json, 4_096, 64);
  return {
    fullDescription: row.full_description,
    fullTags,
    projectedDescription: row.projected_description,
    projectedTagKeys,
    aiRuns,
    portableMetadata: parsePortableBundleMetadata(row.portable_metadata_json),
    layerOrder
  };
}

function parseStringArray(
  json: string | null,
  maxItems: number,
  maxLength: number
): string[] | null {
  if (json === null) return null;
  const value = JSON.parse(json) as unknown;
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    !value.every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= maxLength
    )
  ) {
    throw new Error("Invalid portable bundle carrier array.");
  }
  return value;
}

export function canonicalPortableTagKeys(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => normalizeTagLabel(tag)))].sort();
}

export function projectPortableDescription(description: string | null): string | null {
  const trimmed = description?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed.slice(0, 2_000);
}
