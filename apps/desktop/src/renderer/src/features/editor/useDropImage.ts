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
//     dragging arbitrary text or URLs is a no-op. MIME-empty Files from
//     Windows Explorer are admitted only through a bounded image-extension
//     allowlist, then main's real decoder remains authoritative.
//     Multi-file drops run sequentially with a hard count cap, preserving
//     insert/z-order while bounding worker and memory pressure.
//   • Main-side: a bounded verified-handle read (symlink + privileged-dir
//     reject) feeds bytes, never a pathname, into the same worker pipeline as
//     paste. Even if a renderer compromise supplies a hostile path, main
//     refuses it or snapshots the already-opened file.
//
// Electron 32 removed the non-standard `File.path` extension. The narrow
// preload bridge calls renderer-process `webUtils.getPathForFile(file)`;
// the renderer never receives the Electron/webUtils object itself.

import { useCallback, useEffect, useRef, useState } from "react";
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
  onCompleted?: (summary: DropImageSummary) => void;
}

export interface DropImageFailure {
  /** Zero-based position in the OS-supplied FileList. */
  fileIndex: number;
  /** Display-only basename from the browser File; never an absolute path. */
  fileName: string;
  error: PwrSnapError;
}

export interface DropImageSummary {
  /** Files the OS supplied in this one drop gesture. */
  requestedCount: number;
  /** Files examined within DROP_IMAGE_MAX_FILES. */
  attemptedCount: number;
  /** One id per successfully inserted raster, in drop/z-order. */
  importedLayerIds: string[];
  /** One structured, path-free Result error per attempted failure. */
  failures: DropImageFailure[];
  /** Files not attempted because the gesture exceeded the hard cap. */
  truncatedCount: number;
}

export interface DropImageProgress {
  requestedCount: number;
  attemptedCount: number;
  processedCount: number;
  importedCount: number;
  failedCount: number;
  truncatedCount: number;
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
  /** True for the whole bounded gesture, including renderer validation. */
  isImporting: boolean;
  /** Exact live counts for the active sequential gesture. */
  progress: DropImageProgress | null;
}

/** Maximum files one gesture may decode/insert. Work stays sequential. */
export const DROP_IMAGE_MAX_FILES = 16;

/** Four columns × four rows covers the complete gesture cap. */
const DROP_IMAGE_CASCADE_COLUMNS = 4;
const DROP_IMAGE_CASCADE_STEP_N = 0.04;

/**
 * Windows Explorer commonly leaves File.type empty. Keep this list bounded
 * to formats Sharp/libvips is expected to decode in PwrSnap; main still
 * decode-probes every byte and may reject a build-specific unsupported codec.
 */
const EMPTY_MIME_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp"
]);

export function isPotentialDroppedImage(file: File): boolean {
  if (file.type.toLowerCase().startsWith("image/")) return true;
  if (file.type !== "" && file.type.toLowerCase() !== "application/octet-stream") {
    return false;
  }
  const dot = file.name.lastIndexOf(".");
  if (dot < 0) return false;
  return EMPTY_MIME_IMAGE_EXTENSIONS.has(file.name.slice(dot).toLowerCase());
}

