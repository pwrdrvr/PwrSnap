import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import sharp from "sharp";
import stableStringify from "safe-stable-stringify";
import yauzl from "yauzl";

import {
  BundleDocumentV2,
  BundleManifestV2,
  MAX_IMAGE_DIM_PX,
  validateBundleZipEntryNamesV2
} from "@pwrsnap/shared";
import type {
  BundleDocumentV2 as BundleDocument,
  BundleLayerNode,
  BundleManifestV2 as BundleManifest
} from "@pwrsnap/shared";

import {
  VerifiedFileError,
  withVerifiedFileHandle
} from "../security/verified-file";
import {
  extractPortableBundleMetadata,
  PortableBundleMetadataError,
  type PortableBundleMetadata
} from "../persistence/portable-bundle-metadata";

// The archive, expanded assets, repacked output, and image decode can coexist
// briefly in Electron's main process. Keep each external-import carrier bounded
// so a valid-at-the-limit hostile bundle cannot amplify into multi-gigabyte
// resident memory.
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
// 4096 layers + one payload and unique source per layer + fixed v2 entries.
const MAX_ENTRY_COUNT = 12_300;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_EXTERNAL_IMAGE_PIXELS = 64 * 1024 * 1024;
// `persistCaptureFromTempV2` reads the source and builds its thumbnail through
// sharp's default input ceiling (0x3fff squared). Installed repacks must accept
// every image that boundary can create, while still keeping full decode and
// transformed-raster allocations bounded. Do not replace this with the
// stricter external-import ceiling: stitched/all-screens captures can exceed
// 64 Mi pixels legitimately.
const MAX_INSTALLED_IMAGE_PIXELS = 0x3fff * 0x3fff;
const MAX_TREE_DEPTH = 32;
const MAX_COMPRESSION_RATIO = 1_000;
const MAX_LAYER_NUMERIC_MAGNITUDE = 10_000_000;

export type PwrsnapImportErrorKind =
  | "unsupported"
  | "corrupt"
  | "unsafe"
  | "storage"
  | "database";

export class PwrsnapImportError extends Error {
  constructor(
    readonly kind: PwrsnapImportErrorKind,
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PwrsnapImportError";
  }
}

export type ValidatedImageAsset = {
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
  hasAlphaChannel: boolean;
};

type ValidatedPwrsnapContents = {
  manifest: BundleManifest;
  document: BundleDocument;
  sources: Map<string, Buffer>;
  sourceInfo: Map<string, ValidatedImageAsset>;
  layerBytes: Map<string, Buffer>;
  thumbnailJpg: Buffer | null;
  legacyCompositePng: Buffer | null;
  baseSourceSha256: string;
  contentDigest: string;
  portableMetadata: PortableBundleMetadata;
};

export type ValidatedPwrsnapBundle = ValidatedPwrsnapContents & {
  sourceBytes: Buffer;
  openedFileIdentity: {
    dev: string;
    ino: string;
    birthtimeNs: string;
    size: string;
  } | null;
};

export type ValidatedInstalledPwrsnapBundle = ValidatedPwrsnapContents;

/**
 * Open and validate one path through the shared verified-file boundary. ZIP
 * parsing uses the already-verified descriptor with auto-close disabled, and
 * every read finishes inside the callback that owns the handle lifetime.
 */
export async function readAndValidatePwrsnapBundle(
  sourcePath: string
): Promise<ValidatedPwrsnapBundle> {
  try {
    return await withVerifiedFileHandle(
      sourcePath,
      { maxBytes: MAX_ARCHIVE_BYTES },
      async (handle, openedStat) => {
        if (openedStat.size === 0n) {
          throw corrupt("archive_size_invalid", "The PwrSnap bundle is empty.");
        }
        const sourceBytes = await readExactHandleSnapshot(handle, openedStat);
        const openedZip = await openBoundedZipFromFd(handle.fd, MAX_EXPANDED_BYTES);
        const validated = await validateOpenedPwrsnapBundle(openedZip, {
          maxAssetBytes: MAX_EXPANDED_BYTES,
          maxImagePixels: MAX_EXTERNAL_IMAGE_PIXELS
        });
        return {
          ...validated,
          sourceBytes,
          openedFileIdentity: {
            dev: openedStat.dev.toString(),
            ino: openedStat.ino.toString(),
            birthtimeNs: openedStat.birthtimeNs.toString(),
            size: openedStat.size.toString()
          }
        };
      }
    );
  } catch (cause) {
    throw normalizeBundleReadError(cause);
  }
}

