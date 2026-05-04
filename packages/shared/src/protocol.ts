// Typed `Commands` registry. Single source of truth across main /
// preload / renderer / external transports (HTTP RPC in Phase 7, MCP
// later). Every command-bus.dispatch(name, req) call typechecks the
// request and the response against this map.
//
// Adding a command: declare it here, then register a handler in
// apps/desktop/src/main/command-bus.ts. The renderer + RPC server pick
// up the new command for free.

import type { Overlay, OverlayRow } from "./overlay-schemas";

export type Rect = { x: number; y: number; w: number; h: number };

export type CaptureRecord = {
  id: string;
  kind: "image" | "video";
  captured_at: string;
  src_path: string;
  width_px: number;
  height_px: number;
  device_pixel_ratio: number;
  byte_size: number;
  sha256: string;
  source_app_bundle_id: string | null;
  source_app_name: string | null;
  deleted_at: string | null;
};

export type CaptureFilter = {
  before?: string;
  limit?: number;
  appBundleId?: string;
  includeDeleted?: boolean;
};

export type RenderPreset = "low" | "med" | "high";

export type Settings = {
  /**
   * User-configured Codex CLI binary path. When empty, discovery picks
   * the newest detected install. Override via `PWRSNAP_CODEX_COMMAND`
   * env var.
   */
  codexCommand: string;
  /**
   * Phase 4: AI-pipeline kill switch + per-feature toggles.
   * Defaulted off-until-consent; populated when Phase 4 ships.
   */
  aiEnabled: boolean;
  aiConsentAcceptedAt: string | null;
};

export type SettingsPatch = Partial<Settings>;

/**
 * Map of every command-bus command. Each entry declares the request
 * shape and the response shape. The handler signature in main/command-bus.ts
 * is generated from this via mapped types.
 */
export type Commands = {
  // ---- capture ----
  /** Headless region capture. Agents call this; humans go through `capture:interactive`. */
  "capture:region": { req: { rect: Rect; displayId: number }; res: CaptureRecord };
  /** Opens the region-selector window, awaits user confirm, returns the capture record. */
  "capture:interactive": { req: Record<string, never>; res: CaptureRecord };
  "capture:fullScreen": { req: { displayId: number }; res: CaptureRecord };
  "capture:window": { req: { windowId: number }; res: CaptureRecord };
  "capture:reveal": { req: { captureId: string }; res: void };
  /** Pre-render the cache file used by `webContents.startDrag`. */
  "capture:prepareDrag": {
    req: { captureId: string; preset: RenderPreset };
    res: { path: string; iconPath: string };
  };

  // ---- library ----
  "library:list": { req: CaptureFilter; res: CaptureRecord[] };
  "library:byId": { req: { id: string }; res: CaptureRecord | null };
  /** Soft-delete: moves source PNG atomically to <root>/.trash/, schedules GC. */
  "library:delete": { req: { id: string }; res: void };
  /** Phase 1 backup CLI hook. */
  "library:export": { req: { destDir: string }; res: { destDir: string; manifestPath: string } };
  /** Bring the main library window forward — used by the tray's "Open Library" row. */
  "library:focus": { req: Record<string, never>; res: void };
  /** Open the Phase 2 editor window for a capture. Each call opens a
   *  fresh window — edits are per-capture, not singleton. */
  "editor:open": { req: { captureId: string }; res: void };

  // ---- overlays (Phase 2+) ----
  "overlays:list": { req: { captureId: string }; res: OverlayRow[] };
  "overlays:upsert": { req: { captureId: string; overlay: Overlay }; res: OverlayRow };
  "overlays:delete": { req: { id: string }; res: void };

  // ---- copy / share ----
  "clipboard:copy": { req: { captureId: string; preset: RenderPreset }; res: void };

  // ---- settings ----
  "settings:read": { req: Record<string, never>; res: Settings };
  "settings:write": { req: SettingsPatch; res: Settings };

  // ---- float-over ----
  "float-over:dismiss": { req: Record<string, never>; res: void };

  // ---- codex (Phase 4+) — declared here so Phase 4 lands without protocol bumps ----
  "codex:annotate": { req: { captureId: string }; res: { runId: string } };
  "codex:describe": { req: { captureId: string }; res: { runId: string } };
  "codex:tag": { req: { captureId: string }; res: { runId: string } };
  "codex:filename": { req: { captureId: string }; res: { runId: string } };
  "codex:sensitiveScan": { req: { captureId: string }; res: { runId: string } };
  "codex:cancel": { req: { runId: string }; res: void };
  "codex:ask": { req: { captureId: string; message: string }; res: { threadId: string } };
};

export type CommandName = keyof Commands;
export type Req<C extends CommandName> = Commands[C]["req"];
export type Res<C extends CommandName> = Commands[C]["res"];
