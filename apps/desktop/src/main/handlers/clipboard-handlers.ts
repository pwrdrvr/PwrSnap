// Clipboard handlers. Main image commands:
//
//   • clipboard:copy — v1 + v2: renders the capture at a preset
//     width and writes image bytes to the system clipboard. Stays
//     entirely in the main process — never round-trips the buffer
//     through the renderer (Electron's structured-clone boundary
//     turns multi-MB PNGs into noticeable jank). PR #39 removed an
//     earlier file-URL co-write because some consumers pasted the
//     plain-text URL instead of the image bytes; native file drag is
//     the right path for file URLs (see capture-handlers' drag
//     payload).
//
//   • clipboard:copy-file — v2 image export: renders the capture at a
//     preset width, creates a friendly filename alias, and writes only
//     `public.file-url` so chat/file consumers receive the named PNG.
//
//   • clipboard:copyLayerFragment — v2 only: serializes selected
//     layers + referenced sources into a private UTI buffer
//     (`com.pwrdrvr.pwrsnap.layer-fragment`). Standard image copy is
//     handled by clipboard:copy; Electron cannot atomically write an
//     arbitrary private UTI and image bytes in one clipboard update.
//
//   • clipboard:pasteLayerFragment — v2 only: reads the private UTI
//     buffer if present. Standard image paste is handled by
//     editor:pasteImageAsLayer so one Cmd+V cannot insert both a
//     layer fragment and a raster image.
//     Enforces 5 layers of defense against hostile payloads:
//
//       1. Hard size cap (CLIPBOARD_FRAGMENT_MAX_BYTES = 64 MiB)
//       2. JSON.parse + zod validation (layer/source count bounds)
//       3. sha256 verification — recompute hash of each pngBytes
//          and reject on mismatch; closes the trojan vector where
//          attackers claim a known-good sha but ship different bytes
//       4. sharp decode-probe — bytes must actually decode as PNG
//          with sane (≤ 32768²) dimensions
//       5. Sanitized errors — attacker-controlled identifiers (claimed
//          sha, byte content) never appear in error messages flowing
//          to the renderer
//
// Defenses (1) and (2) bound DoS; (3) and (4) close the integrity
// trojan; (5) closes log-injection / terminal-escape via clipboard
// payload.

import { clipboard, nativeImage } from "electron";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { nanoid } from "nanoid";
import {
  ok,
  err,
  ClipboardLayerFragmentV1,
  CLIPBOARD_FRAGMENT_MAX_BYTES,
  CLIPBOARD_LAYER_FRAGMENT_UTI,
  MAX_IMAGE_DIM_PX,
  type ClipboardLayerFragmentV1 as ClipboardLayerFragmentV1Type,
  type BundleLayerNode
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getCaptureById } from "../persistence/captures-repo";
import {
  readSourceForCapture,
  scheduleRepack
} from "../persistence/bundle-store";
import { insertLayerTreeForCapture, listLayerTree } from "../persistence/layers-repo";
import { broadcastLayersChanged } from "./broadcast-layers";
import { materializePendingSourceForCapture } from "../persistence/pending-source-store";
import { notifyClipboardChanged } from "../clipboard-events";
import { mapVideoResolveError, resolveVideoExport } from "../recording/video-export-resolver";
import { getMainLogger } from "../log";
import { resolveImagePresetFile, targetWidthForImagePreset } from "../render/image-presets";
import { getActiveExportStrategy } from "./settings-handlers";
import { prepareRenderedFileAlias } from "../render/file-alias";
import { buildPresetExportDisplayName } from "../render/export-filename";
import { getCaptureEnrichment } from "../persistence/enrichment-repo";

const log = getMainLogger("pwrsnap:clipboard");

