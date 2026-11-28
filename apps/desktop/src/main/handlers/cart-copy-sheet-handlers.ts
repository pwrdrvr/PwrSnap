// Cart export verbs beside the Zip: Copy all (every image on the clipboard as
// separate files) and Contact sheet (every image on one PNG). Both reuse the
// Zip's skip rule, render loop, job registry and progress broadcast, so one
// Cancel button and one progress bar serve all three modes.

import { BrowserWindow, dialog, nativeImage, shell } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  err,
  ok,
  slugifyFilenameStem,
  type CaptureRecord,
  type ContactSheetLayout,
  type ContactSheetSize,
  type PwrSnapError,
  type RenderPreset
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getCaptureEnrichment } from "../persistence/enrichment-repo";
import {
  renderCartImages,
  resolveExportableImages,
  uniqueFileNames,
  type CartRenderedImage
} from "../cart/cart-render";
import {
  broadcastCartExportProgress,
  cartClipboardDir,
  cartDragTempDir,
  CART_DRAG_TEMP_MAX_AGE_MS,
  exportJobs,
  pruneCartDragTemp
} from "../cart/cart-export-jobs";
import { bakeContactSheet } from "../cart/contact-sheet-bake";
import { prepareRenderedFileAlias } from "../render/file-alias";
import { buildPastedImageDisplayName } from "../render/export-filename";
import { composeCartDragIcon } from "../render/cart-drag-icon";
import {
  resolvePasteboardWriterPath,
  writeNamedPngToPasteboard,
  writeNamedPngsToPasteboard
} from "../clipboard/named-image-pasteboard";
import { PasteboardTimeoutError } from "../clipboard/pasteboard-timeout";
import { writeFilesToClipboard } from "../clipboard/file-clipboard";
import { writeClipboardImage } from "../clipboard/system-clipboard";
import { notifyClipboardChanged } from "../clipboard-events";
import { findMainLibraryWindow } from "../window";
import { getMainLogger } from "../log";
import {
  MAX_CONTACT_SHEET_IMAGES,
  MAX_COPY_ALL_IMAGES,
  validateCartContactSheet,
  validateCartCopyAll,
  validateCartPrepareFilesDrag,
  validateCartPrepareSheetDrag
} from "./cart-validators";

const log = getMainLogger("pwrsnap:cart-copy-sheet");

const NOTHING_TO_EXPORT: PwrSnapError = {
  kind: "validation",
  code: "nothing_to_export",
  message: "No exportable images in the cart"
};
const CANCELLED: PwrSnapError = { kind: "validation", code: "cancelled", message: "Export cancelled" };

/** The image caps count what survives the skip rule — the same number the
 *  cart panel shows and caps on — so videos in the cart never trip them. */
function tooManyImages(count: number, max: number, what: string): PwrSnapError | null {
  if (count <= max) return null;
  return { kind: "validation", code: "too_many", message: `${what} takes up to ${max} images` };
}

/** Friendly-named copies of the rendered PNGs (the names a paste shows), made
 *  unique so pasting several into one folder never asks to replace a file. */
async function prepareCopyAliases(
  rendered: readonly CartRenderedImage[],
  preset: RenderPreset
): Promise<string[]> {
  const names = uniqueFileNames(
    rendered.map(({ record }) =>
      buildPastedImageDisplayName({ record, enrichment: getCaptureEnrichment(record.id), preset })
    )
  );
  const aliases: string[] = [];
  for (const [index, { path }] of rendered.entries()) {
    aliases.push(await prepareRenderedFileAlias(path, names[index]!));
  }
  return aliases;
}

/**
 * Put several PNG files on the clipboard so one paste delivers all of them.
 * macOS: one pasteboard item per image (PNG bytes + file URL), the same shape
 * a single copy writes. Windows / Linux: the platform's file-list flavor.
 */
async function writeImageFilesToClipboard(paths: readonly string[], metaJson: string): Promise<void> {
  if (process.platform === "darwin") {
    const written = await writeNamedPngsToPasteboard({
      items: paths.map((path) => ({ pngPath: path, fileUrlPath: path })),
      metaJson
    });
    if (!written) {
      // False means either no helper at all or a helper that ran and failed;
      // only the first is fixed by reinstalling.
      throw new Error(
        resolvePasteboardWriterPath() === null
          ? "Copying several images needs PwrSnap's pasteboard helper. Reinstall PwrSnap."
          : "Could not put the images on the clipboard."
      );
    }
    return;
  }
  await writeFilesToClipboard(paths);
}

let copySeq = 0;

function clipboardError(cause: unknown, code: string): PwrSnapError {
  return {
    kind: "clipboard",
    code: cause instanceof PasteboardTimeoutError ? "clipboard_timeout" : code,
    message: cause instanceof Error ? cause.message : String(cause)
  };
}