/**
 * Validate an already-installed bundle through the same single verified
 * descriptor lease as external import, but without the external carrier's
 * aggregate archive/expanded-byte ceilings. Local capture and edit paths can
 * legitimately produce more than 128 MiB across many individually valid
 * assets. Schema, entry-count, compression-ratio, graph, hash, image-decode,
 * JSON, and portable-metadata bounds remain enforced.
 *
 * The raw filesystem hook runs before VerifiedFileError sanitization so the
 * owning bundle store can maintain captures-folder permission health without
 * weakening the path-free public error contract.
 */
export async function readAndValidateInstalledPwrsnapBundle(
  sourcePath: string,
  options: {
    onFileSystemError?: (cause: unknown) => void;
    onFileSystemSuccess?: () => void;
  } = {}
): Promise<ValidatedInstalledPwrsnapBundle> {
  try {
    return await withVerifiedFileHandle(
      sourcePath,
      options.onFileSystemError === undefined
        ? {}
        : { onFileSystemError: options.onFileSystemError },
      async (handle, openedStat) => {
        options.onFileSystemSuccess?.();
        if (openedStat.size === 0n) {
          throw corrupt("archive_size_invalid", "The PwrSnap bundle is empty.");
        }
        const openedZip = await openBoundedZipFromFd(handle.fd, null);
        return await validateOpenedPwrsnapBundle(openedZip, {
          maxAssetBytes: null,
          maxImagePixels: MAX_INSTALLED_IMAGE_PIXELS
        });
      }
    );
  } catch (cause) {
    throw normalizeBundleReadError(cause);
  }
}

export async function validatePwrsnapBundleBytes(
  sourceBytes: Buffer
): Promise<ValidatedPwrsnapBundle> {
  if (sourceBytes.length <= 0 || sourceBytes.length > MAX_ARCHIVE_BYTES) {
    throw corrupt("archive_size_invalid", "The PwrSnap bundle has an invalid size.");
  }

  const openedZip = await openBoundedZipFromBuffer(
    sourceBytes,
    MAX_EXPANDED_BYTES
  );
  return {
    ...(await validateOpenedPwrsnapBundle(openedZip, {
      maxAssetBytes: MAX_EXPANDED_BYTES,
      maxImagePixels: MAX_EXTERNAL_IMAGE_PIXELS
    })),
    sourceBytes,
    openedFileIdentity: null
  };
}

