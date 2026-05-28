// Clipboard handlers. Three commands:
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
//   • clipboard:copyLayerFragment — v2 only: serializes selected
//     layers + referenced sources into a private UTI buffer
//     (`com.pwrdrvr.pwrsnap.layer-fragment`), co-writes a standard
//     PNG so non-PwrSnap consumers (Slack, Messages, Mail) get a
//     usable image.
//
//   • clipboard:pasteLayerFragment — v2 only: reads the private UTI
//     buffer if present; falls back to the standard PNG image.
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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
import { ensureEffectiveSrcPath } from "../persistence/source-store";
import {
  readSourceFromBundle,
  scheduleRepack
} from "../persistence/bundle-store";
import { renderViaCoordinator } from "../render/coordinator";
import { insertLayerTreeForCapture, listLayerTree } from "../persistence/layers-repo";
import { getCacheSourcePath } from "../persistence/paths";
import { notifyClipboardChanged } from "../clipboard-events";
import { mapVideoResolveError, resolveVideoExport } from "../recording/video-export-resolver";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:clipboard");

const PRESET_WIDTHS = {
  low: 800,
  med: 1440,
  high: 0 // 0 = source width (no resize)
} as const;

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

    const presetWidth = PRESET_WIDTHS[req.preset];
    const targetWidth = presetWidth === 0 ? record.width_px : presetWidth;

    try {
      const result = await renderViaCoordinator({
        captureId: record.id,
        srcPath: await ensureEffectiveSrcPath(record),
        imageWidthPx: record.width_px,
        imageHeightPx: record.height_px,
        width: targetWidth,
        format: "png"
      });
      const buf = await readFile(result.cachePath);
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
        fromCache: result.fromCache
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

    const presetWidth = PRESET_WIDTHS[req.preset];
    const targetWidth = presetWidth === 0 ? record.width_px : presetWidth;

    try {
      const result = await renderViaCoordinator({
        captureId: record.id,
        srcPath: await ensureEffectiveSrcPath(record),
        imageWidthPx: record.width_px,
        imageHeightPx: record.height_px,
        width: targetWidth,
        format: "png"
      });
      clipboard.writeText(result.cachePath);
      log.info("copied path to clipboard", {
        captureId: record.id,
        preset: req.preset,
        targetWidth,
        fromCache: result.fromCache
      });
      return ok({ path: result.cachePath });
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
  // `clipboard.writeBuffer`, so paste in Slack / Mail / Finder
  // drops the binary instead of a path string. Also co-writes the
  // POSIX path as text so terminal / editor pastes get something
  // useful. The two writes don't conflict — apps prefer the
  // higher-fidelity format they understand.
  //
  // This is the first place in the codebase that writes
  // `public.file-url`; matching the pattern in Finder's "Copy" so
  // downstream pasteboard consumers get the shape they expect.
  bus.register("clipboard:copyVideoFile", async (req) => {
    const resolved = await resolveVideoExport(req);
    if (!resolved.ok) {
      return err(mapVideoResolveError(resolved.error, "clipboard:copyVideoFile", req.captureId));
    }
    try {
      const filePath = resolved.value.result.path;
      // `file://` URL — encode any non-ASCII in the path so the
      // pasteboard payload round-trips cleanly through NSURL parsers.
      const fileUrl = `file://${filePath.split("/").map(encodeURIComponent).join("/")}`;
      clipboard.writeBuffer("public.file-url", Buffer.from(fileUrl, "utf8"));
      clipboard.writeText(filePath);
      log.info("copied video file to clipboard", {
        captureId: req.captureId,
        format: req.format,
        preset: req.preset,
        fromCache: resolved.value.result.fromCache,
        path: filePath
      });
      return ok({ path: filePath });
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
        const bytes = await readSourceFromBundle(record.bundle_path, sha);
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

      // Co-write a standard PNG so non-PwrSnap consumers get a usable
      // image when pasting elsewhere. We render the current composite
      // at source-equivalent width.
      try {
        const renderResult = await renderViaCoordinator({
          captureId: record.id,
          srcPath: await ensureEffectiveSrcPath(record),
          imageWidthPx: record.width_px,
          imageHeightPx: record.height_px,
          width: record.width_px,
          format: "png"
        });
        const pngBuf = await readFile(renderResult.cachePath);
        const image = nativeImage.createFromBuffer(pngBuf);
        if (!image.isEmpty()) {
          clipboard.writeImage(image);
        }
      } catch (cause) {
        // Non-fatal: the private UTI buffer is already on the
        // clipboard. Just log.
        log.warn("clipboard:copyLayerFragment: PNG fallback write failed", {
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }

      // Notify subscribers — the UTI buffer is always written; the
      // PNG fallback may have succeeded or not. Either way the OS
      // clipboard changed under us.
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
    const hasPrivate = clipboard
      .availableFormats()
      .some((fmt) => fmt === CLIPBOARD_LAYER_FRAGMENT_UTI);

    if (hasPrivate) {
      const buf = clipboard.readBuffer(CLIPBOARD_LAYER_FRAGMENT_UTI);
      if (buf.byteLength === 0) {
        return err({ kind: "clipboard", code: "empty_buffer", message: "private UTI buffer was empty" });
      }
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

      // All defenses passed. Materialize new sources into the target
      // capture's cache (so subsequent renders find them without
      // round-tripping through readSourceFromBundle).
      for (const [sha, bytes] of verifiedSources) {
        // Cache under the receiving capture's id. This isn't strictly
        // content-addressable by capture, but storing under the
        // receiving id keeps cleanup tied to the capture's lifecycle.
        // Future: a shared content-addressed cache.
        const cachePath = getCacheSourcePath(req.captureId);
        await mkdir(dirname(cachePath), { recursive: true });
        // Use the existing cache slot if the sha matches; else write
        // alongside under the sha as the filename.
        const sourceCachePath = cachePath.replace(/source\.png$/, `${sha}.png`);
        await writeFile(sourceCachePath, bytes);
      }

      // Insert the pasted layers with fresh ids so they don't collide
      // with existing rows in the target capture's layers table.
      const now = new Date().toISOString();
      const idRemap = new Map<string, string>();
      const targetParent = req.parentId ?? null;
      for (const node of fragment.layers) {
        idRemap.set(node.id, nanoid(16));
      }
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
        return { ...node, id: newId, parent_id: newParentId, applied_at: now, created_at: now };
      });

      insertLayerTreeForCapture(req.captureId, renumberedLayers);

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

    // No private UTI on the clipboard. Fall back to standard PNG —
    // create a new raster layer from the clipboard image bytes.
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return err({
        kind: "clipboard",
        code: "no_image_or_fragment",
        message: "clipboard has neither a PwrSnap fragment nor a PNG image"
      });
    }
    try {
      const pngBuf = image.toPNG();
      // Defense (4) applies here too — though the image came from
      // Electron's NativeImage rather than an attacker JSON, decode
      // probing keeps the contract uniform.
      const meta = await sharp(pngBuf).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      if (w === 0 || h === 0 || w > MAX_IMAGE_DIM_PX || h > MAX_IMAGE_DIM_PX) {
        return err({
          kind: "validation",
          code: "source_invalid_dimensions",
          message: "clipboard image dimensions invalid or exceed cap"
        });
      }
      const sha = createHash("sha256").update(pngBuf).digest("hex");
      const cachePath = getCacheSourcePath(req.captureId).replace(/source\.png$/, `${sha}.png`);
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, pngBuf);

      const now = new Date().toISOString();
      const rasterId = nanoid(16);
      const rasterLayer: BundleLayerNode = {
        id: rasterId,
        parent_id: req.parentId ?? null,
        kind: "raster",
        source_ref: { kind: "embedded", sha256: sha },
        natural_width_px: w,
        natural_height_px: h,
        name: "Pasted Image",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: 0,
        source: "user",
        ai_run_id: null,
        applied_at: now,
        rejected_at: null,
        superseded_by: null,
        created_at: now
      };
      insertLayerTreeForCapture(req.captureId, [rasterLayer]);
      scheduleRepack(req.captureId);

      log.info("pasted PNG fallback as raster layer", {
        captureId: req.captureId,
        rasterId,
        widthPx: w,
        heightPx: h
      });

      return ok({
        insertedLayerIds: [rasterId],
        fallbackUsedPng: true
      });
    } catch (cause) {
      log.error("clipboard:pasteLayerFragment PNG fallback failed", {
        captureId: req.captureId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "clipboard",
        code: "paste_failed",
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  });
}