/** Register an export job; returns its signal and a release for `finally`. */
function startJob(jobId: string, busSignal: AbortSignal): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  exportJobs.set(jobId, controller);
  return {
    signal: AbortSignal.any([controller.signal, busSignal]),
    release: () => {
      exportJobs.delete(jobId);
    }
  };
}

function sheetBaseName(suggestedName: string | undefined, imageCount: number): string {
  const slug = suggestedName !== undefined ? slugifyFilenameStem(suggestedName) : "";
  return slug.length > 0 ? slug : `${imageCount}-images`;
}

type BuiltSheet = {
  path: string;
  width: number;
  height: number;
  imageCount: number;
  failed: number;
  scaledDown: boolean;
};

/** Content key for a sheet — same images + edits + size + layout → same file. */
function sheetKey(records: readonly CaptureRecord[], size: ContactSheetSize, layout: ContactSheetLayout): string {
  const sig =
    records.map((r) => `${r.id}:${r.edits_version}`).join(",") +
    `|${size}|${String(layout.columns)}|${layout.spacing}|${layout.background}`;
  return createHash("sha1").update(sig).digest("hex").slice(0, 10);
}

/**
 * Render the cart's images at High and bake the sheet into the cart temp
 * dir, in a per-sheet folder so the file itself keeps a friendly name. An
 * identical sheet built in the last few minutes is reused as is.
 */