async function validateOpenedPwrsnapBundle(
  openedZip: OpenedBoundedZip,
  limits: {
    maxAssetBytes: number | null;
    maxImagePixels: number;
  }
): Promise<ValidatedPwrsnapContents> {
  const { zipFile, entries, names, closeWhenDone } = openedZip;
  try {
    const manifestEntry = entries.get("manifest.json");
    if (manifestEntry === undefined) {
      throw corrupt("manifest_missing", "The PwrSnap bundle has no manifest.");
    }
    const manifestJson = await readJsonEntry(zipFile, manifestEntry, MAX_MANIFEST_BYTES);
    const formatVersion = objectInteger(manifestJson, "bundle_format_version");
    if (formatVersion === 1) {
      throw new PwrsnapImportError(
        "unsupported",
        "legacy_bundle_unsupported",
        "Older PwrSnap bundles and video files cannot be imported by this version."
      );
    }
    if (formatVersion !== 2) {
      if (formatVersion !== null && formatVersion > 2) {
        throw new PwrsnapImportError(
          "unsupported",
          "future_bundle_unsupported",
          "This bundle was created by a newer PwrSnap bundle format."
        );
      }
      throw corrupt("manifest_version_invalid", "The bundle manifest version is invalid.");
    }

    const entryValidation = validateBundleZipEntryNamesV2(names);
    if (!entryValidation.ok) {
      throw corrupt(
        "zip_entries_invalid",
        "The bundle contains missing, duplicate, or unsafe paths."
      );
    }

    let manifest: BundleManifest;
    try {
      manifest = BundleManifestV2.parse(manifestJson);
    } catch (cause) {
      throw corrupt("manifest_schema_invalid", "The bundle manifest is malformed.", cause);
    }
    validatePortableManifest(manifest, limits.maxImagePixels);

    const documentEntry = entries.get("document.json");
    if (documentEntry === undefined) {
      throw corrupt("document_missing", "The PwrSnap bundle has no layer document.");
    }
    const documentJson = await readJsonEntry(zipFile, documentEntry, MAX_DOCUMENT_BYTES);
    const documentVersion = objectInteger(documentJson, "document_format_version");
    if (documentVersion !== 1) {
      if (documentVersion !== null && documentVersion > 1) {
        throw new PwrsnapImportError(
          "unsupported",
          "future_document_unsupported",
          "This bundle uses a newer PwrSnap layer document format."
        );
      }
      throw corrupt("document_version_invalid", "The layer document version is invalid.");
    }

    let document: BundleDocument;
    try {
      document = BundleDocumentV2.parse(documentJson);
    } catch (cause) {
      throw corrupt("document_schema_invalid", "The layer document is malformed.", cause);
    }
    let portableMetadata: PortableBundleMetadata;
    try {
      portableMetadata = extractPortableBundleMetadata(
        manifestJson,
        manifest,
        documentJson,
        document
      );
    } catch (cause) {
      if (cause instanceof PortableBundleMetadataError) {
        throw corrupt(
          "portable_metadata_invalid",
          "The bundle contains portable metadata outside supported safety bounds.",
          cause
        );
      }
      throw cause;
    }
    validatePwrsnapLayerGraphWithLimit(document.layers, limits.maxImagePixels);
    validateAiRunIds(document);

    const sources = new Map<string, Buffer>();
    const sourceInfo = new Map<string, ValidatedImageAsset>();
    const layerBytes = new Map<string, Buffer>();
    let thumbnailJpg: Buffer | null = null;
    let legacyCompositePng: Buffer | null = null;

    for (const [name, entry] of entries) {
      if (name.startsWith("sources/")) {
        const sha = name.slice("sources/".length, -".png".length);
        const bytes = await readEntryToBuffer(zipFile, entry, limits.maxAssetBytes);
        const actualSha = sha256(bytes);
        if (actualSha !== sha) {
          throw corrupt("source_hash_mismatch", "A bundle source failed its integrity check.");
        }
        sources.set(sha, bytes);
        sourceInfo.set(
          sha,
          await inspectImage(bytes, "png", limits.maxImagePixels)
        );
      } else if (name.startsWith("layers/")) {
        const id = name.slice("layers/".length, -".png".length);
        const bytes = await readEntryToBuffer(zipFile, entry, limits.maxAssetBytes);
        await inspectImage(bytes, "png", limits.maxImagePixels);
        layerBytes.set(id, bytes);
      } else if (name === "composite_thumbnail.jpg") {
        thumbnailJpg = await readEntryToBuffer(zipFile, entry, limits.maxAssetBytes);
        await inspectImage(thumbnailJpg, "jpeg", limits.maxImagePixels);
      } else if (name === "composite.png") {
        legacyCompositePng = await readEntryToBuffer(
          zipFile,
          entry,
          limits.maxAssetBytes
        );
        const composite = await inspectImage(
          legacyCompositePng,
          "png",
          limits.maxImagePixels
        );
        if (
          composite.widthPx !== manifest.canvas_dimensions.width_px ||
          composite.heightPx !== manifest.canvas_dimensions.height_px
        ) {
          throw corrupt(
            "composite_dimensions_mismatch",
            "The legacy bundle preview dimensions do not match the canvas."
          );
        }
      }
    }

    validateLayerAssets(document.layers, sources, sourceInfo, layerBytes);
    const baseSourceSha256 = selectBaseSource(document.layers);
    const contentDigest = logicalContentDigest({
      manifest,
      document,
      sources,
      layerBytes,
      portableMetadata
    });

    return {
      manifest,
      document,
      sources,
      sourceInfo,
      layerBytes,
      thumbnailJpg,
      legacyCompositePng,
      baseSourceSha256,
      contentDigest,
      portableMetadata
    };
  } finally {
    if (closeWhenDone) zipFile.close();
  }
}

