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
  projectPortableDescription,
  writePortableBundleCarrier
} from "../persistence/bundle-carrier-repo";
import {
  closeImportArtifact,
  type ImportStageArtifact,
  type PublishedImportArtifact,
  publishStagedImport,
  removeImportArtifact,
  writeImportStage
} from "./pwrsnap-import-install";
import {
  createPwrsnapImportIntent,
  deletePwrsnapImportIntent,
  deletePwrsnapImportIntentInCurrentTransaction,
  listPwrsnapImportIntents,
  markPwrsnapImportPublished,
} from "./pwrsnap-import-intent";
import {
  PwrsnapImportError,
  readAndValidatePwrsnapBundle
} from "./pwrsnap-import-reader";
import type { ValidatedPwrsnapBundle } from "./pwrsnap-import-reader";

const log = getMainLogger("pwrsnap:bundle-import");
const MAX_ID_PROBES = 10_000;
let importQueue: Promise<void> = Promise.resolve();

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
  return serializeImportOperation(() => importPwrsnapBundleExclusive(sourcePath));
}

async function importPwrsnapBundleExclusive(
  sourcePath: string
): Promise<PwrsnapImportOutcome> {
  await reconcilePendingPwrsnapImportsExclusive();
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

    let stage: ImportStageArtifact | null = null;
    let stageClosed = false;
    let published: PublishedImportArtifact | null = null;
    let intentId: string | null = null;
    try {
      stage = await writeImportStage(getDataRoot(), copiedBytes);
      const intent = createPwrsnapImportIntent({
        captureId,
        bundlePath: destinationPath,
        stage,
        contentDigest: bundle.contentDigest,
        captureIdChanged,
        remappedLayerCount: remapped.remappedCount
      });
      intentId = intent.id;
      published = await publishStagedImport(stage, destinationPath);
      markPwrsnapImportPublished(intent.id, published.identity);

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
          capturedAt: copiedManifest.created_at,
          intentId: intent.id
        });
      } catch (cause) {
        // Roll back only the exact inode we published. If cleanup fails or a
        // watcher replaced the path, retain the durable intent so startup can
        // reconcile without deleting bytes PwrSnap no longer owns.
        const removed = await removeImportArtifact(published).catch((cleanupCause) => {
          log.error("bundle import: retained recovery intent after DB rollback cleanup failed", {
            intentId: intent.id,
            message:
              cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)
          });
          return null;
        });
        if (removed !== null) {
          deletePwrsnapImportIntent(intent.id);
          intentId = null;
          published = null;
        }
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
        installMode: published.installMode
      };
    } catch (cause) {
      if (intentId !== null && published === null) {
        try {
          await lstat(destinationPath);
        } catch (statCause) {
          if (isErrno(statCause, "ENOENT")) {
            deletePwrsnapImportIntent(intentId);
            intentId = null;
          }
        }
      }
      throw cause;
    } finally {
      if (stage !== null) {
        if (!stageClosed) {
          await closeImportArtifact(stage).catch((cause) => {
            log.warn("bundle import: staged descriptor cleanup failed", {
              message: cause instanceof Error ? cause.message : String(cause)
            });
          });
          stageClosed = true;
        }
        await removeImportArtifact(stage).catch((cause) => {
          log.warn("bundle import: staged artifact cleanup failed", {
            intentId,
            message: cause instanceof Error ? cause.message : String(cause)
          });
        });
      }
    }
  });
}

export async function reconcilePendingPwrsnapImports(): Promise<string[]> {
  return serializeImportOperation(reconcilePendingPwrsnapImportsExclusive);
}