export function registerClipboardHandlers(): void {
  // ── clipboard:copy (v1 + v2) ──────────────────────────────────────
  bus.register("clipboard:copy", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }

    const strategy = await getActiveExportStrategy();
    const targetWidth = targetWidthForImagePreset(req.preset, record, strategy);

    try {
      const result = await resolveImagePresetFile(record, req.preset, strategy);
      const buf = await readFile(result.path);
      const image = nativeImage.createFromBuffer(buf);
      if (image.isEmpty()) {
        return err({
          kind: "render",
          code: "decode_failed",
          message: "nativeImage decoded to empty buffer"
        });
      }
      // Image bytes only. PR #25 originally also wrote a file URL via
      // text+bookmark, but PR #39 reverted that because some consumers
      // (Cursor, certain web apps) preferred the plain-text URL over
      // the image. Native file drag (capture-handlers' drag payload)
      // is the right path for callers that need a file URL.
      clipboard.write({ image });
      // Issue #139 — the "File > New > Paste from Clipboard" menu item
      // relied on `menu-will-show` to refresh, which lagged on macOS
      // after an in-app copy. Fire the event so the menu refresh
      // runs synchronously; renderers can also subscribe via
      // `events:clipboard:changed` if they ever surface a paste
      // affordance in the UI.
      notifyClipboardChanged();
      log.info("copied to clipboard", {
        captureId: record.id,
        preset: req.preset,
        targetWidth,
        byteSize: buf.length,
        fromCache: result.fromCache,
        sourceReused: result.sourceReused
      });
      return ok(undefined);
    } catch (cause) {
      log.error("clipboard copy failed", {
        captureId: record.id,
        preset: req.preset,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "clipboard",
        code: "render_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  // ── clipboard:copy-file (image only): copy named PNG file URL ──────
  bus.register("clipboard:copy-file", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }
    if (record.kind !== "image") {
      return err({
        kind: "validation",
        code: "not_an_image",
        message: `clipboard:copy-file only supports image captures (got kind=${record.kind})`
      });
    }

    const strategy = await getActiveExportStrategy();
    const targetWidth = targetWidthForImagePreset(req.preset, record, strategy);

    try {
      const result = await resolveImagePresetFile(record, req.preset, strategy);
      const displayName = buildPresetExportDisplayName({
        record,
        enrichment: getCaptureEnrichment(record.id),
        preset: req.preset,
        ext: "png"
      });
      const aliasPath = await prepareRenderedFileAlias(result.path, displayName);
      const fileUrl = pathToFileURL(aliasPath).toString();
      clipboard.writeBuffer("public.file-url", Buffer.from(fileUrl, "utf8"));
      notifyClipboardChanged();
      log.info("copied image file to clipboard", {
        captureId: record.id,
        preset: req.preset,
        targetWidth,
        fromCache: result.fromCache,
        sourceReused: result.sourceReused,
        path: aliasPath
      });
      return ok({ path: aliasPath });
    } catch (cause) {
      log.error("clipboard copy-file failed", {
        captureId: record.id,
        preset: req.preset,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "clipboard",
        code: "render_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  // ── clipboard:copy-path (v1 + v2): copy cache file POSIX path ─────
  bus.register("clipboard:copy-path", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }

    const strategy = await getActiveExportStrategy();
    const targetWidth = targetWidthForImagePreset(req.preset, record, strategy);

    try {
      const result = await resolveImagePresetFile(record, req.preset, strategy);
      clipboard.writeText(result.path);
      log.info("copied path to clipboard", {
        captureId: record.id,
        preset: req.preset,
        targetWidth,
        fromCache: result.fromCache,
        sourceReused: result.sourceReused
      });
      return ok({ path: result.path });
    } catch (cause) {
      log.error("clipboard copy-path failed", {
        captureId: record.id,
        preset: req.preset,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "clipboard",
        code: "render_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  // ── clipboard:copyVideoFile (video only) ──────────────────────────
  //
  // Encode (cache-hit if already done) and copy the resulting GIF /
  // MP4 to the system clipboard as a file promise. On macOS this
  // writes the `public.file-url` UTI to NSPasteboard via
  // `clipboard.writeBuffer` — paste in Slack / Mail / iMessage /
  // Finder drops the binary, exactly like Finder's "Copy" + paste.
  //
  // First version tried to ALSO co-write `clipboard.writeText(path)`
  // as a fallback for terminal/editor pastes. Doesn't work: each
  // Electron clipboard.write* call wraps a ScopedClipboardWriter
  // that calls [pasteboard clearContents] on construction. So
  // writeText AFTER writeBuffer wipes the file-url, and iMessage
  // gets the text. There's no Electron API to atomically write
  // both a custom UTI and standard text — `clipboard.write({...})`
  // accepts only text/html/image/rtf/bookmark, no arbitrary UTIs.
  //
  // We pick file-url; users who want the path as text use the FILE
  // chip (which dispatches `clipboard:copyVideoPath`). Clean intent
  // split: card click = "give me the file"; FILE chip = "give me
  // the path".
  bus.register("clipboard:copyVideoFile", async (req) => {
    const resolved = await resolveVideoExport(req);
    if (!resolved.ok) {
      return err(mapVideoResolveError(resolved.error, "clipboard:copyVideoFile", req.captureId));
    }
    try {
      const filePath = resolved.value.result.path;
      const displayName = buildPresetExportDisplayName({
        record: resolved.value.record,
        enrichment: getCaptureEnrichment(req.captureId),
        preset: req.preset,
        ext: req.format
      });
      const aliasPath = await prepareRenderedFileAlias(filePath, displayName);
      // `file://` URL — encode any non-ASCII in the path so the
      // pasteboard payload round-trips cleanly through NSURL parsers.
      const fileUrl = pathToFileURL(aliasPath).toString();
      clipboard.writeBuffer("public.file-url", Buffer.from(fileUrl, "utf8"));
      log.info("copied video file to clipboard", {
        captureId: req.captureId,
        format: req.format,
        preset: req.preset,
        fromCache: resolved.value.result.fromCache,
        path: aliasPath
      });
      return ok({ path: aliasPath });
    } catch (cause) {
      log.error("clipboard:copyVideoFile failed", {
        captureId: req.captureId,
        format: req.format,
        preset: req.preset,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "clipboard",
        code: "video_clipboard_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  // ── clipboard:copyVideoPath (video only) ──────────────────────────
  //
  // Sibling of `clipboard:copy-path` for video: encode, write the
  // resulting POSIX path to the clipboard as text only. Used by the
  // FILE chip click on the new 6-card grid — keyboardless-mouse
  // equivalent of dragging the file, for pasting paths into a
  // terminal or editor.
  bus.register("clipboard:copyVideoPath", async (req) => {
    const resolved = await resolveVideoExport(req);
    if (!resolved.ok) {
      return err(mapVideoResolveError(resolved.error, "clipboard:copyVideoPath", req.captureId));
    }
    try {
      const filePath = resolved.value.result.path;
      clipboard.writeText(filePath);
      log.info("copied video path to clipboard", {
        captureId: req.captureId,
        format: req.format,
        preset: req.preset,
        fromCache: resolved.value.result.fromCache,
        path: filePath
      });
      return ok({ path: filePath });
    } catch (cause) {
      log.error("clipboard:copyVideoPath failed", {
        captureId: req.captureId,
        format: req.format,
        preset: req.preset,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "clipboard",
        code: "video_clipboard_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  // ── clipboard:copyLayerFragment (v2 only) ─────────────────────────
  bus.register("clipboard:copyLayerFragment", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err({ kind: "validation", code: "not_found", message: `capture not found: ${req.captureId}` });
    }
    if (record.bundle_format_version < 2 || record.bundle_path === null) {
      return err({
        kind: "validation",
        code: "v1_capture",
        message: `clipboard:copyLayerFragment requires a v2 capture`
      });
    }

    try {
      // Resolve the selection. If no layerIds specified, take the
      // entire live tree.
      const allLayers = listLayerTree(req.captureId);
      const selectedIds = req.layerIds === undefined ? null : new Set(req.layerIds);
      const layers =
        selectedIds === null ? allLayers : allLayers.filter((n) => selectedIds.has(n.id));

      if (layers.length === 0) {
        return err({
          kind: "validation",
          code: "empty_selection",
          message: "no layers selected for copy"
        });
      }

      // Collect every source sha referenced by any raster layer in
      // the selection. Content-addressable; same sha appearing on
      // multiple layers contributes one source_ref.
      const referencedShas = new Set<string>();
      for (const node of layers) {
        if (node.kind === "raster") referencedShas.add(node.source_ref.sha256);
      }

      // Reparent any layer whose parent_id points OUTSIDE the
      // selection — these become roots in the pasted fragment.
      const selectedIdSet = new Set(layers.map((n) => n.id));
      const reparentedLayers: BundleLayerNode[] = layers.map((node) => {
        if (node.parent_id !== null && !selectedIdSet.has(node.parent_id)) {
          return { ...node, parent_id: null };
        }
        return node;
      });

      // Read source bytes from the bundle. readSourceFromBundle
      // performs sha256 content-integrity verification on the way
      // out — if the bundle was tampered with, the copy refuses.
      const sourceRefs: ClipboardLayerFragmentV1Type["source_refs"] = [];
      for (const sha of referencedShas) {
        const bytes = await readSourceForCapture(record.id, record.bundle_path, sha);
        sourceRefs.push({ sha256: sha, png_base64: bytes.toString("base64") });
      }

      const fragment: ClipboardLayerFragmentV1Type = {
        format_version: 1,
        source_capture_id: req.captureId,
        layers: reparentedLayers,
        source_refs: sourceRefs,
        copied_at: new Date().toISOString()
      };

      // zod-validate the constructed payload before writing — defense
      // in depth, catches programmer errors in this handler.
      ClipboardLayerFragmentV1.parse(fragment);

      const json = JSON.stringify(fragment);
      const buf = Buffer.from(json, "utf-8");
      if (buf.byteLength > CLIPBOARD_FRAGMENT_MAX_BYTES) {
        return err({
          kind: "validation",
          code: "fragment_too_large",
          message: `selection serializes to ${buf.byteLength} bytes (cap ${CLIPBOARD_FRAGMENT_MAX_BYTES})`
        });
      }

      // Write the private UTI buffer for PwrSnap-to-PwrSnap fidelity.
      clipboard.writeBuffer(CLIPBOARD_LAYER_FRAGMENT_UTI, buf);

      // Notify subscribers — the private UTI buffer was written, so
      // the OS clipboard changed under us.
      notifyClipboardChanged();

      log.info("copied layer fragment to clipboard", {
        captureId: req.captureId,
        layerCount: layers.length,
        sourceCount: sourceRefs.length,
        bytes: buf.byteLength
      });

      return ok({
        layerCount: layers.length,
        sourceCount: sourceRefs.length,
        bytes: buf.byteLength
      });
    } catch (cause) {
      log.error("clipboard:copyLayerFragment failed", {
        captureId: req.captureId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "clipboard",
        code: "copy_failed",
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  });

  // ── clipboard:pasteLayerFragment (v2 only) ────────────────────────
  bus.register("clipboard:pasteLayerFragment", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err({ kind: "validation", code: "not_found", message: `capture not found: ${req.captureId}` });
    }
    if (record.bundle_format_version < 2 || record.bundle_path === null) {
      return err({
        kind: "validation",
        code: "v1_capture",
        message: `clipboard:pasteLayerFragment requires a v2 capture`
      });
    }

    // ── Defense (1): size cap before JSON.parse ─────────────────────
    // Read the private fragment buffer DIRECTLY rather than gating on
    // availableFormats(). On macOS a custom UTI that ISN'T registered with
    // the system (dev builds — electron-builder.yml's
    // UTExportedTypeDeclarations only apply to a packaged .app) gets stored
    // on the pasteboard under a *dynamic* UTI alias. availableFormats()
    // then reports the `dyn.…` alias, never the literal
    // `com.pwrdrvr.pwrsnap.layer-fragment`, so the old `=== UTI` match
    // missed and a real fragment fell through to the "clipboard doesn't
    // contain an image" path. readBuffer(UTI) resolves the same dynamic
    // mapping on read, so it returns the bytes whether or not the type is
    // aliased — and an empty Buffer when nothing is there.
    const buf = clipboard.readBuffer(CLIPBOARD_LAYER_FRAGMENT_UTI);
    const hasPrivate = buf.byteLength > 0;

    if (hasPrivate) {
      if (buf.byteLength > CLIPBOARD_FRAGMENT_MAX_BYTES) {
        log.warn("clipboard:paste: oversize fragment rejected", { bytes: buf.byteLength });
        return err({
          kind: "validation",
          code: "fragment_too_large",
          message: `clipboard fragment exceeds size cap`
        });
      }

      // ── Defense (2): JSON.parse + zod ─────────────────────────────
      let parsed: unknown;
      try {
        parsed = JSON.parse(buf.toString("utf-8"));
      } catch {
        return err({
          kind: "validation",
          code: "fragment_not_json",
          message: "clipboard fragment is not valid JSON"
        });
      }
      let fragment: ClipboardLayerFragmentV1Type;
      try {
        fragment = ClipboardLayerFragmentV1.parse(parsed);
      } catch (cause) {
        log.warn("clipboard:paste: fragment failed zod validation", {
          message: cause instanceof Error ? cause.message : "unknown"
        });
        return err({
          kind: "validation",
          code: "fragment_schema_mismatch",
          message: "clipboard fragment failed schema validation"
        });
      }

      // ── Defense (3): sha256 verify each source_ref ────────────────
      // ── Defense (4): sharp decode-probe each pngBytes ─────────────
      const verifiedSources = new Map<string, Buffer>();
      for (const ref of fragment.source_refs) {
        let bytes: Buffer;
        try {
          bytes = Buffer.from(ref.png_base64, "base64");
        } catch {
          return err({
            kind: "validation",
            code: "source_decode_failed",
            message: "clipboard source_ref base64 decode failed"
          });
        }
        const computed = createHash("sha256").update(bytes).digest("hex");
        if (computed !== ref.sha256) {
          // Sanitized: log neither the claimed sha nor the bytes.
          log.warn("clipboard:paste: source content-hash mismatch", { captureId: req.captureId });
          return err({
            kind: "validation",
            code: "source_hash_mismatch",
            message: "clipboard source hash mismatch (refusing to ingest)"
          });
        }
        try {
          const meta = await sharp(bytes).metadata();
          const w = meta.width ?? 0;
          const h = meta.height ?? 0;
          if (w === 0 || h === 0 || w > MAX_IMAGE_DIM_PX || h > MAX_IMAGE_DIM_PX) {
            return err({
              kind: "validation",
              code: "source_invalid_dimensions",
              message: "clipboard source dimensions invalid or exceed cap"
            });
          }
        } catch {
          return err({
            kind: "validation",
            code: "source_sharp_probe_failed",
            message: "clipboard source bytes failed sharp decode probe"
          });
        }
        verifiedSources.set(ref.sha256, bytes);
      }

      // All defenses passed. Materialize new sources into durable
      // pending storage before inserting layers that reference them.
      // The debounced repack folds these into the bundle.
      for (const [sha, bytes] of verifiedSources) {
        await materializePendingSourceForCapture(req.captureId, sha, bytes);
      }

      // Insert the pasted layers with fresh ids so they don't collide
      // with existing rows in the target capture's layers table.
      const now = new Date().toISOString();
      const idRemap = new Map<string, string>();
      const targetParent = req.parentId ?? null;
      for (const node of fragment.layers) {
        idRemap.set(node.id, nanoid(16));
      }

      // Stack the pasted block ABOVE everything already at the destination
      // parent level, preserving the fragment's internal relative order.
      // Otherwise the pasted layers' original z_index values interleave
      // with the target's (e.g. a pasted Source landing between the
      // target's Text and Rectangle). Only the fragment's ROOTS
      // (parent_id === null) land at targetParent and need restacking;
      // nested layers keep their z within their own remapped parent.
      const siblingMaxZ = listLayerTree(req.captureId)
        .filter((l) => (l.parent_id ?? null) === targetParent)
        .reduce((max, l) => Math.max(max, l.z_index), -1);
      const rootNewZ = new Map<string, number>();
      fragment.layers
        .filter((n) => n.parent_id === null)
        .slice()
        .sort((a, b) => a.z_index - b.z_index)
        .forEach((n, i) => rootNewZ.set(n.id, siblingMaxZ + 1 + i));

      const renumberedLayers: BundleLayerNode[] = fragment.layers.map((node) => {
        const newId = idRemap.get(node.id)!;
        const oldParentRemap = node.parent_id === null ? null : idRemap.get(node.parent_id);
        // Layers whose parent was inside the selection get the remapped
        // parent id. Layers whose parent was null (roots in the
        // fragment) point at the target's parentId (or root).
        const newParentId =
          node.parent_id === null
            ? targetParent
            : oldParentRemap !== undefined
              ? oldParentRemap
              : targetParent;
        const newZIndex = rootNewZ.get(node.id) ?? node.z_index;
        // A pasted raster carries the SOURCE capture's base-raster name
        // ("Source"). Clear it so the panel shows it as "Image" and it
        // doesn't masquerade as THIS capture's pinned base layer.
        const renamed =
          node.kind === "raster" && node.name?.trim() === "Source"
            ? { ...node, name: "" }
            : node;
        return {
          ...renamed,
          id: newId,
          parent_id: newParentId,
          z_index: newZIndex,
          applied_at: now,
          created_at: now
        };
      });

      insertLayerTreeForCapture(req.captureId, renumberedLayers);

      // Notify every renderer that this capture's layer tree changed so
      // the editor canvas (and Layers panel) refetch and PAINT the pasted
      // raster immediately. Without this the layer is in the DB but the
      // canvas doesn't refetch until some other edit fires a broadcast —
      // the "pasted image stays invisible until you toggle a layer's
      // visibility" bug. paste mutates the tree outside the layers:*
      // handlers, so it must broadcast on its own.
      broadcastLayersChanged(req.captureId);

      // Schedule a repack so the bundle picks up the new layers +
      // sources.
      scheduleRepack(req.captureId);

      log.info("pasted layer fragment", {
        captureId: req.captureId,
        layerCount: renumberedLayers.length,
        sourceCount: verifiedSources.size,
        sourceCaptureId: fragment.source_capture_id
      });

      return ok({
        insertedLayerIds: renumberedLayers.map((n) => n.id),
        fallbackUsedPng: false
      });
    }

    return ok({
      insertedLayerIds: [],
      fallbackUsedPng: false
    });
  });
}