type OpenedBoundedZip = {
  zipFile: yauzl.ZipFile;
  entries: Map<string, yauzl.Entry>;
  names: string[];
  closeWhenDone: boolean;
};

const ZIP_OPEN_OPTIONS = {
  lazyEntries: true,
  autoClose: false,
  strictFileNames: true,
  validateEntrySizes: true
} as const;

async function openBoundedZipFromBuffer(
  sourceBytes: Buffer,
  maxExpandedBytes: number | null
): Promise<OpenedBoundedZip> {
  const zipFile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(
      sourceBytes,
      ZIP_OPEN_OPTIONS,
      (error, opened) => {
        if (error !== null) return reject(error);
        if (opened === undefined) return reject(new Error("ZIP reader returned no archive"));
        resolve(opened);
      }
    );
  }).catch((cause: unknown) => {
    throw corrupt("zip_open_failed", "The file is not a readable PwrSnap ZIP bundle.", cause);
  });

  return collectBoundedZip(zipFile, true, maxExpandedBytes);
}

async function openBoundedZipFromFd(
  fd: number,
  maxExpandedBytes: number | null
): Promise<OpenedBoundedZip> {
  const zipFile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromFd(fd, ZIP_OPEN_OPTIONS, (error, opened) => {
      if (error !== null) return reject(error);
      if (opened === undefined) return reject(new Error("ZIP reader returned no archive"));
      resolve(opened);
    });
  }).catch((cause: unknown) => {
    throw corrupt("zip_open_failed", "The file is not a readable PwrSnap ZIP bundle.", cause);
  });

  // yauzl 3.x's ZipFile.close() closes an fromFd descriptor even when
  // autoClose is false. The shared verifier owns this handle, so retain the
  // root reader ref and let withVerifiedFileHandle close it after its final
  // identity check. Entry streams still finish before this callback returns.
  return collectBoundedZip(zipFile, false, maxExpandedBytes);
}

async function collectBoundedZip(
  zipFile: yauzl.ZipFile,
  closeWhenDone: boolean,
  maxExpandedBytes: number | null
): Promise<OpenedBoundedZip> {
  return await new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>();
    const names: string[] = [];
    let expandedBytes = 0;
    let settled = false;
    const fail = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      if (closeWhenDone) zipFile.close();
      reject(
        cause instanceof PwrsnapImportError
          ? cause
          : corrupt("zip_directory_invalid", "The bundle ZIP directory is malformed.", cause)
      );
    };

    zipFile.on("entry", (entry: yauzl.Entry) => {
      try {
        names.push(entry.fileName);
        if (names.length > MAX_ENTRY_COUNT) {
          throw corrupt("zip_entry_limit", "The bundle contains too many entries.");
        }
        assertBaseEntryNameSafe(entry.fileName);
        if (entries.has(entry.fileName)) {
          throw corrupt("zip_duplicate_entry", "The bundle contains a duplicate path.");
        }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          throw corrupt("zip_encrypted_entry", "Encrypted bundle entries are not supported.");
        }
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          throw corrupt(
            "zip_compression_unsupported",
            "The bundle uses an unsupported ZIP compression method."
          );
        }
        if (
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0 ||
          !Number.isSafeInteger(entry.compressedSize) ||
          entry.compressedSize < 0
        ) {
          throw corrupt("zip_entry_size_invalid", "A bundle entry has an invalid size.");
        }
        if (
          entry.uncompressedSize > 1024 * 1024 &&
          entry.uncompressedSize > Math.max(1, entry.compressedSize) * MAX_COMPRESSION_RATIO
        ) {
          throw corrupt(
            "zip_compression_ratio_limit",
            "A bundle entry exceeds the safe compression-ratio limit."
          );
        }
        assertZipEntryIsRegular(entry);
        if (maxExpandedBytes !== null) {
          expandedBytes += entry.uncompressedSize;
          if (expandedBytes > maxExpandedBytes) {
            throw corrupt("zip_expanded_limit", "The expanded bundle exceeds the size limit.");
          }
        }
        entries.set(entry.fileName, entry);
        zipFile.readEntry();
      } catch (cause) {
        fail(cause);
      }
    });
    zipFile.once("error", fail);
    zipFile.once("end", () => {
      if (settled) return;
      settled = true;
      resolve({ zipFile, entries, names, closeWhenDone });
    });
    zipFile.readEntry();
  });
}

