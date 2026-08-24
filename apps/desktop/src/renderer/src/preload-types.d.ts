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
  Result,
  VideoPreset
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
      /** Electron 32+ replacement for the removed File.path extension. */
      getPathForFile(file: File): string;
      dispatch<C extends CommandName>(name: C, req: Req<C>): Promise<Result<Res<C>, PwrSnapError>>;
      on(channel: string, handler: (payload: unknown) => void): () => void;
      submitRegion(payload: {
        ok: boolean;
        invocationId: number;
        rect?: { x: number; y: number; w: number; h: number };
        displayId?: number;
        snappedWindowId?: number;
        fullWindow?: boolean;
        captureCursor?: boolean;
      }): void;
      notifySelectorSnapshotPainted(payload: {
        snapshotKey: string;
        invocationId: number;
        status: "painted" | "error";
      }): void;
      notifySelectorPresented(payload: {
        invocationId: number;
        generation: number;
        surface: "frozen-frame" | "window-loading" | "error";
      }): void;
      onWindowListSnapshot(
        handler: (payload: {
          invocationId: number;
          status?: "ready" | "error";
          windows: WindowSnapEntry[];
          displayBounds: { width: number; height: number };
          cursor?: { x: number; y: number };
        }) => void
      ): () => void;
      onSelectorKey(handler: (payload: { key: string }) => void): () => void;
      onSelectorMode(
        handler: (payload: {
          invocationId: number;
          mode: "auto" | "region" | "window";
          captureSource:
            | {
                kind: "renderer-display-media";
                displayId: number;
                displayBounds: { width: number; height: number };
              }
            | { kind: "legacy-file"; screenUrl: string }
            | { kind: "none" };
          intent?: "snap" | "video";
          cursor?: boolean;
        }) => void
      ): () => void;
      onSelectorPresentationArm(
        handler: (payload: {
          invocationId: number;
          generation: number;
          surface: "frozen-frame" | "window-loading" | "error";
        }) => void
      ): () => void;
      requestTrayResize(payload: { width: number; height: number }): void;
      requestFloatOverResize(payload: { width: number; height: number }): void;
      requestRecordingControllerResize(payload: { height: number }): void;
      notifyPreCaptureHudReady(): void;
      requestPreCaptureHudResize(payload: { width: number; height: number }): void;
      getAppMenuModel(): Promise<Array<{ index: number; label: string }>>;
      popupAppMenu(payload: { index: number; x: number; y: number }): void;
      startCaptureDrag(payload: { captureId: string; preset: RenderPreset }): void;
      startVideoDrag(payload: {
        captureId: string;
        format: "gif" | "mp4";
        preset: VideoPreset;
      }): void;
      startCartZipDrag(payload: {
        captureIds: string[];
        preset: RenderPreset;
        suggestedName?: string;
      }): void;
      reportSelectorDiagnostics(payload: {
        innerWidth: number;
        innerHeight: number;
        outerWidth: number;
        outerHeight: number;
        devicePixelRatio: number;
        screenWidth: number;
        screenHeight: number;
      }): void;
      reportSelectorPerformance(payload: {
        invocationId: number;
        mark: "shell-painted" | "window-targets-painted";
      }): void;
      perfMark(payload: PerfMarkPayload): void;
    };
    /** Synchronous pre-React appearance bridge. Populated by the
     *  preload from `--pwrsnap-appearance=` argv (see
     *  `apps/desktop/src/preload/index.ts`). Consumed by the inline
     *  bootstrap script in `apps/desktop/src/renderer/index.html`
     *  before main.tsx loads. Undefined when the bridge isn't set
     *  (e.g. an old window opened before the additionalArguments
     *  pipeline existed) — the bootstrap falls back to localStorage. */
    __pwrsnapAppearance?: { theme: "system" | "dark" | "light" };
    /** Durable log path injected when the Logs BrowserWindow is created. */
    __pwrsnapLogFilePath?: string;
  }
}

export {};
