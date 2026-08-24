import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { BundleDocumentV2, BundleLayerNode, CaptureRecord } from "@pwrsnap/shared";

import { runWithCapturesDirFallback } from "../capture/capture-storage-gate";
import { getMainLogger } from "../log";
import { buildCompositeThumbnail, packBundleV2 } from "../persistence/bundle-store";
import { getCaptureById, insertCapture } from "../persistence/captures-repo";
import { getDb } from "../persistence/db";
import { acceptDescription, addUserTag } from "../persistence/enrichment-repo";
import { insertImportedLayerTreeForCapture } from "../persistence/layers-repo";
import { getDataRoot } from "../persistence/paths";
import { sourceBufferHasAlpha } from "../persistence/source-alpha";
import {
  publishStagedImport,
  removeImportArtifact,
  writeImportStage
} from "./pwrsnap-import-install";
import {
  PwrsnapImportError,
  readAndValidatePwrsnapBundle
} from "./pwrsnap-import-reader";
import type { ValidatedPwrsnapBundle } from "./pwrsnap-import-reader";

const log = getMainLogger("pwrsnap:bundle-import");
const DESCRIPTION_DB_LIMIT = 2_000;
const MAX_ID_PROBES = 10_000;

export type PwrsnapImportOutcome =
  | {
      status: "duplicate";
      record: CaptureRecord;
    }
  | {
      status: "imported";
      record: CaptureRecord;
      captureIdChanged: boolean;
      remappedLayerCount: number;
      installMode: "renamed" | "copied_cross_volume";
    };

export async function importPwrsnapBundle(sourcePath: string): Promise<PwrsnapImportOutcome> {
  const bundle = await readAndValidatePwrsnapBundle(sourcePath);

  return runWithCapturesDirFallback(async (capturesRoot) => {
    const identity = await chooseCaptureIdentity(bundle);
    if (identity.outcome !== null) return identity.outcome;

    const captureId = identity.captureId;
    const remapped = remapCollidingLayerIds(bundle.document, bundle.layerBytes, {
      captureId,
      contentDigest: bundle.contentDigest,
      idExists: layerIdExists
    });
    const destinationPath = await findAvailableDestination(
      capturesRoot,
      bundle.manifest.paired_png_filename,
      captureId
    );
    const destinationStem = basename(destinationPath, ".pwrsnap");
    const pairedFilename = `${destinationStem}.png`;
    const now = new Date().toISOString();
    const captureIdChanged = captureId !== bundle.manifest.capture_id;
    const manifestChanged =
      captureIdChanged ||
      remapped.remappedCount > 0 ||
      pairedFilename !== bundle.manifest.paired_png_filename;
    const copiedManifest = {
      ...bundle.manifest,
      capture_id: captureId,
      paired_png_filename: pairedFilename,
      bundle_modified_at: manifestChanged ? now : bundle.manifest.bundle_modified_at
    };

    let copiedBytes = bundle.sourceBytes;
    if (manifestChanged) {
      let thumbnailJpg = bundle.thumbnailJpg;
      if (thumbnailJpg === null && bundle.legacyCompositePng !== null) {
        thumbnailJpg = await buildCompositeThumbnail(bundle.legacyCompositePng);
      }
      copiedBytes = await packBundleV2({
        manifest: copiedManifest,
        document: remapped.document,
        sources: bundle.sources,
        layerBytes: remapped.layerBytes,
        thumbnailJpg
      });
    }

    const baseSource = bundle.sourceInfo.get(bundle.baseSourceSha256);
    if (baseSource === undefined) {
      throw new PwrsnapImportError(
        "corrupt",
        "base_source_missing",
        "The bundle's base source image is missing."
      );
    }
    const hasAlpha = await sourceBufferHasAlpha(baseSource.bytes);

    let stagePath: string | null = null;
    let publishedPath: string | null = null;
    try {
      stagePath = await writeImportStage(getDataRoot(), copiedBytes);
      const installMode = await publishStagedImport(stagePath, destinationPath);
      publishedPath = destinationPath;

      let record: CaptureRecord;
      try {
        record = persistImportedBundle({
          captureId,
          bundlePath: destinationPath,
          bundleModifiedAt: copiedManifest.bundle_modified_at,
          document: remapped.document,
          widthPx: copiedManifest.canvas_dimensions.width_px,
          heightPx: copiedManifest.canvas_dimensions.height_px,
          baseSourceSha256: bundle.baseSourceSha256,
          baseSourceByteSize: baseSource.bytes.length,
          hasAlpha,
          capturedAt: copiedManifest.created_at
        });
      } catch (cause) {
        await removeImportArtifact(publishedPath).catch((cleanupCause) => {
          log.error("bundle import: failed to remove artifact after DB rollback", {
            message:
              cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)
          });
        });
        publishedPath = null;
        throw new PwrsnapImportError(
          "database",
          "database_import_failed",
          "PwrSnap rolled back the import because its library metadata could not be saved.",
          { cause }
        );
      }

      return {
        status: "imported",
        record,
        captureIdChanged,
        remappedLayerCount: remapped.remappedCount,
        installMode
      };
    } finally {
      if (stagePath !== null) {
        await removeImportArtifact(stagePath).catch((cause) => {
          log.warn("bundle import: staged artifact cleanup failed", {
            message: cause instanceof Error ? cause.message : String(cause)
          });
        });
      }
    }
  });
}