function assertBaseEntryNameSafe(name: string): void {
  if (
    name.length === 0 ||
    name.includes("..") ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("./") ||
    name.includes("//") ||
    name.includes("/./") ||
    name.endsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw corrupt("zip_path_unsafe", "The bundle contains an unsafe entry path.");
  }
}

function assertZipEntryIsRegular(entry: yauzl.Entry): void {
  const creatorSystem = entry.versionMadeBy >>> 8;
  if (creatorSystem === 3) {
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    if (fileType !== 0 && fileType !== 0o100000) {
      throw corrupt(
        "zip_non_regular_entry",
        "The bundle contains a link or non-regular ZIP entry."
      );
    }
  }
  if ((entry.externalFileAttributes & 0x10) !== 0) {
    throw corrupt("zip_directory_entry", "The bundle contains an unexpected directory entry.");
  }
}

async function readJsonEntry(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  limit: number
): Promise<unknown> {
  const bytes = await readEntryToBuffer(zipFile, entry, limit);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw corrupt("json_encoding_invalid", "Bundle JSON is not valid UTF-8.", cause);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw corrupt("json_invalid", "Bundle JSON is malformed.", cause);
  }
}

function readEntryToBuffer(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  limit: number | null
): Promise<Buffer> {
  if (limit !== null && entry.uncompressedSize > limit) {
    throw corrupt("zip_entry_too_large", "A bundle entry exceeds its size limit.");
  }
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error !== null || stream === undefined) {
        reject(
          corrupt(
            "zip_entry_read_failed",
            "A bundle entry could not be read.",
            error ?? undefined
          )
        );
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (limit !== null && total > limit) {
          stream.destroy(corrupt("zip_entry_too_large", "A bundle entry exceeds its size limit."));
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", (cause) => {
        reject(
          cause instanceof PwrsnapImportError
            ? cause
            : corrupt("zip_entry_read_failed", "A bundle entry could not be read.", cause)
        );
      });
      stream.once("end", () => resolve(Buffer.concat(chunks, total)));
    });
  });
}

function validatePortableManifest(
  manifest: BundleManifest,
  maxImagePixels: number
): void {
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(manifest.capture_id)) {
    throw corrupt("capture_id_unsafe", "The bundle capture ID is not portable.");
  }
  const filename = manifest.paired_png_filename;
  const stem = filename.slice(0, -".png".length);
  if (
    !filename.toLowerCase().endsWith(".png") ||
    /[\u0000-\u001f\u007f<>:"/\\|?*]/.test(filename) ||
    /[. ]$/.test(stem) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(filename)
  ) {
    throw corrupt("paired_filename_unsafe", "The paired image filename is not portable.");
  }
  const pixels =
    manifest.canvas_dimensions.width_px * manifest.canvas_dimensions.height_px;
  if (!Number.isSafeInteger(pixels) || pixels > maxImagePixels) {
    throw corrupt("canvas_pixel_limit", "The bundle canvas exceeds the pixel limit.");
  }
}

export function validatePwrsnapLayerGraph(layers: readonly BundleLayerNode[]): void {
  validatePwrsnapLayerGraphWithLimit(layers, MAX_EXTERNAL_IMAGE_PIXELS);
}

/** Validate locally persisted history with the same image ceiling as capture. */
export function validateInstalledPwrsnapLayerGraph(
  layers: readonly BundleLayerNode[]
): void {
  validatePwrsnapLayerGraphWithLimit(layers, MAX_INSTALLED_IMAGE_PIXELS);
}

