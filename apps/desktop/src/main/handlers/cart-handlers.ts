// Command-bus handlers for the `cart:*` namespace — the Project Asset
// Cart. The cart is a single global draft (see `CartStore`); the
// commit verbs turn it into a Sizzle Reel project.
//
// Every mutating verb broadcasts `events:cart:changed` so the Library
// cell checkboxes + DetailRail Cart tab stay in sync without polling.
// The two commit verbs ALSO broadcast `events:sizzle:projects:changed`
// because they create / mutate a project the sidebar renders.

import { app, BrowserWindow, dialog, shell } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import yazl from "yazl";
import {
  EVENT_CHANNELS,
  err,
  ok,
  slugifyFilenameStem,
  type CartExportProgressEvent,
  type CaptureRecord,
  type DraftCart,
  type EventPayloads,
  type RenderPreset,
  type SizzleProject,
  type SizzleScene
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getCartStore } from "../cart/cart-store";
import { getSizzleStore, SizzleProjectNotFoundError } from "../sizzle/sizzle-store";
import { getCaptureById } from "../persistence/captures-repo";
import { getCaptureEnrichment } from "../persistence/enrichment-repo";
import { resolveImagePresetFile } from "../render/image-presets";
import { composeCartDragIcon } from "../render/cart-drag-icon";
import { exportFilenameStem } from "../render/export-filename";
import { findMainLibraryWindow } from "../window";
import { getMainLogger } from "../log";
import {
  validateCartCaptureId,
  validateCartCommitToExisting,
  validateCartCommitToNew,
  validateCartExportZip,
  validateCartExportZipCancel,
  validateCartPrepareZipDrag,
  validateCartRename,
  validateCartReorder
} from "./cart-validators";

const log = getMainLogger("pwrsnap:cart-handlers");

/**
 * In-flight `cart:exportZip` jobs keyed by their renderer-minted `jobId`.
 * `cart:exportZip:cancel` aborts the matching controller; the export loop
 * checks `signal.aborted` between renders and bails. The handler deletes
 * its own entry in a `finally`, so a stale id never accumulates.
 */
const exportJobs = new Map<string, AbortController>();

function broadcastCartExportProgress(event: CartExportProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.cartExportProgress, event);
  }
}

// Drag-out temp artifacts (zip + cursor thumbnail) live here. Named by a
// content hash of (capture id + edits_version + preset), so re-dragging the
// SAME cart reuses the file (instant, no re-render) and two different carts
// never collide. Pruned by age on each prepare so they don't pile up — the
// OS would eventually sweep $TMPDIR, but not promptly.
function cartDragTempDir(): string {
  return join(app.getPath("temp"), "pwrsnap-cart-export");
}

/** Drag temp files older than this are deleted on the next prepare. A drag's
 *  drop completes in seconds, so anything this old is certainly finished. */
const CART_DRAG_TEMP_MAX_AGE_MS = 10 * 60_000;

/** Content key for a (cart, preset) — same images+edits+preset → same file. */
function cartDragKey(records: CaptureRecord[], preset: RenderPreset): string {
  const sig = records.map((r) => `${r.id}:${r.edits_version}`).join(",") + `:${preset}`;
  return createHash("sha1").update(sig).digest("hex").slice(0, 8);
}

/** Best-effort prune of drag temp files older than `maxAgeMs`. Never throws —
 *  a missing/unreadable dir or a racing delete just means nothing to do. */
async function pruneCartDragTemp(dir: string, maxAgeMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // dir doesn't exist yet / unreadable
  }
  const now = Date.now();
  await Promise.all(
    entries.map(async (name) => {
      const p = join(dir, name);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > maxAgeMs) await rm(p, { force: true });
      } catch {
        // racing delete / stat failure — ignore
      }
    })
  );
}

/** Resolve cart ids to exportable image records, counting the ones filtered
 *  out (soft-deleted, purged, or non-image). Shared by the dialog export
 *  (`cart:exportZip`) and the drag-out (`cart:prepareZipDrag`) so both apply
 *  the identical skip rule. */
