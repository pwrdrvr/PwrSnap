// Thin ipcMain transport over the command-bus. The renderer calls
// `pwrsnapApi.dispatch(name, req)` (preload → ipcRenderer.invoke('cmd',
// name, req)) and we route into bus.dispatch with `principal: 'ipc'`.
// All commands flow through here; renderers never own privileged paths.

import { BrowserWindow, ipcMain, nativeImage } from "electron";
import {
  IPC_CAPTURE_DRAG_START,
  IPC_CART_ZIP_DRAG_START,
  IPC_CMD,
  IPC_PERMISSION_GUIDE_DRAG_START,
  IPC_VIDEO_DRAG_START
} from "@pwrsnap/shared";
import {
  CONTACT_SHEET_SIZES,
  type ContactSheetLayout,
  type ContactSheetSize,
  type RenderPreset,
  type VideoExportCoordinates,
  type VideoPreset
} from "@pwrsnap/shared";
import { bus } from "./command-bus";
import { getMainLogger } from "./log";
import { admitHotkeyRecorderDocument } from "./hotkeys/hotkey-recorder-document";
import { startPermissionGuideDrag } from "./capture/permission-guide";
import { relayCancellationToPeer } from "./process-split/event-relay";
import { validateVideoSpanList, videoExportAudioError } from "./recording/video-export-validation";

const log = getMainLogger("pwrsnap:ipc");

function ipcCancellationKey(name: string, req: unknown): string | undefined {
  if (typeof req !== "object" || req === null) return undefined;
  if (name === "codex:enrich" && "captureId" in req) {
    const captureId = (req as { captureId?: unknown }).captureId;
    return typeof captureId === "string" ? captureId : undefined;
  }
  if (name === "video:export" && "runId" in req) {
    const runId = (req as { runId?: unknown }).runId;
    return typeof runId === "string" && runId.length > 0
      ? `video-export:${runId}`
      : undefined;
  }
  return undefined;
}