function validatePwrsnapLayerGraphWithLimit(
  layers: readonly BundleLayerNode[],
  maxImagePixels: number
): void {
  const byId = new Map<string, BundleLayerNode>();
  for (const layer of layers) {
    if (byId.has(layer.id)) {
      throw corrupt("layer_id_duplicate", "The layer document contains a duplicate layer ID.");
    }
    byId.set(layer.id, layer);
  }
  const roots = layers.filter((layer) => layer.parent_id === null);
  if (roots.length !== 1 || roots[0]?.kind !== "group") {
    throw corrupt("layer_root_invalid", "The layer document must have one root group.");
  }
  const root = roots[0]!;
  if (!isLiveLayer(root)) {
    throw corrupt(
      "live_layer_root_invalid",
      "The layer document must have one live root group."
    );
  }

  for (const layer of layers) {
    assertLayerNumbersBounded(layer, maxImagePixels);
    if (layer.parent_id !== null) {
      const parent = byId.get(layer.parent_id);
      if (parent === undefined || parent.kind !== "group") {
        throw corrupt("layer_parent_invalid", "A layer has a missing or invalid parent.");
      }
    }
    if (layer.superseded_by !== null) {
      if (layer.superseded_by === layer.id || !byId.has(layer.superseded_by)) {
        throw corrupt("layer_superseded_invalid", "A layer has an invalid replacement reference.");
      }
    }

    const seenParents = new Set<string>([layer.id]);
    let current = layer;
    let depth = 0;
    while (current.parent_id !== null) {
      if (seenParents.has(current.parent_id)) {
        throw corrupt("layer_parent_cycle", "The layer document contains a parent cycle.");
      }
      seenParents.add(current.parent_id);
      depth += 1;
      if (depth > MAX_TREE_DEPTH) {
        throw corrupt("layer_depth_limit", "The layer tree exceeds the supported depth.");
      }
      const next = byId.get(current.parent_id);
      if (next === undefined) break;
      current = next;
    }
    if (isLiveLayer(layer)) {
      let liveCurrent = layer;
      while (liveCurrent.parent_id !== null) {
        const liveParent = byId.get(liveCurrent.parent_id);
        if (liveParent === undefined || !isLiveLayer(liveParent)) {
          throw corrupt(
            "live_layer_disconnected",
            "A live layer is disconnected from the live root group."
          );
        }
        liveCurrent = liveParent;
      }
      if (liveCurrent.id !== root.id) {
        throw corrupt(
          "live_layer_disconnected",
          "A live layer is disconnected from the live root group."
        );
      }
    }

    const seenReplacements = new Set<string>([layer.id]);
    let replacement = layer.superseded_by;
    while (replacement !== null) {
      if (seenReplacements.has(replacement)) {
        throw corrupt("layer_superseded_cycle", "The layer history contains a replacement cycle.");
      }
      seenReplacements.add(replacement);
      replacement = byId.get(replacement)?.superseded_by ?? null;
    }
  }
}