async function chooseCaptureIdentity(bundle: ValidatedPwrsnapBundle): Promise<{
  captureId: string;
  outcome: Extract<PwrsnapImportOutcome, { status: "duplicate" }> | null;
}> {
  const original = bundle.manifest.capture_id;
  const originalRow = getCaptureById(original);
  if (originalRow === null) return { captureId: original, outcome: null };

  if (
    originalRow.deleted_at === null &&
    (await recordMatchesContent(originalRow, bundle.contentDigest))
  ) {
    return {
      captureId: original,
      outcome: {
        status: "duplicate",
        record: originalRow
      }
    };
  }

  for (let attempt = 0; attempt < MAX_ID_PROBES; attempt += 1) {
    const candidateId = deterministicPortableId(
      "capture",
      original,
      bundle.contentDigest,
      attempt
    );
    if (candidateId === original) continue;
    const row = getCaptureById(candidateId);
    if (row === null) return { captureId: candidateId, outcome: null };
    if (row.deleted_at === null && (await recordMatchesContent(row, bundle.contentDigest))) {
      return {
        captureId: candidateId,
        outcome: {
          status: "duplicate",
          record: row
        }
      };
    }
  }
  throw new PwrsnapImportError(
    "database",
    "capture_id_space_exhausted",
    "PwrSnap could not allocate a collision-free capture ID."
  );
}

