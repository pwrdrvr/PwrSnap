// Type declarations for the preload-exposed `window.pwrsnapApi`.
//
// Keep in sync with apps/desktop/src/preload/index.ts. Renderer code
// should call through `lib/pwrsnap.ts` (Phase 1.4 helper) rather than
// using `window.pwrsnapApi.dispatch` directly — the helper provides
// typed Req<C> / Res<C> inference per command name.

import type {
  CommandName,
  PerfMarkPayload,
  RenderPreset,
  Req,
  Res,
  PwrSnapError,
  Result
} from "@pwrsnap/shared";

export type WindowSnapEntry = {
  windowId: number;
  pid: number;
  bundleId: string | null;
  appName: string | null;
  title: string | null;
  /** True when the candidate belongs to this PwrSnap process.
   *  Diagnostic only; normal PwrSnap windows are snappable. */
  ownedByUs: boolean;
  /** Z-order; 0 = frontmost. Walked ascending in the renderer's
   *  hit-test (first raw-bounds match = topmost-at-cursor). */
  zIndex: number;
  /** Visible-region bounding box (snap highlight rect). */
  rect: { x: number; y: number; w: number; h: number };
  /** Raw bounds — used for hit-testing in z-order. */
  rawRect: { x: number; y: number; w: number; h: number };
};

declare global {
  interface Window {
    pwrsnapApi?: {
      platform: string;
      versions: { chrome: string; electron: string; node: string };
      dispatch<C extends CommandName>(
        name: C,
        req: Req<C>
      ): Promise<Result<Res<C>, PwrSnapError>>;
      on(channel: string, handler: (payload: unknown) => void): () => void;
      submitRegion(payload: {
        ok: boolean;
        rect?: { x: number; y: number; w: number; h: number };
        displayId?: number;
        snappedWindowId?: number;
        fullWindow?: boolean;
      }): void;
      onWindowListSnapshot(
        handler: (payload: {
          windows: WindowSnapEntry[];
          displayBounds: { width: number; height: number };
          cursor?: { x: number; y: number };
        }) => void
      ): () => void;
      onSelectorKey(handler: (payload: { key: string }) => void): () => void;
      onSelectorMode(
        handler: (payload: {
          mode: "auto" | "region" | "window";
          screenUrl?: string;
        }) => void
      ): () => void;
      requestTrayResize(payload: { width: number; height: number }): void;
      requestFloatOverResize(payload: { width: number; height: number }): void;
      startCaptureDrag(payload: { captureId: string; preset: RenderPreset }): void;
      reportSelectorDiagnostics(payload: {
        innerWidth: number;
        innerHeight: number;
        outerWidth: number;
        outerHeight: number;
        devicePixelRatio: number;
        screenWidth: number;
        screenHeight: number;
      }): void;
      perfMark(payload: PerfMarkPayload): void;
    };
  }
}

export {};