function assertLayerNumbersBounded(
  layer: BundleLayerNode,
  maxImagePixels: number
): void {
  const visit = (value: unknown): void => {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > MAX_LAYER_NUMERIC_MAGNITUDE) {
        throw corrupt(
          "layer_numeric_limit",
          "A layer contains geometry outside the supported numeric range."
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(layer);

  if (layer.kind === "raster") {
    const [a, b, c, d] = layer.transform;
    const transformedWidth =
      Math.abs(a) * layer.natural_width_px +
      Math.abs(c) * layer.natural_height_px;
    const transformedHeight =
      Math.abs(b) * layer.natural_width_px +
      Math.abs(d) * layer.natural_height_px;
    const transformedPixels = transformedWidth * transformedHeight;
    if (
      !Number.isFinite(transformedPixels) ||
      transformedWidth > MAX_IMAGE_DIM_PX ||
      transformedHeight > MAX_IMAGE_DIM_PX ||
      transformedPixels > maxImagePixels
    ) {
      throw corrupt(
        "raster_transform_limit",
        "A raster transform would exceed the supported image allocation."
      );
    }
  }
}

function validateAiRunIds(document: BundleDocument): void {
  const ids = new Set<string>();
  for (const run of document.ai_runs) {
    if (ids.has(run.id)) {
      throw corrupt("ai_run_id_duplicate", "The bundle contains duplicate AI metadata IDs.");
    }
    ids.add(run.id);
  }
  for (const layer of document.layers) {
    if (layer.ai_run_id !== null && !ids.has(layer.ai_run_id)) {
      throw corrupt(
        "layer_ai_run_dangling",
        "A layer references missing AI metadata."
      );
    }
  }
}

function validateLayerAssets(
  layers: readonly BundleLayerNode[],
  sources: ReadonlyMap<string, Buffer>,
  sourceInfo: ReadonlyMap<string, ValidatedImageAsset>,
  layerBytes: ReadonlyMap<string, Buffer>
): void {
  const ids = new Set(layers.map((layer) => layer.id));
  const referencedSources = new Set<string>();
  for (const id of layerBytes.keys()) {
    if (!ids.has(id)) {
      throw corrupt("layer_asset_orphan", "A layer payload has no matching layer record.");
    }
  }
  for (const layer of layers) {
    if (layer.kind !== "raster") continue;
    const sha = layer.source_ref.sha256;
    referencedSources.add(sha);
    const info = sourceInfo.get(sha);
    if (!sources.has(sha) || info === undefined) {
      throw corrupt("source_missing", "A raster layer references a missing source image.");
    }
    if (
      info.widthPx !== layer.natural_width_px ||
      info.heightPx !== layer.natural_height_px
    ) {
      throw corrupt(
        "source_dimensions_mismatch",
        "A raster layer's dimensions do not match its source image."
      );
    }
  }
  for (const sha of sources.keys()) {
    if (!referencedSources.has(sha)) {
      throw corrupt(
        "source_asset_orphan",
        "The bundle contains an embedded source with no matching raster layer."
      );
    }
  }
}

function selectBaseSource(layers: readonly BundleLayerNode[]): string {
  const live = layers.filter(
    (layer): layer is Extract<BundleLayerNode, { kind: "raster" }> =>
      layer.kind === "raster" &&
      layer.parent_id !== null &&
      layer.applied_at !== null &&
      layer.rejected_at === null &&
      layer.superseded_by === null
  );
  if (live.length === 0) {
    throw corrupt("base_source_missing", "The bundle contains no live base image layer.");
  }
  const named = live.filter((layer) => layer.name === "Source");
  if (named.length === 1) return named[0]!.source_ref.sha256;
  // Layer names are user-editable. Mirror the v2 renderer's structural
  // fallback: document/tree order supplies the base when no unique seeded
  // "Source" name survives (including a renamed base with pasted rasters).
  return live[0]!.source_ref.sha256;
}

function isLiveLayer(layer: BundleLayerNode): boolean {
  return (
    layer.applied_at !== null &&
    layer.rejected_at === null &&
    layer.superseded_by === null
  );
}

async function inspectImage(
  bytes: Buffer,
  expectedFormat: "png" | "jpeg",
  maxImagePixels: number
): Promise<ValidatedImageAsset> {
  try {
    const options = {
      failOn: "error",
      limitInputPixels: maxImagePixels
    } as const;
    const metadata = await sharp(bytes, options).metadata();
    const widthPx = metadata.width ?? 0;
    const heightPx = metadata.height ?? 0;
    const pixels = widthPx * heightPx;
    if (
      metadata.format !== expectedFormat ||
      widthPx <= 0 ||
      heightPx <= 0 ||
      widthPx > MAX_IMAGE_DIM_PX ||
      heightPx > MAX_IMAGE_DIM_PX ||
      !Number.isSafeInteger(pixels) ||
      pixels > maxImagePixels
    ) {
      throw new Error("image metadata outside supported bounds");
    }
    // libvips can recover dimensions from a truncated header. Force a full,
    // bounded pixel decode so every referenced/opaque image asset is proven
    // readable before the bundle is published or any DB row is created.
    await sharp(bytes, options).raw().toBuffer();
    return {
      bytes,
      widthPx,
      heightPx,
      hasAlphaChannel: metadata.hasAlpha === true
    };
  } catch (cause) {
    throw corrupt("image_invalid", "A bundle image is malformed or exceeds safe dimensions.", cause);
  }
}

function logicalContentDigest(input: {
  manifest: BundleManifest;
  document: BundleDocument;
  sources: ReadonlyMap<string, Buffer>;
  layerBytes: ReadonlyMap<string, Buffer>;
  portableMetadata: PortableBundleMetadata;
}): string {
  const layerIds = new Map(input.document.layers.map((layer, index) => [layer.id, `L${index}`]));
  const runIds = new Map(input.document.ai_runs.map((run, index) => [run.id, `A${index}`]));
  const canonicalLayers = input.document.layers.map((layer) => ({
    ...layer,
    id: layerIds.get(layer.id),
    parent_id: layer.parent_id === null ? null : layerIds.get(layer.parent_id),
    superseded_by:
      layer.superseded_by === null ? null : layerIds.get(layer.superseded_by),
    ai_run_id:
      layer.ai_run_id === null ? null : (runIds.get(layer.ai_run_id) ?? layer.ai_run_id)
  }));
  const canonicalRuns = input.document.ai_runs.map((run) => ({
    ...run,
    id: runIds.get(run.id)
  }));
  const canonicalPortableMetadata = {
    ...input.portableMetadata,
    layers: Object.fromEntries(
      Object.entries(input.portableMetadata.layers).map(([id, metadata]) => [
        layerIds.get(id) ?? id,
        metadata
      ])
    ),
    aiRuns: Object.fromEntries(
      Object.entries(input.portableMetadata.aiRuns).map(([id, metadata]) => [
        runIds.get(id) ?? id,
        metadata
      ])
    )
  };
  const logical = {
    created_at: input.manifest.created_at,
    canvas_dimensions: input.manifest.canvas_dimensions,
    document: {
      ...input.document,
      layers: canonicalLayers,
      ai_runs: canonicalRuns
    },
    portable_metadata: canonicalPortableMetadata,
    sources: [...input.sources.keys()].sort(),
    layer_payloads: [...input.layerBytes.entries()]
      .map(([id, bytes]) => [layerIds.get(id), sha256(bytes)] as const)
      .sort(([left], [right]) => (left ?? "").localeCompare(right ?? ""))
  };
  const encoded = stableStringify(logical);
  if (encoded === undefined) {
    throw corrupt("content_digest_failed", "The bundle content could not be fingerprinted.");
  }
  return sha256(Buffer.from(encoded));
}

function objectInteger(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : null;
}

async function readExactHandleSnapshot(
  handle: FileHandle,
  openedStat: BigIntStats
): Promise<Buffer> {
  const size = Number(openedStat.size);
  let bytes: Buffer;
  try {
    bytes = Buffer.allocUnsafe(size);
  } catch (cause) {
    throw corrupt("archive_allocation_failed", "The bundle could not be buffered safely.", cause);
  }

  let offset = 0;
  try {
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) {
        throw new PwrsnapImportError(
          "unsafe",
          "source_changed_during_read",
          "The selected bundle changed while PwrSnap was reading it."
        );
      }
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await handle.read(probe, 0, 1, size)).bytesRead !== 0) {
      throw new PwrsnapImportError(
        "unsafe",
        "source_changed_during_read",
        "The selected bundle changed while PwrSnap was reading it."
      );
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof PwrsnapImportError) throw cause;
    throw new PwrsnapImportError(
      "storage",
      "source_read_failed",
      "The selected PwrSnap file could not be read safely.",
      { cause }
    );
  }
}

