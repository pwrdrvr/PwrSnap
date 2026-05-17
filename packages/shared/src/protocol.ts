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
  /**
   * Monotonic counter, bumped in the same transaction as every
   * overlay write (see `insertOverlay` / `rejectOverlay` in
   * persistence/overlays-repo.ts). Renderers append this to the
   * `pwrsnap-cache://` URL as a cache-buster so Chromium re-fetches
   * the rendered image after the user edits — without it the
   * 5-minute browser HTTP cache serves the stale render.
   */
  overlays_version: number;
  deleted_at: string | null;
};

export type CaptureFilter = {
  before?: string | undefined;
  limit?: number | undefined;
  appBundleId?: string | undefined;
  appBundleIds?: Array<string | null> | undefined;
  includeDeleted?: boolean | undefined;
};

/**
 * Composite cursor for keyset pagination of `library:list`. Encodes
 * the last row of the previous page so the next request can resume
 * with `(captured_at, id) < (cursor.capturedAt, cursor.id)`. Round-
 * tripped opaquely by callers — pass `nextCursor` directly back into
 * the next request.
 */
export type LibraryCursor = { capturedAt: string; id: string };

/**
 * One bucket of the denormalized app-counts surface. Returned in
 * `library:list`'s head-page response so the sidebar can render
 * counts and labels without a separate round-trip or a `COUNT(*)` over
 * the captures table. `bundleId === null` is the "captures with
 * unknown source app" bucket. `sourceAppName` is the latest non-empty
 * OS-supplied app name seen for the bucket, if any.
 */
export type LibraryAppStat = {
  bundleId: string | null;
  count: number;
  sourceAppName: string | null;
};

export type RenderPreset = "low" | "med" | "high";

export type CapturePresetMetric = {
  preset: RenderPreset;
  widthPx: number;
  heightPx: number;
  byteSize: number;
  fromCache: boolean;
};

/** Identifier for every Settings sidebar page. Used by `settings:open`
 *  to deep-link directly to a section. */
export type SettingsPage =
  | "startup"
  | "hotkeys"
  | "notifications"
  | "ai"
  | "capture"
  | "output"
  | "annotate"
  | "storage"
  | "sources"
  | "experimental"
  | "about";

/** Runtime allowlist of every valid `SettingsPage`. Kept here (not in
 *  the renderer's `settings-categories.ts`) so the main process can
 *  validate `settings:open` / `events:settings:navigate` payloads
 *  without importing renderer code. Stays in lock-step with the union
 *  above via the `satisfies` clause — adding a member to the union
 *  without adding the literal here is a type error. */
export const SETTINGS_PAGES = [
  "startup",
  "hotkeys",
  "notifications",
  "ai",
  "capture",
  "output",
  "annotate",
  "storage",
  "sources",
  "experimental",
  "about"
] as const satisfies readonly SettingsPage[];

export function isSettingsPage(value: unknown): value is SettingsPage {
  return (
    typeof value === "string" &&
    (SETTINGS_PAGES as readonly string[]).includes(value)
  );
}

/** Every secret the app persists. Plaintext values never cross the IPC
 *  boundary — the renderer only ever sees the status shape below. */
export type DesktopSettingsSecretName = "grokApiKey";

export type SecretStatus = {
  configured: boolean;
  lastSetAt: string | null;
};

/** Where a discovered Codex binary came from. `env` = PWRSNAP_CODEX_COMMAND
 *  override; `config` = user-pinned in Settings; `path` = `which codex`;
 *  `application` = Codex.app bundled binary. */
export type DesktopCodexCandidateSource = "env" | "config" | "path" | "application";

export type DesktopCodexDiscoveryCandidate = {
  path: string;
  source: DesktopCodexCandidateSource;
  version: string | null;
  available: boolean;
};

export type DesktopCodexDiscoverySnapshot = {
  candidates: DesktopCodexDiscoveryCandidate[];
  /** The path that `resolveCodexCommand` will pick for the next spawn,
   *  or `null` if none is usable. Renderers compare to `candidate.path`
   *  to draw the "Using" badge. */
  resolvedPath: string | null;
  /** ISO-8601 timestamp of when this snapshot was produced. */
  refreshedAt: string;
};

/** Outcome of a Codex `--version` probe via the connection-test button.
 *  Ported from PwrAgnt's CredentialTester.testCodex. */
export type CodexTestStatus = "unset" | "ok" | "failed";

export type CodexTestResult = {
  status: CodexTestStatus;
  testedAt: string;
  durationMs: number;
  account: string | null;
  detail?: string;
  errorMessage?: string;
};