export function registerIpcDispatcher(): void {
  ipcMain.handle(IPC_CMD, async (event, name: string, req: unknown, documentId: unknown) => {
    if (typeof name !== "string" || !bus.isRegistered(name)) {
      log.warn("ipc: unknown command", { name });
      return {
        ok: false,
        error: { kind: "validation", code: "unknown_command", message: `unknown command: ${name}` }
      };
    }
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    // The bus handler signature is typed; renderer untyped → main typed.
    // Validation of `req` shape is the handler's responsibility (Zod schemas).
    const dispatchOptions: Parameters<typeof bus.dispatch>[2] = {
      principal: "ipc",
      cancellationKey: ipcCancellationKey(name, req)
    };
    if (sourceWindow !== null && sourceWindow !== undefined) {
      dispatchOptions.sourceWindowId = sourceWindow.id;
    }
    const senderFrame = event.senderFrame;
    const mainFrame = event.sender.isDestroyed() ? null : event.sender.mainFrame;
    if (
      sourceWindow !== null &&
      sourceWindow !== undefined &&
      senderFrame !== null &&
      mainFrame !== null &&
      senderFrame.processId === mainFrame.processId &&
      senderFrame.routingId === mainFrame.routingId
    ) {
      const admittedDocumentId = admitHotkeyRecorderDocument(
        event.sender.id,
        documentId
      );
      if (admittedDocumentId !== null) {
        dispatchOptions.sourceDocumentId = admittedDocumentId;
      }
    }
    const exportCancellationKey =
      name === "video:export" ? dispatchOptions.cancellationKey : undefined;
    const cancelExport = (): void => {
      if (exportCancellationKey === undefined) return;
      bus.cancel(exportCancellationKey);
      relayCancellationToPeer(exportCancellationKey);
    };
    if (exportCancellationKey !== undefined) {
      event.sender.once("destroyed", cancelExport);
    }
    try {
      return await bus.dispatch(name, req as never, dispatchOptions);
    } finally {
      if (exportCancellationKey !== undefined) {
        event.sender.removeListener("destroyed", cancelExport);
        // Run-scoped keys are one-shot. Cancelling after settlement is a
        // harmless way to discard both local and split-peer controllers.
        cancelExport();
      }
    }
  });

  // Permission guide: drag the running app bundle into System Settings.
  // No payload — main drags the path it resolved, and only for the guide's
  // own WebContents (checked inside).
  ipcMain.on(IPC_PERMISSION_GUIDE_DRAG_START, (event) => {
    startPermissionGuideDrag(event.sender);
  });

  ipcMain.on(IPC_CAPTURE_DRAG_START, (event, req: unknown) => {
    void (async () => {
      const parsed = parseDragRequest(req);
      if (parsed === null) {
        log.warn("native drag: invalid request");
        return;
      }

      const result = await bus.dispatch(
        "capture:prepareDrag",
        parsed,
        { principal: "ipc" }
      );
      if (!result.ok) {
        log.warn("native drag: prepare failed", {
          code: result.error.code,
          message: result.error.message
        });
        return;
      }
      if (event.sender.isDestroyed()) return;

      let icon = nativeImage.createFromPath(result.value.iconPath);
      if (icon.isEmpty()) {
        icon = nativeImage.createFromPath(result.value.path);
      }
      if (icon.isEmpty()) {
        log.warn("native drag: empty drag icon", { captureId: parsed.captureId });
        return;
      }

      event.sender.startDrag({
        file: result.value.path,
        icon
      });
    })();
  });

  // Video drag-out bridge — same fire-and-forget shape as the image
  // variant above, but routes through `video:prepareDrag` so main
  // encodes (cache-hit if already done), generates a poster, and
  // returns a human-friendly file alias. The renderer dispatches
  // this whenever the user starts dragging a FILE chip on the
  // 6-card grid; main fills out `startDrag` against the resulting
  // path + poster icon. Errors are logged, not surfaced — the OS
  // drag handle has no protocol for "your prepare failed, sorry".
  ipcMain.on(IPC_VIDEO_DRAG_START, (event, req: unknown) => {
    void (async () => {
      const parsed = parseVideoDragRequest(req);
      if (parsed === null) {
        log.warn("native video drag: invalid request");
        return;
      }

      const result = await bus.dispatch(
        "video:prepareDrag",
        parsed,
        { principal: "ipc" }
      );
      if (!result.ok) {
        log.warn("native video drag: prepare failed", {
          captureId: parsed.captureId,
          format: parsed.format,
          preset: parsed.preset,
          code: result.error.code,
          message: result.error.message
        });
        return;
      }
      if (event.sender.isDestroyed()) return;

      const icon = nativeImage.createFromPath(result.value.iconPath);
      if (icon.isEmpty()) {
        // Unlike images, we don't have a sensible second-best icon
        // here — there's no point falling back to the .mp4 path
        // (nativeImage can't decode video). Drop into a small
        // empty placeholder so the OS shows *something* during
        // the drag.
        log.warn("native video drag: empty poster icon", {
          captureId: parsed.captureId
        });
      }

      event.sender.startDrag({
        file: result.value.path,
        icon: icon.isEmpty() ? nativeImage.createEmpty() : icon
      });
    })();
  });

  // Cart Zip drag-out bridge — same fire-and-forget shape as the image /
  // video variants. Routes through `cart:prepareZipDrag`, which renders the
  // cart's images and zips them to a temp file, then fills startDrag with
  // the `.zip` + the first image as the drag cursor icon. Errors are logged,
  // not surfaced — a native drag handle has no protocol for "prepare failed."
  ipcMain.on(IPC_CART_ZIP_DRAG_START, (event, req: unknown) => {
    void (async () => {
      const parsed = parseCartDragRequest(req);
      if (parsed === null) {
        log.warn("cart drag: invalid request");
        return;
      }

      const prepared = await prepareCartDrag(parsed);
      if (!prepared.ok) {
        log.warn("cart drag: prepare failed", {
          kind: parsed.kind,
          count: parsed.captureIds.length,
          code: prepared.error.code,
          message: prepared.error.message
        });
        return;
      }
      if (event.sender.isDestroyed()) return;

      // The icon is the macOS drag cursor image. The handler composes a
      // badged thumbnail (cover photo + count badge + kind chip) at
      // CART_DRAG_ICON_WIDTH; resizing to the same width is a no-op for it.
      // The resize is the safety net for the rare fallback where iconPath is
      // the raw first image at FULL resolution — without it that would paint
      // a giant, legible screenshot (a ghost of the app) under the cursor.
      const raw =
        prepared.iconPath !== null
          ? nativeImage.createFromPath(prepared.iconPath)
          : nativeImage.createEmpty();
      const icon = raw.isEmpty()
        ? nativeImage.createEmpty()
        : raw.resize({ width: CART_DRAG_ICON_WIDTH, quality: "better" });
      if (prepared.files.length === 1) {
        event.sender.startDrag({ file: prepared.files[0]!, icon });
      } else {
        event.sender.startDrag({ file: prepared.files[0]!, files: prepared.files, icon });
      }
    })();
  });
}