async function buildSheet(args: {
  records: readonly CaptureRecord[];
  size: ContactSheetSize;
  layout: ContactSheetLayout;
  suggestedName: string | undefined;
  signal?: AbortSignal;
  onProgress?: (phase: "rendering" | "composing", completed: number, total: number) => void;
}): Promise<BuiltSheet | "cancelled" | "none_rendered"> {
  const root = cartDragTempDir();
  await mkdir(root, { recursive: true });
  await pruneCartDragTemp(root, CART_DRAG_TEMP_MAX_AGE_MS);
  const dir = join(root, `sheet-${sheetKey(args.records, args.size, args.layout)}`);
  const fileName = `PwrSnap-${sheetBaseName(args.suggestedName, args.records.length)}-contact-sheet-${args.size}.png`;
  const sheetPath = join(dir, fileName);
  const infoPath = join(dir, "sheet.json");
  try {
    const info = JSON.parse(await readFile(infoPath, "utf8")) as Omit<BuiltSheet, "path">;
    await stat(sheetPath);
    // Reusing the sheet restarts its prune clock: the age prune reads the
    // folder's mtime, which a reuse would otherwise leave at the first build,
    // so a sheet reused at minute 9 could vanish mid-drag.
    const now = new Date();
    await utimes(dir, now, now).catch(() => undefined);
    return { ...info, path: sheetPath };
  } catch {
    // not built yet (or half-built) — build it
  }

  const total = args.records.length;
  const outcome = await renderCartImages(args.records, "high", {
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    onProgress: (p) => args.onProgress?.("rendering", p.completed, p.total)
  });
  if (outcome.cancelled) return "cancelled";
  if (outcome.rendered.length === 0) return "none_rendered";
  args.onProgress?.("composing", total, total);

  await mkdir(dir, { recursive: true });
  const staging = join(dir, `.sheet-${randomUUID()}.png`);
  try {
    const { plan } = await bakeContactSheet({
      imagePaths: outcome.rendered.map((r) => r.path),
      size: args.size,
      layout: args.layout,
      destPath: staging,
      ...(args.signal !== undefined ? { signal: args.signal } : {})
    });
    await rename(staging, sheetPath);
    const info: Omit<BuiltSheet, "path"> = {
      width: plan.width,
      height: plan.height,
      imageCount: outcome.rendered.length,
      failed: outcome.failed,
      scaledDown: plan.scaledDown
    };
    await writeFile(infoPath, JSON.stringify(info));
    return { ...info, path: sheetPath };
  } catch (cause) {
    if (args.signal?.aborted) return "cancelled";
    throw cause;
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
}

/** Copy `source` to the user's chosen `destPath` through a sibling temp file
 *  and a rename, so the user never sees a half-written file there. */
async function publishTo(source: string, destPath: string): Promise<void> {
  const tmpPath = join(dirname(destPath), `.${basename(destPath)}.tmp-${randomUUID().slice(0, 8)}`);
  try {
    await copyFile(source, tmpPath);
    try {
      await rename(tmpPath, destPath);
    } catch (cause) {
      // Windows rename won't overwrite; the save dialog already confirmed it.
      const code = (cause as NodeJS.ErrnoException | null)?.code;
      if (code !== "EEXIST" && code !== "EPERM") throw cause;
      await rm(destPath, { force: true });
      await rename(tmpPath, destPath);
    }
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

function parentWindow(): BrowserWindow | null {
  return (
    findMainLibraryWindow() ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  );
}

async function askSavePath(defaultName: string): Promise<string | null> {
  const win = parentWindow();
  const opts = { defaultPath: defaultName, filters: [{ name: "PNG Image", extensions: ["png"] }] };
  const result = win !== null ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (result.canceled || result.filePath === undefined || result.filePath.length === 0) return null;
  return result.filePath;
}

/** Copy the sheet out of the age-pruned build folder into the clipboard
 *  folder, which holds only the latest copied sheet and is never pruned by
 *  age — a pasteboard file URL must outlive the 10-minute drag-temp prune.
 *  Returns the clipboard copy's path. */
async function stageClipboardSheet(path: string): Promise<string> {
  const dir = cartClipboardDir();
  await mkdir(dir, { recursive: true });
  const name = basename(path);
  const dest = join(dir, name);
  await publishTo(path, dest);
  // One sheet fits on the clipboard: drop the earlier ones. Dot files are
  // another copy's in-flight temp files.
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (entry === name || entry.startsWith(".")) continue;
    await rm(join(dir, entry), { force: true }).catch(() => undefined);
  }
  return dest;
}

/** Copy one PNG as an image: named PNG + file URL on macOS (pastes with its
 *  name, like a single snap), image bytes elsewhere. */
async function copySheetImage(path: string, imageCount: number): Promise<void> {
  copySeq += 1;
  const metaJson = JSON.stringify({ kind: "contact-sheet", imageCount, seq: copySeq, ts: Date.now(), pid: process.pid });
  if (await writeNamedPngToPasteboard({ pngPath: path, fileUrlPath: path, metaJson })) return;
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) throw new Error("The contact sheet did not decode.");
  await writeClipboardImage(image);
}

/** Errors before the clipboard write are export failures; only the write
 *  itself is a clipboard failure. */
function exportError(message: string): PwrSnapError {
  return { kind: "render", code: "export_failed", message };
}

export function registerCartCopyAndSheetHandlers(): void {
  bus.register("cart:copyAll", async (req, ctx) => {
    const v = validateCartCopyAll(req);
    if (!v.ok) return err(v.error);
    const { records, skipped } = resolveExportableImages(v.captureIds);
    if (records.length === 0) return err(NOTHING_TO_EXPORT);
    const overCap = tooManyImages(records.length, MAX_COPY_ALL_IMAGES, "Copy all");
    if (overCap !== null) return err(overCap);

    const job = startJob(v.jobId, ctx.signal);
    let lastTotal = records.length;
    let writing = false;
    try {
      const outcome = await renderCartImages(records, v.preset, {
        signal: job.signal,
        onProgress: (p) => {
          lastTotal = p.total;
          broadcastCartExportProgress({ jobId: v.jobId, phase: "rendering", ...p });
        }
      });
      if (outcome.cancelled || job.signal.aborted) return err(CANCELLED);
      if (outcome.rendered.length === 0) {
        return err({ kind: "render", code: "export_failed", message: "Could not render any images to copy" });
      }
      const aliases = await prepareCopyAliases(outcome.rendered, v.preset);
      // Last chance to back out: past this line the clipboard is replaced.
      if (job.signal.aborted) return err(CANCELLED);
      copySeq += 1;
      writing = true;
      await writeImageFilesToClipboard(
        aliases,
        JSON.stringify({ kind: "cart-copy-all", count: aliases.length, preset: v.preset, seq: copySeq, ts: Date.now(), pid: process.pid })
      );
      notifyClipboardChanged();
      log.info("cart: copied images to clipboard", {
        count: aliases.length,
        preset: v.preset,
        skipped,
        failed: outcome.failed
      });
      return ok({ fileCount: aliases.length, skipped, failed: outcome.failed });
    } catch (cause) {
      log.warn("cart:copyAll failed", {
        writing,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err(writing ? clipboardError(cause, "copy_failed") : exportError("Could not prepare the images to copy"));
    } finally {
      job.release();
      broadcastCartExportProgress({ jobId: v.jobId, phase: "done", completed: lastTotal, total: lastTotal });
    }
  });

  bus.register("cart:contactSheet", async (req, ctx) => {
    const v = validateCartContactSheet(req);
    if (!v.ok) return err(v.error);
    const { records, skipped } = resolveExportableImages(v.captureIds);
    if (records.length === 0) return err(NOTHING_TO_EXPORT);
    const overCap = tooManyImages(records.length, MAX_CONTACT_SHEET_IMAGES, "A sheet");
    if (overCap !== null) return err(overCap);

    let destPath: string | null = null;
    if (v.action === "save") {
      // The save sheet is window-modal, so ask before the slow part starts —
      // same order as the Zip.
      destPath = await askSavePath(
        `${sheetBaseName(v.suggestedName, records.length)}-contact-sheet-${v.size}.png`
      );
      if (destPath === null) return err(CANCELLED);
    }

    const job = startJob(v.jobId, ctx.signal);
    let lastTotal = records.length;
    let writing = false;
    try {
      const built = await buildSheet({
        records,
        size: v.size,
        layout: v.layout,
        suggestedName: v.suggestedName,
        signal: job.signal,
        onProgress: (phase, completed, total) => {
          lastTotal = total;
          broadcastCartExportProgress({ jobId: v.jobId, phase, completed, total });
        }
      });
      if (built === "cancelled" || job.signal.aborted) return err(CANCELLED);
      if (built === "none_rendered") {
        return err({ kind: "render", code: "export_failed", message: "Could not render any images for the sheet" });
      }
      let path = built.path;
      if (destPath !== null) {
        await publishTo(built.path, destPath);
        shell.showItemInFolder(destPath);
        path = destPath;
      } else {
        path = await stageClipboardSheet(built.path);
        writing = true;
        await copySheetImage(path, built.imageCount);
        notifyClipboardChanged();
      }
      return ok({
        width: built.width,
        height: built.height,
        imageCount: built.imageCount,
        skipped,
        failed: built.failed,
        scaledDown: built.scaledDown,
        path
      });
    } catch (cause) {
      log.warn("cart:contactSheet failed", { message: cause instanceof Error ? cause.message : String(cause) });
      return err(writing ? clipboardError(cause, "copy_failed") : exportError("Could not make the contact sheet"));
    } finally {
      job.release();
      broadcastCartExportProgress({ jobId: v.jobId, phase: "done", completed: lastTotal, total: lastTotal });
    }
  });

  // Drag-outs for the FILES / FILE chips. No progress UI and no cancel: a
  // native drag has no protocol for either. Errors are logged by the bridge.
  bus.register("cart:prepareFilesDrag", async (req) => {
    const v = validateCartPrepareFilesDrag(req);
    if (!v.ok) return err(v.error);
    const { records } = resolveExportableImages(v.captureIds);
    if (records.length === 0) return err(NOTHING_TO_EXPORT);
    const overCap = tooManyImages(records.length, MAX_COPY_ALL_IMAGES, "Copy all");
    if (overCap !== null) return err(overCap);
    try {
      const outcome = await renderCartImages(records, v.preset);
      if (outcome.rendered.length === 0) {
        return err({ kind: "render", code: "export_failed", message: "Could not render any images to drag" });
      }
      const paths = await prepareCopyAliases(outcome.rendered, v.preset);
      const root = cartDragTempDir();
      await mkdir(root, { recursive: true });
      await pruneCartDragTemp(root, CART_DRAG_TEMP_MAX_AGE_MS);
      const iconDest = join(root, `files-${randomUUID().slice(0, 8)}-drag.png`);
      let iconPath: string | null = paths[0] ?? null;
      try {
        await composeCartDragIcon({ imagePath: paths[0]!, count: paths.length, destPath: iconDest, chip: "PNG" });
        iconPath = iconDest;
      } catch {
        // keep the raw first image; the bridge scales it down
      }
      return ok({ paths, iconPath });
    } catch (cause) {
      log.warn("cart:prepareFilesDrag failed", { message: cause instanceof Error ? cause.message : String(cause) });
      return err({ kind: "render", code: "export_failed", message: "Could not prepare the images for dragging" });
    }
  });

  bus.register("cart:prepareSheetDrag", async (req) => {
    const v = validateCartPrepareSheetDrag(req);
    if (!v.ok) return err(v.error);
    const { records } = resolveExportableImages(v.captureIds);
    if (records.length === 0) return err(NOTHING_TO_EXPORT);
    const overCap = tooManyImages(records.length, MAX_CONTACT_SHEET_IMAGES, "A sheet");
    if (overCap !== null) return err(overCap);
    try {
      const built = await buildSheet({
        records,
        size: v.size,
        layout: v.layout,
        suggestedName: v.suggestedName
      });
      if (built === "cancelled" || built === "none_rendered") {
        return err({ kind: "render", code: "export_failed", message: "Could not render any images for the sheet" });
      }
      const iconDest = join(dirname(built.path), "drag.png");
      let iconPath: string | null = built.path;
      try {
        await composeCartDragIcon({ imagePath: built.path, count: built.imageCount, destPath: iconDest, chip: "SHEET" });
        iconPath = iconDest;
      } catch {
        // keep the sheet itself; the bridge scales it down
      }
      return ok({ path: built.path, iconPath });
    } catch (cause) {
      log.warn("cart:prepareSheetDrag failed", { message: cause instanceof Error ? cause.message : String(cause) });
      return err({ kind: "render", code: "export_failed", message: "Could not make the contact sheet" });
    }
  });
}