function resolveExportableImages(captureIds: string[]): {
  records: CaptureRecord[];
  skipped: number;
} {
  const records: CaptureRecord[] = [];
  let skipped = 0;
  for (const id of captureIds) {
    const rec = getCaptureById(id);
    if (rec === null || rec.deleted_at !== null || rec.kind !== "image") {
      skipped++;
      continue;
    }
    records.push(rec);
  }
  return { records, skipped };
}

type CartZipProgress = { phase: "rendering" | "zipping"; completed: number; total: number };
type CartZipOutcome = {
  fileCount: number;
  failed: number;
  cancelled: boolean;
  /** First image rendered into the zip — used as the drag cursor icon. */
  firstPath: string | null;
};

/**
 * Render `records` at `preset` and write a flat zip to `destPath`. Each PNG is
 * stored (already compressed); entry names are re-slugified (zip-slip defense)
 * and collision-suffixed so no entry overwrites another. One unrenderable
 * image is counted in `failed`, not fatal. Honors `signal` between renders
 * (bails with `cancelled: true`, writing nothing). Fires `onProgress` per
 * render plus once for the write. When zero images render, the zip is NOT
 * written. Shared by the dialog export and the drag-out.
 */
async function writeCartZip(
  records: CaptureRecord[],
  preset: RenderPreset,
  destPath: string,
  opts: { signal?: AbortSignal; onProgress?: (p: CartZipProgress) => void } = {}
): Promise<CartZipOutcome> {
  const total = records.length;
  const zip = new yazl.ZipFile();
  const usedNames = new Set<string>();
  let fileCount = 0;
  let failed = 0;
  let firstPath: string | null = null;
  opts.onProgress?.({ phase: "rendering", completed: 0, total });
  for (const rec of records) {
    if (opts.signal?.aborted) return { fileCount, failed, cancelled: true, firstPath };
    try {
      // Renders use the default (legacy) export ladder — same mapping the
      // renderer's cart estimate uses, so the shown ~size matches the zip.
      // (DPI-aware-export-for-zip is a future enhancement.)
      const file = await resolveImagePresetFile(rec, preset);
      if (firstPath === null) firstPath = file.path;
      const stem = slugifyFilenameStem(exportFilenameStem(rec, getCaptureEnrichment(rec.id)));
      let entry = `${stem}-${preset}.png`;
      let n = 2;
      while (usedNames.has(entry)) {
        entry = `${stem}-${preset}-${n}.png`;
        n++;
      }
      usedNames.add(entry);
      zip.addFile(file.path, entry, { compress: false });
      fileCount++;
    } catch (cause) {
      // One unrenderable image (corrupt source, etc.) must not sink the whole
      // export — skip it, count it, keep going.
      failed++;
      log.warn("cart zip: skipping unrenderable capture", {
        id: rec.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    opts.onProgress?.({ phase: "rendering", completed: fileCount + failed, total });
  }
  // A cancel landing after the last render but before the write still counts.
  if (opts.signal?.aborted) return { fileCount, failed, cancelled: true, firstPath };
  if (fileCount === 0) return { fileCount, failed, cancelled: false, firstPath };
  opts.onProgress?.({ phase: "zipping", completed: total, total });
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(destPath);
    ws.on("error", reject);
    ws.on("close", () => resolve());
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(ws);
    zip.end();
  });
  return { fileCount, failed, cancelled: false, firstPath };
}

function broadcastCartChanged(cart: DraftCart): void {
  const payload: EventPayloads[typeof EVENT_CHANNELS.cartChanged] = { cart };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.cartChanged, payload);
  }
}

function broadcastProjectsChanged(projects: SizzleProject[]): void {
  const payload: EventPayloads[typeof EVENT_CHANNELS.sizzleProjectsChanged] = {
    projects
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.sizzleProjectsChanged, payload);
  }
}

/**
 * Build a fresh scene for a capture id. Mirrors `sizzle:toggleScene`'s
 * scene defaults — empty scriptLine (the chat agent or the user fills
 * it later), no media trim (seeded from the capture's video metadata
 * at render time if it's a video), auto audio source, crossfade
 * transition (the visual default).
 */