type CartDragPrepared =
  | { ok: true; files: string[]; iconPath: string | null }
  | { ok: false; error: { code: string; message: string } };

/** Route a cart drag to its prepare verb: the Zip, Copy all's separate
 *  files, or the contact sheet. */
async function prepareCartDrag(parsed: CartDragRequest): Promise<CartDragPrepared> {
  switch (parsed.kind) {
    case "zip": {
      const r = await bus.dispatch(
        "cart:prepareZipDrag",
        {
          captureIds: parsed.captureIds,
          preset: parsed.preset,
          ...(parsed.suggestedName !== undefined ? { suggestedName: parsed.suggestedName } : {})
        },
        { principal: "ipc" }
      );
      return r.ok ? { ok: true, files: [r.value.path], iconPath: r.value.iconPath } : { ok: false, error: r.error };
    }
    case "files": {
      const r = await bus.dispatch(
        "cart:prepareFilesDrag",
        { captureIds: parsed.captureIds, preset: parsed.preset },
        { principal: "ipc" }
      );
      return r.ok ? { ok: true, files: r.value.paths, iconPath: r.value.iconPath } : { ok: false, error: r.error };
    }
    case "sheet": {
      const r = await bus.dispatch(
        "cart:prepareSheetDrag",
        {
          captureIds: parsed.captureIds,
          size: parsed.size,
          layout: parsed.layout,
          ...(parsed.suggestedName !== undefined ? { suggestedName: parsed.suggestedName } : {})
        },
        { principal: "ipc" }
      );
      return r.ok ? { ok: true, files: [r.value.path], iconPath: r.value.iconPath } : { ok: false, error: r.error };
    }
  }
}

/** Drag cursor thumbnail width for the cart Zip drag-out — matches the
 *  composed badge card in `render/cart-drag-icon.ts` (and the single-capture
 *  drag's 128px ballpark), so the ghost is a tidy tile, never a full-res
 *  screenshot. */
const CART_DRAG_ICON_WIDTH = 160;

export function disposeIpcDispatcher(): void {
  ipcMain.removeHandler(IPC_CMD);
  ipcMain.removeAllListeners(IPC_CAPTURE_DRAG_START);
  ipcMain.removeAllListeners(IPC_VIDEO_DRAG_START);
  ipcMain.removeAllListeners(IPC_CART_ZIP_DRAG_START);
}

type CartDragRequest =
  | { kind: "zip"; captureIds: string[]; preset: RenderPreset; suggestedName?: string }
  | { kind: "files"; captureIds: string[]; preset: RenderPreset }
  | {
      kind: "sheet";
      captureIds: string[];
      size: ContactSheetSize;
      layout: ContactSheetLayout;
      suggestedName?: string;
    };

/** Shape-check a cart drag payload. `kind` absent means the Zip (the
 *  original payload). The prepare verbs validate the rest in depth. */