function normalizeBundleReadError(cause: unknown): PwrsnapImportError {
  if (cause instanceof PwrsnapImportError) return cause;
  if (cause instanceof VerifiedFileError) return verifiedFileImportError(cause);
  return new PwrsnapImportError(
    "storage",
    "source_read_failed",
    "The selected PwrSnap file could not be read safely.",
    { cause }
  );
}

function verifiedFileImportError(cause: VerifiedFileError): PwrsnapImportError {
  if (
    cause.code === "symlink" ||
    cause.code === "not_regular_file" ||
    cause.code === "file_changed"
  ) {
    return new PwrsnapImportError(
      "unsafe",
      `verified_file_${cause.code}`,
      "PwrSnap refused a linked, replaced, or non-regular bundle file.",
      { cause }
    );
  }
  if (cause.code === "size_cap_exceeded") {
    return corrupt(
      "archive_size_invalid",
      "The PwrSnap bundle exceeds the supported size limit.",
      cause
    );
  }
  return new PwrsnapImportError(
    "storage",
    `verified_file_${cause.code}`,
    "The selected PwrSnap file could not be opened safely.",
    { cause }
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function corrupt(code: string, message: string, cause?: unknown): PwrsnapImportError {
  return new PwrsnapImportError("corrupt", code, message, { cause });
}