export type AppDocumentKind = "changelog" | "third-party-licenses";

export type AppDocument = {
  kind: AppDocumentKind;
  title: string;
  content: string;
};

export type Settings = {
  /** Bumped when the on-disk shape changes. Readers below the current
   *  version go through the legacy-shape catalog in the service before
   *  being normalized. */
  schemaVersion: 1;
  codex: {
    mode: "auto" | "pinned";
    /** Path the user pinned. Empty string = no pin. Kept across mode
     *  toggles so flipping back to "pinned" restores the prior choice. */
    pinnedPath: string;
    /** CODEX_HOME / profile dir. Empty string = system default (`~/.codex`). */
    profile: string;
  };
  ai: {
    /** Phase 4 AI-pipeline kill switch. */
    enabled: boolean;
    /** ISO-8601; null until the user accepts the AI consent modal. */
    consentAcceptedAt: string | null;
  };
  /** Global capture hotkeys. Each field is an Electron accelerator
   *  string (`CommandOrControl+Shift+C`-style) OR the empty string,
   *  which signals "unbound" — main skips registration. The Settings →
   *  Hotkeys page is the only editor; main re-registers on
   *  `events:settings:changed`. */
  hotkeys: {
    quickCapture: string;
    region: string;
    window: string;
    /** Video-capture hotkey. The recording surface itself ships later;
     *  for now main just confirms the binding fires (notification +
     *  warn log) so the registration plumbing is exercised end-to-end. */
    videoCapture: string;
  };
  experimental: {
    /** Slot for the upcoming PwrSnap1 file format. Wired but unused. */
    v2FileFormat: boolean;
  };
};

/** Deep-partial patch shape. `undefined` = leave untouched. Each nested
 *  object is independently optional so a renderer can write a single
 *  field without echoing the rest. */
export type SettingsPatch = {
  codex?: Partial<Settings["codex"]>;
  ai?: Partial<Settings["ai"]>;
  hotkeys?: Partial<Settings["hotkeys"]>;
  experimental?: Partial<Settings["experimental"]>;
};

/**
 * Map of every command-bus command. Each entry declares the request
 * shape and the response shape. The handler signature in main/command-bus.ts
 * is generated from this via mapped types.
 */