async function reconcilePendingPwrsnapImportsExclusive(): Promise<string[]> {
  const recoveredCaptureIds: string[] = [];
  for (const intent of listPwrsnapImportIntents()) {
    const existing = getCaptureById(intent.captureId);
    if (existing !== null) {
      if (await recordMatchesContent(existing, intent.contentDigest)) {
        try {
          await removeImportArtifact({
            path: intent.stagePath,
            identity: intent.stageIdentity
          });
          deletePwrsnapImportIntent(intent.id);
        } catch (cause) {
          log.warn("bundle import recovery: retained intent after stage cleanup failed", {
            intentId: intent.id,
            message: cause instanceof Error ? cause.message : String(cause)
          });
        }
      } else {
        log.error("bundle import recovery: capture id is occupied by different content", {
          intentId: intent.id,
          captureId: intent.captureId
        });
      }
      continue;
    }

    try {
      await lstat(intent.bundlePath);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) {
        // Publication never happened. Remove only the persisted stage identity,
        // then clear the intent so the external file can be imported again.
        try {
          await removeImportArtifact({
            path: intent.stagePath,
            identity: intent.stageIdentity
          });
          deletePwrsnapImportIntent(intent.id);
        } catch (cleanupCause) {
          log.warn("bundle import recovery: retained pre-publish intent", {
            intentId: intent.id,
            message:
              cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)
          });
        }
        continue;
      }
      log.warn("bundle import recovery: could not inspect intended destination", {
        intentId: intent.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      continue;
    }

    try {
      const bundle = await readAndValidatePwrsnapBundle(intent.bundlePath);
      const archiveSha256 = createHash("sha256").update(bundle.sourceBytes).digest("hex");
      if (
        bundle.openedFileIdentity === null ||
        (intent.publishedIdentity !== null &&
          !sameImportIdentity(bundle.openedFileIdentity, intent.publishedIdentity)) ||
        bundle.manifest.capture_id !== intent.captureId ||
        bundle.sourceBytes.length !== intent.archiveSize ||
        archiveSha256 !== intent.archiveSha256 ||
        bundle.contentDigest !== intent.contentDigest
      ) {
        throw new PwrsnapImportError(
          "unsafe",
          "recovery_identity_mismatch",
          "A pending imported bundle changed before recovery could complete."
        );
      }
      const currentStat = await lstat(intent.bundlePath, { bigint: true });
      if (
        !sameImportIdentity(bundle.openedFileIdentity, {
          dev: currentStat.dev.toString(),
          ino: currentStat.ino.toString(),
          birthtimeNs: currentStat.birthtimeNs.toString(),
          size: currentStat.size.toString()
        })
      ) {
        throw new PwrsnapImportError(
          "unsafe",
          "recovery_path_changed",
          "A pending imported bundle changed before recovery could complete."
        );
      }
      const baseSource = bundle.sourceInfo.get(bundle.baseSourceSha256);
      if (baseSource === undefined) {
        throw new PwrsnapImportError(
          "corrupt",
          "base_source_missing",
          "The pending imported bundle is missing its base image."
        );
      }
      const record = persistImportedBundle({
        captureId: intent.captureId,
        bundlePath: intent.bundlePath,
        bundleModifiedAt: bundle.manifest.bundle_modified_at,
        document: bundle.document,
        widthPx: bundle.manifest.canvas_dimensions.width_px,
        heightPx: bundle.manifest.canvas_dimensions.height_px,
        baseSourceSha256: bundle.baseSourceSha256,
        baseSourceByteSize: baseSource.bytes.length,
        hasAlpha: await sourceBufferHasAlpha(baseSource.bytes),
        capturedAt: bundle.manifest.created_at,
        intentId: intent.id
      });
      recoveredCaptureIds.push(record.id);
      log.info("bundle import recovery: completed pending import", {
        intentId: intent.id,
        captureId: record.id
      });
    } catch (cause) {
      // Keep the intent: it is the durable ownership marker for the final path.
      log.error("bundle import recovery: retained unresolved import intent", {
        intentId: intent.id,
        captureId: intent.captureId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
  return recoveredCaptureIds;
}

function serializeImportOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = importQueue.catch(() => undefined).then(operation);
  importQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
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
  intentId: string;
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
    const projectedDescription = projectPortableDescription(input.document.description);
    if (projectedDescription !== null) {
      acceptDescription(input.captureId, projectedDescription);
    }
    writePortableBundleCarrier(input.captureId, input.document);

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
    deletePwrsnapImportIntentInCurrentTransaction(input.intentId);
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

function sameImportIdentity(
  left: { dev: string; ino: string; birthtimeNs: string; size: string },
  right: { dev: string; ino: string; birthtimeNs: string; size: string }
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.size === right.size
  );
}
