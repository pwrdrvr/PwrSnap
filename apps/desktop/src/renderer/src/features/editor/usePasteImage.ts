// Phase 5 multi-image paste/drop — ⌘V handler.
//
// Returns a callback the Editor binds to its keydown handler. On ⌘V (Mac)
// or Ctrl+V (Linux/Windows), invokes `editor:pasteImageAsLayer` against
// the current capture; the worker thread runs decode + sha256 + dimension
// probe off the IPC main thread. While the dispatch is in flight, surfaces
// a "Pasting…" affordance via the `onPastingChange` callback at the click
// point (or canvas center when triggered via keyboard alone).
//
// v1 captures: no-op + surfaces a "Only v2 captures support multi-image"
// notice via `onError`. The renderer is the gating layer here even though
// the main-side handler also refuses v1 — error round-trip would feel
// slower than just not dispatching.
//
// Existing path it does NOT touch: `clipboard:pasteLayerFragment` (private
// UTI fragment paste). That verb handles the in-PwrSnap copy/paste case;
// `editor:pasteImageAsLayer` handles arbitrary image bytes from any
// source. The Editor's ⌘V dispatcher can choose which to call based on
// whether the clipboard has the private UTI present — that lives in the
// Editor wire-up, not here.

import { useCallback } from "react";
import type { PwrSnapError } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export interface PasteImagePosition {
  /** Normalized [0,1] x position of the paste anchor on the canvas. */
  xn: number;
  /** Normalized [0,1] y position of the paste anchor on the canvas. */
  yn: number;
  /** Pixel coordinates relative to the canvas — used to position the
   *  "Pasting…" affordance. */
  canvasPx: { x: number; y: number };
}

export interface UsePasteImageArgs {
  captureId: string;
  /** Bundle format of the active capture. v1 → paste no-ops + reports
   *  a friendly error. v2 → dispatches the worker pipeline. */
  bundleFormatVersion: number;
  /** Renderer state hook for the "Pasting…" affordance. Called with the
   *  position and the in-flight flag — `null` clears the affordance. */
  onPastingChange?: (state: PasteImagePosition | null) => void;
  /** Surfaces handler errors to the editor's notice system. */
  onError?: (error: PwrSnapError) => void;
  /** Called after a successful paste. The editor can select the new
   *  layer or animate it in. */
  onPasted?: (layerId: string) => void;
}

export interface UsePasteImageReturn {
  /** Trigger a paste. If `position` is omitted, the paste lands at the
   *  canvas center (positionXn=0.5, positionYn=0.5). Returns true if a
   *  dispatch was issued (worker-side validation may still fail), false
   *  if pre-flight refused (e.g. v1 capture). */
  pasteFromClipboard: (position?: PasteImagePosition) => Promise<boolean>;
}

export function usePasteImage(args: UsePasteImageArgs): UsePasteImageReturn {
  const {
    captureId,
    bundleFormatVersion,
    onPastingChange,
    onError,
    onPasted
  } = args;

  const pasteFromClipboard = useCallback(
    async (position?: PasteImagePosition): Promise<boolean> => {
      if (bundleFormatVersion < 2) {
        onError?.({
          kind: "validation",
          code: "v1_capture_use_v2",
          message: "Only v2 captures support multi-image paste"
        });
        return false;
      }
      // Tell the editor to render the "Pasting…" affordance.
      if (position !== undefined) {
        onPastingChange?.(position);
      }
      try {
        const req: {
          captureId: string;
          positionXn?: number;
          positionYn?: number;
        } = { captureId };
        if (position !== undefined) {
          req.positionXn = position.xn;
          req.positionYn = position.yn;
        }
        const result = await dispatch("editor:pasteImageAsLayer", req);
        if (!result.ok) {
          onError?.(result.error);
          return true; // dispatch ran, just failed in handler
        }
        onPasted?.(result.value.layerId);
        return true;
      } finally {
        // Always clear the affordance on resolution. The new raster
        // layer appearing via the events:overlays:changed broadcast is
        // the visible confirmation; no need to leave the affordance up.
        onPastingChange?.(null);
      }
    },
    [captureId, bundleFormatVersion, onPastingChange, onError, onPasted]
  );

  return { pasteFromClipboard };
}