async function recordMatchesContent(record: CaptureRecord, expectedDigest: string): Promise<boolean> {
  if (
    record.kind !== "image" ||
    record.bundle_format_version !== 2 ||
    record.bundle_path === null
  ) {
    return false;
  }
  try {
    const local = await readAndValidatePwrsnapBundle(record.bundle_path);
    const dbProjectionMatchesBundle =
      local.manifest.capture_id === record.id &&
      local.manifest.canvas_dimensions.width_px === record.width_px &&
      local.manifest.canvas_dimensions.height_px === record.height_px &&
      local.baseSourceSha256 === record.sha256 &&
      local.document.edits_version === record.bundle_edits_version &&
      record.edits_version === record.bundle_edits_version;
    return dbProjectionMatchesBundle && local.contentDigest === expectedDigest;
  } catch (cause) {
    log.warn("bundle import: local collision candidate could not be verified", {
      captureId: record.id,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return false;
  }
}

function persistImportedBundle(input: {
  captureId: string;
  bundlePath: string;
  bundleModifiedAt: string;
  document: BundleDocumentV2;
  widthPx: number;
  heightPx: number;
  baseSourceSha256: string;
  baseSourceByteSize: number;
  hasAlpha: boolean;
  capturedAt: string;
}): CaptureRecord {
  const db = getDb();
  return db.transaction(() => {
    insertCapture({
      id: input.captureId,
      kind: "image",
      captured_at: input.capturedAt,
      source_app_bundle_id: null,
      source_app_name: null,
      legacy_src_path: null,
      bundle_path: input.bundlePath,
      flat_png_path: null,
      bundle_modified_at: input.bundleModifiedAt,
      bundle_format_version: 2,
      bundle_edits_version: input.document.edits_version,
      width_px: input.widthPx,
      height_px: input.heightPx,
      device_pixel_ratio: 1,
      byte_size: input.baseSourceByteSize,
      sha256: input.baseSourceSha256,
      has_alpha: input.hasAlpha
    });
    insertImportedLayerTreeForCapture(input.captureId, input.document.layers);

    for (const tag of input.document.tags) {
      addUserTag(input.captureId, tag);
    }
    const description = input.document.description?.trim() ?? "";
    if (description.length > 0) {
      acceptDescription(input.captureId, description.slice(0, DESCRIPTION_DB_LIMIT));
    }

    db.prepare(
      `UPDATE captures
          SET edits_version = @edits_version,
              bundle_edits_version = @edits_version
        WHERE id = @id`
    ).run({ id: input.captureId, edits_version: input.document.edits_version });
    const record = getCaptureById(input.captureId);
    if (record === null) {
      throw new Error("Imported capture disappeared before transaction commit.");
    }
    return record;
  })();
}

export function remapCollidingLayerIds(
  document: BundleDocumentV2,
  layerBytes: ReadonlyMap<string, Buffer>,
  options: {
    captureId: string;
    contentDigest: string;
    idExists(id: string): boolean;
  }
): {
  document: BundleDocumentV2;
  layerBytes: Map<string, Buffer>;
  remappedCount: number;
} {
  const sourceIds = new Set(document.layers.map((layer) => layer.id));
  const assigned = new Set<string>();
  const mapping = new Map<string, string>();
  let remappedCount = 0;

  for (const layer of document.layers) {
    let nextId = layer.id;
    if (options.idExists(nextId) || assigned.has(nextId)) {
      for (let attempt = 0; attempt < MAX_ID_PROBES; attempt += 1) {
        const candidate = deterministicPortableId(
          "layer",
          options.captureId,
          options.contentDigest,
          layer.id,
          attempt
        );
        if (
          !options.idExists(candidate) &&
          !assigned.has(candidate) &&
          !sourceIds.has(candidate)
        ) {
          nextId = candidate;
          break;
        }
      }
      if (nextId === layer.id) {
        throw new PwrsnapImportError(
          "database",
          "layer_id_space_exhausted",
          "PwrSnap could not allocate a collision-free layer ID."
        );
      }
      remappedCount += 1;
    }
    assigned.add(nextId);
    mapping.set(layer.id, nextId);
  }

  const layers = document.layers.map((layer): BundleLayerNode => ({
    ...layer,
    id: mapping.get(layer.id)!,
    parent_id: layer.parent_id === null ? null : mapping.get(layer.parent_id)!,
    superseded_by:
      layer.superseded_by === null ? null : mapping.get(layer.superseded_by)!
  })) as BundleLayerNode[];
  const remappedBytes = new Map<string, Buffer>();
  for (const [id, bytes] of layerBytes) {
    remappedBytes.set(mapping.get(id) ?? id, bytes);
  }
  return {
    document: { ...document, layers },
    layerBytes: remappedBytes,
    remappedCount
  };
}

export function deterministicPortableId(...parts: Array<string | number>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part)).join("\0"))
    .digest("base64url")
    .slice(0, 16);
}

async function findAvailableDestination(
  capturesRoot: string,
  pairedPngFilename: string,
  captureId: string
): Promise<string> {
  const desiredStem = pairedPngFilename.slice(0, -".png".length);
  const desiredBundleName = `${desiredStem}.pwrsnap`;
  const fallbackStem = `${truncateUtf8(desiredStem, 180)}-import-${captureId.slice(0, 8)}`;
  const candidates = [
    ...(desiredBundleName.length <= 255 && Buffer.byteLength(desiredBundleName) <= 255
      ? [desiredStem]
      : []),
    fallbackStem
  ];
  for (let attempt = 0; attempt < MAX_ID_PROBES; attempt += 1) {
    const stem =
      attempt < candidates.length
        ? candidates[attempt]!
        : `${fallbackStem}-${attempt}`;
    const candidate = join(capturesRoot, `${stem}.pwrsnap`);
    try {
      await lstat(candidate);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return candidate;
      throw cause;
    }
  }
  throw new PwrsnapImportError(
    "storage",
    "destination_space_exhausted",
    "PwrSnap could not allocate a safe filename in the capture library."
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result.replace(/[. ]+$/u, "") || "capture";
}

function layerIdExists(id: string): boolean {
  return getDb().prepare<[string]>("SELECT 1 FROM layers WHERE id = ?").get(id) !== undefined;
}

function isErrno(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === code
  );
}