function getFilePath(file: File): string | null {
  const fn = window.pwrsnapApi?.getPathForFile;
  if (typeof fn === "function") {
    try {
      const value = fn(file);
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Keep successful batch inserts visually distinct. The cascade heads inward
 * from the drop point, so clamping at a canvas edge cannot collapse every
 * image onto the same transform. Failed files do not consume a slot.
 */
export function cascadedDropPosition(
  positionXn: number | undefined,
  positionYn: number | undefined,
  successfulIndex: number
): { positionXn: number; positionYn: number } {
  const baseX = positionXn ?? 0.5;
  const baseY = positionYn ?? 0.5;
  const column = successfulIndex % DROP_IMAGE_CASCADE_COLUMNS;
  const row = Math.floor(successfulIndex / DROP_IMAGE_CASCADE_COLUMNS);
  const directionX = baseX > 0.5 ? -1 : 1;
  const directionY = baseY > 0.5 ? -1 : 1;
  return {
    positionXn: clamp01(baseX + directionX * column * DROP_IMAGE_CASCADE_STEP_N),
    positionYn: clamp01(baseY + directionY * row * DROP_IMAGE_CASCADE_STEP_N)
  };
}

export function useDropImage(args: UseDropImageArgs): UseDropImageReturn {
  const {
    captureId,
    bundleFormatVersion,
    canvasEl,
    onError,
    onDropped,
    onCompleted
  } = args;
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [progress, setProgress] = useState<DropImageProgress | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const activeDropRef = useRef<{
    generation: number;
    controller: AbortController;
    operationId: string;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A capture is the lifetime boundary for a drop job. Cleanup aborts an
  // active loop before the next record mounts, and the generation guard keeps
  // an already-in-flight IPC response from scheduling another old-capture
  // mutation or firing callbacks into the replacement editor.
  useEffect(() => {
    generationRef.current += 1;
    if (activeDropRef.current === null) setProgress(null);
    setIsDragOver(false);
    return () => {
      generationRef.current += 1;
      const activeDrop = activeDropRef.current;
      activeDrop?.controller.abort();
      if (activeDrop !== null) {
        void dispatch("editor:cancelDropImageImport", {
          operationId: activeDrop.operationId
        });
      }
      // Keep the aborted job installed until its in-flight command settles.
      // A replacement capture therefore cannot start another command loop in
      // parallel; the old job's finally block releases the single-flight.
    };
  }, [captureId]);

  const onDragOver = useCallback((e: React.DragEvent<HTMLElement>): void => {
    // Filter to drags that include at least one file. dataTransfer.types
    // is the only synchronous read available during dragover (the actual
    // files are restricted until drop).
    const types = e.dataTransfer.types;
    if (!types || !Array.from(types).includes("Files")) {
      return;
    }
    e.preventDefault();
    const accepting = activeDropRef.current === null;
    e.dataTransfer.dropEffect = accepting ? "copy" : "none";
    setIsDragOver(accepting);
  }, []);

  const onDragLeave = useCallback((): void => {
    setIsDragOver(false);
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLElement>): Promise<void> => {
      e.preventDefault();
      setIsDragOver(false);
      // Ref-backed rather than state-backed so two gestures in the same React
      // turn cannot both enter the async loop. The visible progress from the
      // first gesture explains why the second gesture is blocked.
      if (activeDropRef.current !== null) return;
      if (bundleFormatVersion < 2) {
        onError?.({
          kind: "validation",
          code: "v1_capture_use_v2",
          message: "Only v2 captures support multi-image drop"
        });
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
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
      const attempted = files.slice(0, DROP_IMAGE_MAX_FILES);
      const importedLayerIds: string[] = [];
      const failures: DropImageFailure[] = [];
      const generation = generationRef.current;
      const controller = new AbortController();
      const activeDrop = {
        generation,
        controller,
        operationId: crypto.randomUUID()
      };
      activeDropRef.current = activeDrop;
      const isCurrent = (): boolean =>
        !controller.signal.aborted &&
        generationRef.current === activeDrop.generation &&
        activeDropRef.current === activeDrop;
      const publishProgress = (processedCount: number): void => {
        if (!isCurrent()) return;
        setProgress({
          requestedCount: files.length,
          attemptedCount: attempted.length,
          processedCount,
          importedCount: importedLayerIds.length,
          failedCount: failures.length,
          truncatedCount: files.length - attempted.length
        });
      };
      publishProgress(0);

      // Deliberately sequential: main computes each new layer's z-index from
      // the already-committed tree, so input order becomes visual z-order and
      // only one bounded decode worker is live at a time.
      try {
        for (const [fileIndex, file] of attempted.entries()) {
          if (!isCurrent()) return;
          let fileError: PwrSnapError | null = null;
          if (!isPotentialDroppedImage(file)) {
            fileError = {
              kind: "validation",
              code: "drop_not_image",
              message: "Only image files supported"
            };
          } else {
            const filePath = getFilePath(file);
            if (filePath === null) {
              fileError = {
                kind: "validation",
                code: "drop_path_unavailable",
                message: "Dropped file path unavailable"
              };
            } else {
              const req: {
                captureId: string;
                filePath: string;
                operationId: string;
                positionXn?: number;
                positionYn?: number;
              } = { captureId, filePath, operationId: activeDrop.operationId };
              if (attempted.length > 1) {
                const placement = cascadedDropPosition(
                  positionXn,
                  positionYn,
                  importedLayerIds.length
                );
                req.positionXn = placement.positionXn;
                req.positionYn = placement.positionYn;
              } else {
                if (positionXn !== undefined) req.positionXn = positionXn;
                if (positionYn !== undefined) req.positionYn = positionYn;
              }
              const result = await dispatch("editor:dropImageAsLayer", req);
              if (!isCurrent()) return;
              if (!result.ok) {
                fileError = result.error;
              } else {
                importedLayerIds.push(result.value.layerId);
                onDropped?.(result.value.layerId);
              }
            }
          }
          if (fileError !== null) {
            failures.push({ fileIndex, fileName: file.name, error: fileError });
          }
          publishProgress(fileIndex + 1);
        }

        if (!isCurrent()) return;
        // A single-file failure keeps the detailed structured Result error.
        // Multi-file gestures carry every path-free failure in their summary
        // so the UI can report exact counts and grouped causes.
        const firstFailure = failures[0];
        if (files.length === 1 && firstFailure !== undefined) {
          onError?.(firstFailure.error);
        }
        onCompleted?.({
          requestedCount: files.length,
          attemptedCount: attempted.length,
          importedLayerIds,
          failures,
          truncatedCount: files.length - attempted.length
        });
      } finally {
        if (activeDropRef.current === activeDrop) {
          activeDropRef.current = null;
          if (mountedRef.current) setProgress(null);
        }
      }
    },
    [captureId, bundleFormatVersion, canvasEl, onError, onDropped, onCompleted]
  );

  return {
    onDragOver,
    onDragLeave,
    onDrop,
    isDragOver,
    isImporting: progress !== null,
    progress
  };
}