export function parseCartDragRequest(req: unknown): CartDragRequest | null {
  if (typeof req !== "object" || req === null) return null;
  const value = req as {
    kind?: unknown;
    captureIds?: unknown;
    preset?: unknown;
    suggestedName?: unknown;
    size?: unknown;
    layout?: unknown;
  };
  if (!Array.isArray(value.captureIds) || value.captureIds.length === 0) return null;
  if (!value.captureIds.every((id) => typeof id === "string" && id.length > 0)) return null;
  const captureIds = value.captureIds as string[];
  const suggestedName = typeof value.suggestedName === "string" ? value.suggestedName : undefined;
  const kind = value.kind ?? "zip";
  if (kind === "sheet") {
    if (!(CONTACT_SHEET_SIZES as readonly unknown[]).includes(value.size)) return null;
    if (typeof value.layout !== "object" || value.layout === null) return null;
    return {
      kind,
      captureIds,
      size: value.size as ContactSheetSize,
      // Deep-checked by the cart:prepareSheetDrag validator.
      layout: value.layout as ContactSheetLayout,
      ...(suggestedName !== undefined ? { suggestedName } : {})
    };
  }
  if (kind !== "zip" && kind !== "files") return null;
  if (value.preset !== "low" && value.preset !== "med" && value.preset !== "high") {
    return null;
  }
  if (kind === "files") return { kind, captureIds, preset: value.preset };
  return {
    kind,
    captureIds,
    preset: value.preset,
    ...(suggestedName !== undefined ? { suggestedName } : {})
  };
}

function parseDragRequest(req: unknown): { captureId: string; preset: RenderPreset } | null {
  if (typeof req !== "object" || req === null) return null;
  const value = req as { captureId?: unknown; preset?: unknown };
  if (typeof value.captureId !== "string" || value.captureId.length === 0) return null;
  if (value.preset !== "low" && value.preset !== "med" && value.preset !== "high") {
    return null;
  }
  return { captureId: value.captureId, preset: value.preset };
}

function parseVideoDragRequest(req: unknown): VideoExportCoordinates | null {
  if (typeof req !== "object" || req === null) return null;
  const value = req as {
    captureId?: unknown;
    format?: unknown;
    preset?: unknown;
    range?: unknown;
    segments?: unknown;
    audio?: unknown;
  };
  if (typeof value.captureId !== "string" || value.captureId.length === 0) return null;
  if (value.format !== "gif" && value.format !== "mp4") return null;
  if (value.preset !== "low" && value.preset !== "med" && value.preset !== "high") {
    return null;
  }
  // Optional explicit trim range (the renderer passes the persisted
  // defaultRange it is displaying). Malformed → treat as omitted so
  // the resolver falls back to the record's defaultRange.
  let range: VideoExportCoordinates["range"];
  if (typeof value.range === "object" && value.range !== null) {
    const r = value.range as { start?: unknown; end?: unknown };
    if (
      typeof r.start === "number" &&
      typeof r.end === "number" &&
      Number.isFinite(r.start) &&
      Number.isFinite(r.end) &&
      r.start >= 0 &&
      // Must agree with `validateVideoExportRequest`, which the
      // `video:prepareDrag` verb runs — a range this parser lets
      // through only to have the verb reject it would kill the drag.
      r.end > r.start
    ) {
      range = { start: r.start, end: r.end };
    }
  }
  // The live edit's kept spans. Same rule as the range: whatever the
  // verb would reject is dropped here, so the drag falls back to the
  // persisted edit instead of dying.
  const segments = validateVideoSpanList(value.segments, "video:drag-start", "segments");
  // Optional explicit MP4 audio choice — the toggle the grid is showing.
  // Unlike a malformed range, a malformed one REFUSES the drag: treating
  // it as omitted would still honor the saved preference, but a payload
  // we cannot read is not one to guess at when the question is whether
  // to ship someone's microphone.
  let audio: VideoExportCoordinates["audio"];
  if (value.audio !== undefined) {
    if (videoExportAudioError(value.audio, IPC_VIDEO_DRAG_START) !== null) return null;
    const a = value.audio as NonNullable<VideoExportCoordinates["audio"]>;
    audio = { includeSystemAudio: a.includeSystemAudio, includeMicrophone: a.includeMicrophone };
  }
  return {
    captureId: value.captureId,
    format: value.format,
    preset: value.preset as VideoPreset,
    ...(range !== undefined ? { range } : {}),
    ...(value.segments !== undefined && segments.ok ? { segments: segments.value } : {}),
    ...(audio !== undefined ? { audio } : {})
  };
}