export type Commands = {
  // ---- capture ----
  /** Headless region capture. Agents call this; humans go through `capture:interactive`. */
  "capture:region": { req: { rect: Rect; displayId: number }; res: CaptureRecord };
  /**
   * Opens the region-selector window, awaits user confirm, returns the
   * capture record.
   *
   * `mode` controls the selector's behavior:
   *   - `auto` (default) — snap-to-window highlight is live; click a
   *     window to capture it, drag to free-draw a rect, ⇧ at commit
   *     opts into the occlusion-free full-window backing buffer.
   *   - `region` — pure rect drag. Snap candidates are not rendered;
   *     ⇧ has no effect; the user must drag a rect.
   *   - `window` — pure window picker. Snap-to-window is live; the
   *     drag-to-region path is suppressed; commit always uses the
   *     full-window (occlusion-free) capture path.
   */
  "capture:interactive": {
    req: { mode?: "auto" | "region" | "window" };
    res: CaptureRecord;
  };
  /**
   * Read the current system clipboard image, persist it as a library
   * capture, and return the resulting record. Pixel bytes stay in the
   * main process; renderers only observe the normal captures-changed
   * broadcast and can refetch through `library:list`.
   */
  "capture:pasteFromClipboard": { req: Record<string, never>; res: CaptureRecord };
  /**
   * Synthetic ingest path — accepts a temp PNG already on disk and a
   * backdated `capturedAt`, persists via the same source-store +
   * captures-repo chain as `capture:region`. Used by the dev seeder
   * to populate large datasets through the live command-bus so DB
   * page packing + index maintenance reflect production behavior.
   *
   * Registered ONLY when `import.meta.env.DEV` is true; absent from
   * production bundles. If/when a real consumer (an agent flow that
   * generates synthesized snaps) lands, lift the gate after adding
   * a path-traversal validator on `tempPngPath`.
   */
  "capture:ingest": {
    req: {
      /** Absolute path to a temp PNG. Caller owns; handler reads, hashes, persists. */
      tempPngPath: string;
      /** ISO 8601 with millisecond precision. Drives the captures/<yyyy>/<mm>/ layout
       *  and the row's `captured_at` column. */
      capturedAt: string;
      sourceAppBundleId: string | null;
      sourceAppName: string | null;
      /** Optional dim hints — when omitted, source-store reads via sharp.metadata(). */
      widthPxHint?: number | undefined;
      heightPxHint?: number | undefined;
      devicePixelRatio?: number | undefined;
    };
    res: { record: CaptureRecord; isNew: boolean };
  };
  "capture:fullScreen": { req: { displayId: number }; res: CaptureRecord };
  "capture:window": { req: { windowId: number }; res: CaptureRecord };
  "capture:reveal": { req: { captureId: string }; res: void };
  /** Pre-render the cache file used by `webContents.startDrag`. */
  "capture:prepareDrag": {
    req: { captureId: string; preset: RenderPreset };
    res: { path: string; iconPath: string };
  };
  /** Render/resolve the Low/Med/High cache files and return their real file sizes. */
  "capture:presetMetrics": {
    req: { captureId: string };
    res: { metrics: CapturePresetMetric[] };
  };

  // ---- library ----
  /**
   * Keyset-paginated timeline read. When `cursor` is omitted, returns
   * the most-recent page and includes `appStats` + `totalLive` for the
   * sidebar (head-page-only — saves a round-trip without paying for
   * stats on every page). Subsequent pages omit those.
   */
  "library:list": {
    req: {
      cursor?: LibraryCursor | undefined;
      limit?: number | undefined;
      appBundleId?: string | undefined;
      appBundleIds?: Array<string | null> | undefined;
      includeDeleted?: boolean | undefined;
    };
    res: {
      rows: CaptureRecord[];
      nextCursor: LibraryCursor | null;
      /** Head-page only. */
      appStats?: LibraryAppStat[];
      /** Head-page only. Live row count served from app_stats. */
      totalLive?: number;
    };
  };
  "library:byId": { req: { id: string }; res: CaptureRecord | null };
  /** Soft-delete: moves source PNG atomically to <root>/.trash/, schedules GC. */
  "library:delete": { req: { id: string }; res: void };
  /** Restore a soft-deleted capture: clears deleted_at and moves the source PNG back from <root>/.trash/. */
  "library:restore": { req: { id: string }; res: void };
  /** Hard-delete a single soft-deleted capture: removes the row + the trash file. */
  "library:purge": { req: { id: string }; res: void };
  /** Empty the trash: hard-deletes every currently soft-deleted capture and removes its trash file. */
  "library:purgeAll": { req: Record<string, never>; res: { removedCount: number } };
  /** Phase 1 backup CLI hook. */
  "library:export": { req: { destDir: string }; res: { destDir: string; manifestPath: string } };
  /** Bring the main library window forward — used by the tray's "Open Library" row. */
  "library:focus": { req: Record<string, never>; res: void };
  /**
   * Bring the Library window forward and open `captureId` in inline
   * Focus mode (Stage with editing tools), not a standalone editor
   * window. Used by the float-over toast's Edit button to hand the
   * just-captured image into the Library editor.
   */
  "library:openInLibrary": { req: { captureId: string }; res: void };
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
  /** Open (or focus, if already open) the Settings BrowserWindow. */
  "settings:open": { req: { page?: SettingsPage }; res: void };
  /** Re-run Codex CLI discovery and return the snapshot. `force: false`
   *  is allowed to return a service-cached snapshot. */
  "settings:refreshCodexDiscovery": {
    req: { force?: boolean };
    res: DesktopCodexDiscoverySnapshot;
  };
  /** Spawn the currently-resolved Codex binary with `--version` and
   *  parse the banner. Used by the AI Providers connection-test row. */
  "settings:testCodex": {
    req: Record<string, never>;
    res: CodexTestResult;
  };
  /** Status of every persisted secret. Never returns plaintext. */
  "settings:secretStatus": {
    req: Record<string, never>;
    res: Record<DesktopSettingsSecretName, SecretStatus>;
  };
  "settings:replaceSecret": {
    req: { name: DesktopSettingsSecretName; value: string };
    res: SecretStatus;
  };
  "settings:clearSecret": {
    req: { name: DesktopSettingsSecretName };
    res: SecretStatus;
  };

  // ---- app ----
  /** Static build/runtime metadata for the About page. Stable shape;
   *  add fields only when a new About row demands them. */
  "app:version": {
    req: Record<string, never>;
    res: {
      version: string;
      electronVersion: string;
      nodeVersion: string;
      chromeVersion: string;
    };
  };
  "app:readDocument": {
    req: { kind: AppDocumentKind };
    res: AppDocument;
  };
  "app:openDocumentWindow": {
    req: { kind: AppDocumentKind };
    res: void;
  };

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
