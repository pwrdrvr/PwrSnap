// Preload — narrow renderer-facing surface. The renderer never imports
// from the main process directly; everything goes through the typed
// command-bus dispatch.
//
// Why a single `dispatch` method instead of per-domain methods? The
// preload is the contextBridge boundary; every method we expose has a
// runtime cost (function pointer marshaled into the renderer's V8
// isolate) and an attack-surface cost. One typed dispatcher fits every
// command without growing the surface, and matches the pattern Phase 7
// uses for HTTP RPC + the future MCP transport.
//
// Renderer-side typing comes from `@pwrsnap/shared`: import
// `CommandName, Req, Res, Result, PwrSnapError` and the dispatch is
// fully typed with autocomplete. See apps/desktop/src/renderer/src/lib/
// command-bus.ts (Phase 1.4) for the renderer-side helper.

import { contextBridge, ipcRenderer } from "electron";
// Import from the `/ipc` subpath, NOT the package barrel — the barrel
// re-exports the Zod overlay schemas, whose `z.object(...)` calls have
// construction side-effects Vite can't tree-shake. Pulling the barrel
// would force a `require("zod")` at preload load time, and Electron's
// sandbox: true (which we always run with) doesn't allow arbitrary
// requires from a preload, so the file would fail silently and
// pwrsnapApi never reach the renderer.
import { IPC_CMD } from "@pwrsnap/shared/ipc";

// Internal (non-command-bus) channel for the region selector to commit
// its result back to main. Kept narrow: the preload exposes one
// purpose-built method (`submitRegion`), not a generic `send`.
const REGION_SELECTOR_RESULT_CHANNEL = "region-selector:result";

// Tray content auto-sizes to fit. The renderer measures itself with a
// ResizeObserver and asks main to setContentSize so the popover never
// has dead space at the bottom or clips a row.
const TRAY_RESIZE_CHANNEL = "tray:resize";

const pwrsnapApi = {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  },
  /**
   * Dispatch a command-bus command. Returns the typed Result envelope
   * — success carries the response, failure carries a structured
   * PwrSnapError. Renderers never throw across the boundary; they
   * inspect `result.ok`.
   */
  dispatch(name: string, req: unknown): Promise<unknown> {
    return ipcRenderer.invoke(IPC_CMD, name, req);
  },
  /**
   * Subscribe to a server → client event. Returns an unsubscribe
   * function. Used by `useLibrary.ts` etc. with `useSyncExternalStore`.
   */
  on(channel: string, handler: (payload: unknown) => void): () => void {
    const wrapped = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.off(channel, wrapped);
    };
  },
  /**
   * Region-selector renderer → main signal. Called on commit (with rect
   * + displayId) or on cancel (with `ok: false`). Main re-validates
   * everything; this channel is just a transport.
   */
  submitRegion(payload: {
    ok: boolean;
    rect?: { x: number; y: number; w: number; h: number };
    displayId?: number;
  }): void {
    ipcRenderer.send(REGION_SELECTOR_RESULT_CHANNEL, payload);
  },
  /**
   * Tray renderer → main: tell main to size the tray window's content
   * to the measured DOM bounds. Called from a ResizeObserver in
   * TrayMenu.tsx so the popover stays tight as content changes.
   */
  requestTrayResize(payload: { width: number; height: number }): void {
    ipcRenderer.send(TRAY_RESIZE_CHANNEL, payload);
  }
};

export type PwrsnapApi = typeof pwrsnapApi;

contextBridge.exposeInMainWorld("pwrsnapApi", pwrsnapApi);
