// Phase 5 multi-image paste/drop — Finder drag-drop handler.
//
// Returns DOM handlers (`onDragOver` / `onDragLeave` / `onDrop`) the
// Editor binds to its canvas wrap. When the user drags an image file
// from Finder onto the canvas, dispatches `editor:dropImageAsLayer` with
// the file path + the normalized drop position so the new raster layer
// lands where the user dropped it.
//
// Defenses live on both sides:
//
//   • Renderer-side: filter `dataTransfer.types` for `Files` only —
//     dragging arbitrary text or URLs is a no-op. Filter
//     `dataTransfer.files` by MIME type, refusing anything not image/*.
//     Single-file paste only — multi-image batch drop is deferred.
//   • Main-side: `assertSafePastedFile` (symlink + privileged-dir
//     reject) + the same 5-defense worker pipeline as paste. Even if a
//     renderer-compromise lets a hostile path through, main refuses.
//
// File paths from `dataTransfer.files[i].path` are an Electron-specific
// extension to the standard File API — in pure-web contexts the path is
// not exposed for sandbox reasons. Electron's contextIsolation does not
// strip this extension; the renderer is allowed to see the path because
// the user already authorized read by dragging it onto our window.

import { useCallback, useState } from "react";
import type { PwrSnapError } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export interface UseDropImageArgs {
  captureId: string;
  bundleFormatVersion: number;
  /** Optional ref to the canvas element. Used to translate clientX/Y
   *  into normalized canvas coords; falls back to canvas-center anchor
   *  when not provided. */
  canvasEl?: HTMLElement | null;
  onError?: (error: PwrSnapError) => void;
  onDropped?: (layerId: string) => void;
}

export interface UseDropImageReturn {
  /** Bind to the canvas wrap's onDragEnter / onDragOver. Calls
   *  `preventDefault` so the browser doesn't open the dropped file in
   *  a new tab — the default Electron behavior for any unhandled
   *  drop. */
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  /** Bind alongside onDragOver for visual feedback. */
  onDragLeave: () => void;
  /** Bind to the canvas wrap's onDrop. */
  onDrop: (e: React.DragEvent<HTMLElement>) => Promise<void>;
  /** True while a drag is hovering over the canvas. Editor renders a
   *  visual outline / cue when this is true. */
  isDragOver: boolean;
}

/**
 * Some Electron renderers expose `File.path` synchronously on
 * dataTransfer; some require `webUtils.getPathForFile(file)` since
 * Electron 32. Type the extension here so the rest of the hook can
 * treat the renderer agnostically.
 */
type ElectronFile = File & { path?: string };

function getFilePath(file: ElectronFile): string | null {
  // The path extension is the original; the webUtils API is what
  // Electron ≥ 32 exposes. We prefer the path extension when present
  // and fall back to webUtils (if exposed via preload).
  if (typeof file.path === "string" && file.path.length > 0) {
    return file.path;
  }
  const electron = (
    window as unknown as { electron?: { webUtils?: { getPathForFile?: (f: File) => string } } }
  ).electron;
  const fn = electron?.webUtils?.getPathForFile;
  if (typeof fn === "function") {
    try {
      return fn(file);
    } catch {
      return null;
    }
  }
  return null;
}

export function useDropImage(args: UseDropImageArgs): UseDropImageReturn {
  const { captureId, bundleFormatVersion, canvasEl, onError, onDropped } =
    args;
  const [isDragOver, setIsDragOver] = useState<boolean>(false);

  const onDragOver = useCallback((e: React.DragEvent<HTMLElement>): void => {
    // Filter to drags that include at least one file. dataTransfer.types
    // is the only synchronous read available during dragover (the actual
    // files are restricted until drop).
    const types = e.dataTransfer.types;
    if (!types || !Array.from(types).includes("Files")) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback((): void => {
    setIsDragOver(false);
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLElement>): Promise<void> => {
      e.preventDefault();
      setIsDragOver(false);
      if (bundleFormatVersion < 2) {
        onError?.({
          kind: "validation",
          code: "v1_capture_use_v2",
          message: "Only v2 captures support multi-image drop"
        });
        return;
      }
      const files = Array.from(e.dataTransfer.files) as ElectronFile[];
      if (files.length === 0) return;
      // Single-file drop only — multi-file batch deferred. Take the
      // first file; warn (via no-op) on others rather than failing the
      // whole drop.
      const first = files[0];
      if (first === undefined) return;
      if (!first.type.startsWith("image/")) {
        onError?.({
          kind: "validation",
          code: "drop_not_image",
          message: "Only image files supported"
        });
        return;
      }
      const filePath = getFilePath(first);
      if (filePath === null) {
        onError?.({
          kind: "validation",
          code: "drop_path_unavailable",
          message: "Dropped file path unavailable"
        });
        return;
      }
      // Translate clientX/Y → normalized canvas coords. If we don't
      // have the canvas el, anchor at center (positionXn = positionYn
      // = 0.5 is the handler's default when omitted).
      let positionXn: number | undefined;
      let positionYn: number | undefined;
      if (canvasEl !== null && canvasEl !== undefined) {
        const rect = canvasEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          positionXn = (e.clientX - rect.left) / rect.width;
          positionYn = (e.clientY - rect.top) / rect.height;
          // Clamp to [0,1] — a drop on the edge of the canvas with the
          // cursor over the chrome would otherwise hand main a slightly
          // negative value; main clamps too, but keeping the renderer
          // honest avoids waste.
          if (positionXn < 0) positionXn = 0;
          if (positionXn > 1) positionXn = 1;
          if (positionYn < 0) positionYn = 0;
          if (positionYn > 1) positionYn = 1;
        }
      }
      const req: {
        captureId: string;
        filePath: string;
        positionXn?: number;
        positionYn?: number;
      } = { captureId, filePath };
      if (positionXn !== undefined) req.positionXn = positionXn;
      if (positionYn !== undefined) req.positionYn = positionYn;
      const result = await dispatch("editor:dropImageAsLayer", req);
      if (!result.ok) {
        onError?.(result.error);
        return;
      }
      onDropped?.(result.value.layerId);
    },
    [captureId, bundleFormatVersion, canvasEl, onError, onDropped]
  );

  return { onDragOver, onDragLeave, onDrop, isDragOver };
}