function newSceneForCapture(captureId: string): SizzleScene {
  return {
    id: `sc_${randomUUID().slice(0, 10)}`,
    captureId,
    scriptLine: "",
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "auto",
    transition: "crossfade"
  };
}

export function registerCartHandlers(): void {
  const cart = getCartStore();
  const sizzle = getSizzleStore();

  bus.register("cart:get", async () => {
    return ok(await cart.get());
  });

  bus.register("cart:toggle", async (req) => {
    const v = validateCartCaptureId(req);
    if (!v.ok) return err(v.error);
    const next = await cart.toggle(v.captureId);
    broadcastCartChanged(next);
    return ok(next);
  });

  bus.register("cart:remove", async (req) => {
    const v = validateCartCaptureId(req);
    if (!v.ok) return err(v.error);
    const next = await cart.remove(v.captureId);
    broadcastCartChanged(next);
    return ok(next);
  });

  bus.register("cart:reorder", async (req) => {
    const v = validateCartReorder(req);
    if (!v.ok) return err(v.error);
    const next = await cart.reorder(v.from, v.to);
    broadcastCartChanged(next);
    return ok(next);
  });

  bus.register("cart:rename", async (req) => {
    const v = validateCartRename(req);
    if (!v.ok) return err(v.error);
    const next = await cart.rename(v.name);
    broadcastCartChanged(next);
    return ok(next);
  });

  bus.register("cart:clear", async () => {
    const next = await cart.clear();
    broadcastCartChanged(next);
    return ok(next);
  });

  bus.register("cart:commitToNewProject", async (req) => {
    const v = validateCartCommitToNew(req);
    if (!v.ok) return err(v.error);
    const current = await cart.get();
    if (current.captureIds.length === 0) {
      return err({
        kind: "validation",
        code: "cart_empty",
        message: "The cart is empty — add captures before creating a reel"
      });
    }
    const projectName = (v.name ?? current.name).trim() || "Untitled Sizzle";
    try {
      // Create the project, then set its scenes from the cart order in
      // a single update. `store.update` runs sanitizeScenes so the
      // shape is normalized.
      const created = await sizzle.create(projectName);
      const scenes = current.captureIds.map(newSceneForCapture);
      const updated = await sizzle.update(created.id, { scenes });
      // Cart did its job — clear it. (Clear AFTER the project write
      // succeeds so a failed create doesn't lose the user's cart.)
      const clearedCart = await cart.clear();
      broadcastCartChanged(clearedCart);
      broadcastProjectsChanged(await sizzle.list());
      return ok(updated);
    } catch (cause) {
      log.warn("cart:commitToNewProject failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "render",
        code: "cart_commit_failed",
        message: "Could not create the Sizzle Reel from the cart"
      });
    }
  });

  bus.register("cart:commitToExisting", async (req) => {
    const v = validateCartCommitToExisting(req);
    if (!v.ok) return err(v.error);
    const current = await cart.get();
    if (current.captureIds.length === 0) {
      return err({
        kind: "validation",
        code: "cart_empty",
        message: "The cart is empty — add captures before adding to a reel"
      });
    }
    try {
      const project = await sizzle.get(v.projectId);
      if (project === null) {
        return err({
          kind: "validation",
          code: "not_found",
          message: "Project not found"
        });
      }
      // De-dup: only append captures not already scenes of the project.
      // (Duplicate captures ARE legal in a reel — a user can show the
      // same shot twice — but the "Add to existing" affordance is a
      // bulk-merge, where the user expects "add the ones that aren't
      // already here" rather than silently doubling existing scenes.)
      const existing = new Set(project.scenes.map((s) => s.captureId));
      const toAppend = current.captureIds.filter((id) => !existing.has(id));
      const scenes = [
        ...project.scenes,
        ...toAppend.map(newSceneForCapture)
      ];
      const updated = await sizzle.update(project.id, { scenes });
      const clearedCart = await cart.clear();
      broadcastCartChanged(clearedCart);
      broadcastProjectsChanged(await sizzle.list());
      return ok(updated);
    } catch (cause) {
      if (cause instanceof SizzleProjectNotFoundError) {
        return err({
          kind: "validation",
          code: "not_found",
          message: "Project not found"
        });
      }
      log.warn("cart:commitToExisting failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "render",
        code: "cart_commit_failed",
        message: "Could not add the cart to the Sizzle Reel"
      });
    }
  });

  // Export the cart's images as one Zip at a chosen preset size. Does NOT
  // mutate the cart (you can zip, then still build a reel from the same
  // selection). Image-only — videos/trashed/missing are skipped + counted.
  bus.register("cart:exportZip:cancel", async (req) => {
    const v = validateCartExportZipCancel(req);
    if (!v.ok) return err(v.error);
    const controller = exportJobs.get(v.jobId);
    if (controller === undefined) return ok({ cancelled: false });
    controller.abort();
    return ok({ cancelled: true });
  });

  bus.register("cart:exportZip", async (req, ctx) => {
    const v = validateCartExportZip(req);
    if (!v.ok) return err(v.error);

    const { records, skipped } = resolveExportableImages(v.captureIds);
    if (records.length === 0) {
      return err({
        kind: "validation",
        code: "nothing_to_export",
        message: "No exportable images in the cart"
      });
    }

    // Default filename: the caller's suggestion (slugified) or a generic.
    const suggestedSlug =
      v.suggestedName !== undefined ? slugifyFilenameStem(v.suggestedName) : "";
    const baseName = suggestedSlug.length > 0 ? suggestedSlug : `pwrsnap-${records.length}-images`;
    // Parent the save sheet to the Library window when it's open (it's the
    // one that owns the cart), falling back to whatever's focused.
    const win =
      findMainLibraryWindow() ??
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows()[0] ??
      null;
    const saveOpts = {
      defaultPath: `${baseName}-${v.preset}.zip`,
      filters: [{ name: "Zip Archive", extensions: ["zip"] }]
    };
    const dialogResult =
      win !== null ? await dialog.showSaveDialog(win, saveOpts) : await dialog.showSaveDialog(saveOpts);
    if (
      dialogResult.canceled ||
      dialogResult.filePath === undefined ||
      dialogResult.filePath.length === 0
    ) {
      return err({ kind: "validation", code: "cancelled", message: "Export cancelled" });
    }
    const destPath = dialogResult.filePath;
    // Write to a sibling temp file then move it into place — the user never
    // sees a half-written .zip at the chosen path, and a same-dir rename is
    // atomic. rm-then-rename keeps it cross-platform (Windows rename won't
    // overwrite; the save dialog already confirmed the overwrite).
    const tmpPath = join(
      dirname(destPath),
      `.${basename(destPath)}.tmp-${randomUUID().slice(0, 8)}`
    );

    // Register the job so `cart:exportZip:cancel` can abort the render loop.
    // Cancellation only covers the slow part (rendering + zip write); the
    // save dialog above is window-modal, so the renderer can't reach the
    // Cancel button until rendering starts. Combine with the bus signal so a
    // process-level cancel bails too.
    const controller = new AbortController();
    exportJobs.set(v.jobId, controller);
    const signal = AbortSignal.any([controller.signal, ctx.signal]);
    let lastTotal = records.length;

    try {
      const result = await writeCartZip(records, v.preset, tmpPath, {
        signal,
        onProgress: (p) => {
          lastTotal = p.total;
          broadcastCartExportProgress({
            jobId: v.jobId,
            phase: p.phase,
            completed: p.completed,
            total: p.total
          });
        }
      });
      if (result.cancelled) {
        await rm(tmpPath, { force: true }).catch(() => undefined);
        return err({ kind: "validation", code: "cancelled", message: "Export cancelled" });
      }
      if (result.fileCount === 0) {
        return err({
          kind: "render",
          code: "export_failed",
          message: "Could not render any images for the Zip"
        });
      }
      // Move into place. POSIX `rename` overwrites atomically (no window
      // where the user's existing file is gone); only fall back to
      // rm-then-rename on Windows, where rename onto an existing file
      // throws (the save dialog already confirmed the overwrite).
      try {
        await rename(tmpPath, destPath);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | null)?.code;
        if (code === "EEXIST" || code === "EPERM") {
          await rm(destPath, { force: true });
          await rename(tmpPath, destPath);
        } else {
          throw cause;
        }
      }
      const stats = await stat(destPath);
      shell.showItemInFolder(destPath);
      return ok({
        path: destPath,
        fileCount: result.fileCount,
        byteSize: stats.size,
        skipped,
        failed: result.failed
      });
    } catch (cause) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      log.warn("cart:exportZip failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({ kind: "render", code: "export_failed", message: "Could not build the Zip" });
    } finally {
      exportJobs.delete(v.jobId);
      // Terminal beat — every window clears its progress UI regardless of
      // outcome (the dispatch result carries the real success/cancel/error).
      broadcastCartExportProgress({ jobId: v.jobId, phase: "done", completed: lastTotal, total: lastTotal });
    }
  });

  // Drag-the-Zip-out: render + zip to a temp file (no save dialog, no
  // progress UI) and hand the path back to the IPC drag bridge, which calls
  // WebContents.startDrag. Mirrors `capture:prepareDrag` / `video:prepareDrag`.
  bus.register("cart:prepareZipDrag", async (req) => {
    const v = validateCartPrepareZipDrag(req);
    if (!v.ok) return err(v.error);

    const { records } = resolveExportableImages(v.captureIds);
    if (records.length === 0) {
      return err({
        kind: "validation",
        code: "nothing_to_export",
        message: "No exportable images in the cart"
      });
    }
    const suggestedSlug =
      v.suggestedName !== undefined ? slugifyFilenameStem(v.suggestedName) : "";
    const baseName = suggestedSlug.length > 0 ? suggestedSlug : `pwrsnap-${records.length}-images`;
    // Temp files the OS copies during the drag, named so the dropped file
    // reads nicely. The content hash makes the name stable per (cart, preset):
    // re-dragging the same cart reuses the file; different carts never collide.
    const dir = cartDragTempDir();
    const key = cartDragKey(records, v.preset);
    const zipPath = join(dir, `${baseName}-${v.preset}-${key}.zip`);
    const iconDest = join(dir, `${baseName}-${v.preset}-${key}-drag.png`);
    try {
      await mkdir(dir, { recursive: true });
      // Sweep stale artifacts (this session's earlier drags + anything left
      // from a prior run) before adding a new one.
      await pruneCartDragTemp(dir, CART_DRAG_TEMP_MAX_AGE_MS);

      // Reuse an already-built zip for the identical cart+preset — the heavy
      // render+zip only happens on the first drag of a given cart state, so
      // repeat drags fire startDrag immediately (mitigates the cold-drag
      // latency where a slow prepare can outlive the native drag gesture).
      if (existsSync(zipPath)) {
        const iconPath = existsSync(iconDest) ? iconDest : null;
        // fileCount is informational and unused by the drag bridge; the cached
        // badge already bakes in the real count.
        return ok({ path: zipPath, fileCount: records.length, iconPath });
      }

      const result = await writeCartZip(records, v.preset, zipPath);
      if (result.fileCount === 0) {
        return err({
          kind: "render",
          code: "export_failed",
          message: "Could not render any images for the Zip"
        });
      }
      // Compose the drag cursor thumbnail: first image as a cover photo with
      // an orange count badge + ZIP chip. Best-effort — fall back to the raw
      // first image (the IPC bridge still scales it down) if it can't build.
      let iconPath = result.firstPath;
      if (result.firstPath !== null) {
        try {
          await composeCartDragIcon({
            imagePath: result.firstPath,
            count: result.fileCount,
            destPath: iconDest
          });
          iconPath = iconDest;
        } catch (cause) {
          log.warn("cart:prepareZipDrag: drag icon compose failed", {
            message: cause instanceof Error ? cause.message : String(cause)
          });
        }
      }
      return ok({ path: zipPath, fileCount: result.fileCount, iconPath });
    } catch (cause) {
      log.warn("cart:prepareZipDrag failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "render",
        code: "export_failed",
        message: "Could not build the Zip for dragging"
      });
    }
  });
}
