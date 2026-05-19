// Typed `Commands` registry. Single source of truth across main /
// preload / renderer / external transports (HTTP RPC in Phase 7, MCP
// later). Every command-bus.dispatch(name, req) call typechecks the
// request and the response against this map.
//
// Adding a command: declare it here, then register a handler in
// apps/desktop/src/main/command-bus.ts. The renderer + RPC server pick
// up the new command for free.

import type { Overlay, OverlayRow } from "./overlay-schemas";
import type { CaptureEnrichment, SuggestedTag, AiRunStatus } from "./ai-enrichment-schemas";

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
  /**
   * Set for `kind === "video"` rows. Carries duration, audio-track
   * availability, default range, and preview asset path so the
   * float-over and Library can render without a second round-trip.
   * Null for images.
   */
  video?: VideoCaptureMetadata | null;
};

/**
 * Per-capture metadata for video rows. Mirrors the `video_captures`
 * table (see migration 0005). Stored alongside the source clip so the
 * full source is preserved even after the user picks a quick-output
 * subrange — the editor can always recover the original.
 *
 * `audio` reports which independent tracks the recorder captured.
 * MP4 export's audio toggles read from this; missing tracks render
 * as disabled controls in the float-over.
 *
 * Time fields are seconds (float). `defaultRange` matches whatever the
 * user picked in the float-over scrubber the last time they exported;
 * fresh recordings start with `{ start: 0, end: durationSec }`.
 */
export type VideoCaptureMetadata = {
  durationSec: number;
  containerFormat: "mp4" | "mov";
  hasSystemAudio: boolean;
  hasMicrophoneAudio: boolean;
  defaultRange: VideoRange;
  /** Relative path under captures/ for the silent hover-preview proxy.
   *  Null while preview generation is still in flight (or failed). */
  previewPath: string | null;
  /** Status of the asynchronous preview-proxy generation job. */
  previewStatus: "pending" | "ready" | "failed";
};

/**
 * Inclusive subrange of a recording. Used both for the persisted
 * default range and for per-export requests. `end > start`, both in
 * seconds, both within `[0, durationSec]`. Validated at the bus
 * boundary — a stored range that drifts past `durationSec` is
 * normalized down on read so an out-of-date default can't crash
 * playback after a re-encode.
 */
export type VideoRange = {
  start: number;
  end: number;
};

/**
 * Lifecycle phases the recording service broadcasts over
 * `EVENT_CHANNELS.recordingState`. The selector listens for
 * countdown/recording transitions to lower its overlay; the tray
 * binds Stop UI to `recording`; the Library waits for `ready` to
 * surface the new capture; the float-over loads on `ready`.
 *
 * Carries the optional `captureId` once a row is persisted (`ready`)
 * and an `error` payload on the `failed` arm.
 */
export type RecordingState =
  | { phase: "idle" }
  | { phase: "preflight"; sessionId: string; rect: Rect; displayId: number }
  | {
      phase: "countdown";
      sessionId: string;
      secondsRemaining: number;
      /** The physical-px rect the recording will cover. Carried during
       *  countdown so the in-area overlay can position itself
       *  centered on the recorded surface — the user sees the big
       *  3 / 2 / 1 over their actual content, not in a corner. */
      rect: Rect;
      displayId: number;
    }
  /**
   * The countdown finished but the native recorder hasn't reported
   * `started` yet. Typically only visible on the very first launch
   * when ScreenCaptureKit's `SCShareableContent` enumeration is
   * cold and takes longer than the countdown to resolve. The HUD
   * shows a "Starting…" indicator so the user knows the system is
   * working rather than stuck.
   */
  | { phase: "starting"; sessionId: string; rect: Rect; displayId: number }
  | { phase: "recording"; sessionId: string; startedAt: string; rect: Rect; displayId: number }
  | { phase: "stopping"; sessionId: string }
  | { phase: "processing"; sessionId: string }
  | { phase: "ready"; sessionId: string; captureId: string }
  | { phase: "failed"; sessionId: string; code: string; message: string };

/**
 * Capabilities the user wanted included in this recording session.
 * Screen video is always on. Audio fields are independent — degraded
 * recordings (e.g. mic granted, system audio denied) keep `screen +
 * microphone: true, systemAudio: false` so MP4 export can still offer
 * the mic toggle.
 */
export type RecordingCapabilities = {
  systemAudio: boolean;
  microphone: boolean;
};

/**
 * Subject of the recording. `window` seeds a fixed rect from the
 * selected window's bounds at start-time (does NOT follow the window
 * if it moves). `region` is whatever pixels pass under the static
 * rect. `display` is a full screen recording.
 */
export type RecordingSubject =
  | { kind: "region"; rect: Rect; displayId: number }
  | {
      kind: "window";
      windowId: number;
      rect: Rect;
      displayId: number;
      /**
       * Source app metadata resolved from the window-list helper at
       * selection time. Optional because callers that don't have it
       * (older protocol consumers, programmatic recording without a
       * snap) can omit; recording-service falls back to null on the
       * capture row. When present, the Library shows the real app
       * name ("Microsoft Edge") instead of "Unknown App".
       */
      appName?: string | null;
      appBundleId?: string | null;
    }
  | { kind: "display"; displayId: number };

/**
 * Per-permission readiness status. `granted` is the only state where
 * the corresponding capture path runs without prompting. `denied`
 * needs a System Settings round-trip. `not-determined` can still
 * trigger the OS prompt on next attempt. `unavailable` covers macOS
 * versions / hardware that don't support the capability at all
 * (e.g. system-audio on a macOS earlier than what ScreenCaptureKit
 * exposes).
 */
export type RecordingPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unavailable"
  | "unknown";

/**
 * Snapshot of all permissions the recording pipeline cares about.
 * Stable shape — the System Permissions page binds against it
 * directly, and the recording preflight reuses the same payload to
 * decide whether to show the in-context permission dialog.
 *
 * `screenRecording` is required for any video. The audio fields are
 * optional capabilities; missing them is a degraded recording, not
 * a hard block.
 */
export type RecordingReadiness = {
  screenRecording: RecordingPermissionStatus;
  microphone: RecordingPermissionStatus;
  systemAudio: RecordingPermissionStatus;
  /**
   * Stable hash of the three status values plus the recorder backend
   * identity. Settings persists the last-routed fingerprint so the
   * app doesn't nag the user every launch when nothing has changed.
   */
  fingerprint: string;
};

export type RecordingPermission = "screen" | "microphone" | "systemAudio";

/**
 * GIF or MP4 export request. `range` defaults to the source
 * `defaultRange` when omitted. `audio` is ignored for GIF (always
 * silent) and validated against the source's available tracks for
 * MP4.
 */
export type VideoExportRequest = {
  captureId: string;
  format: "gif" | "mp4";
  range?: VideoRange | undefined;
  audio?: VideoExportAudio | undefined;
};

export type VideoExportAudio = {
  includeSystemAudio: boolean;
  includeMicrophone: boolean;
};

export type VideoExportResult = {
  path: string;
  byteSize: number;
  durationSec: number;
  fromCache: boolean;
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

export type StorageBucket = {
  bytes: number;
  fileCount: number;
};

export type StorageSnapshot = {
  capturedAt: string;
  totalBytes: number;
  sourceCaptures: StorageBucket & {
    captureCount: number;
    documentsBytes: number;
    appSupportBytes: number;
  };
  renderCache: StorageBucket;
  chromiumHttpCache: StorageBucket & {
    reportedBytes: number;
    limitBytes: number;
  };
  chromiumCodeCache: StorageBucket;
  chromiumGpuCaches: StorageBucket;
  database: {
    bytes: number;
    walBytes: number;
    shmBytes: number;
    pageCount: number;
    pageSize: number;
    freelistCount: number;
  };
  otherAppSupport: StorageBucket;
};

export type StorageMaintenanceResult = {
  snapshot: StorageSnapshot;
  clearedBytes: number;
};

export type RenderCacheMaintenanceMode = "trim" | "clear";

export type StorageSummary = {
  capturedAt: string;
  sourceCaptures: {
    bytes: number;
    captureCount: number;
  };
};

export type StorageSnapshotUpdate = {
  snapshot: StorageSnapshot;
  scanning: boolean;
};

/** Identifier for every Settings sidebar page. Used by `settings:open`
 *  to deep-link directly to a section. */
export type SettingsPage =
  | "startup"
  | "appearance"
  | "hotkeys"
  | "notifications"
  | "ai"
  | "capture"
  | "output"
  | "annotate"
  | "storage"
  | "sources"
  | "system-permissions"
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
  "appearance",
  "hotkeys",
  "notifications",
  "ai",
  "capture",
  "output",
  "annotate",
  "storage",
  "sources",
  "system-permissions",
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
    /** When true, completed Codex enrichments are promoted from
     *  `suggested_*` to `accepted_*` automatically — the user doesn't
     *  have to click "Use draft" in the float-over toast. Off by
     *  default; the float-over surfaces an inline checkbox so users
     *  can flip the policy without leaving the capture flow. */
    autoAcceptSuggestions: boolean;
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
    /** Video-capture hotkey. Default `⌘⌥C` (Command+Alt/Option+C),
     *  deliberately NOT `⌘⇧V` — that chord is "Paste and Match
     *  Style" in browsers / Slack / Mail / iWork / Notes / etc.
     *  and globalShortcut.register wins system-wide, so binding
     *  ⌘⇧V would steal paste-without-formatting from every app
     *  on the box while PwrSnap is running. */
    videoCapture: string;
  };
  experimental: {
    /** Slot for the upcoming PwrSnap1 file format. Wired but unused. */
    v2FileFormat: boolean;
  };
  general: {
    /** When true, the View menu exposes Reload / Force Reload / Toggle
     *  Developer Tools. Hidden by default so end-users see the same
     *  trim native menu as any signed Mac app; power users + bug
     *  reporters flip it on in Settings. Mirrors PwrAgnt's
     *  `general.developerMode`. */
    developerMode: boolean;
  };
  /** Per-user UI appearance. `theme: "system"` (default) tracks the
   *  OS-level `prefers-color-scheme`; explicit `"dark"` / `"light"`
   *  pin the renderer regardless of OS. The renderer applies this via
   *  the `data-theme` attribute on `<html>`. */
  appearance: {
    theme: AppearanceTheme;
  };
  updates: {
    /** GitHub release stream the auto-updater follows. `"latest"`
     *  tracks stable releases only; `"prerelease"` also accepts beta /
     *  alpha tags marked `prerelease: true` on GitHub. Mirrors
     *  PwrAgnt's `updates.channel`. The auto-updater re-reads this on
     *  every check, so flipping the toggle takes effect on the next
     *  hourly poll (or immediately if the user invokes Check for
     *  Updates from the Help menu). */
    channel: UpdateChannel;
  };
  /**
   * Per-user defaults the recording UI seeds from. Audio toggles
   * default to OFF — recording the user's microphone or system audio
   * is a privacy-relevant action and must be an explicit opt-in each
   * time, but remembering the last choice cuts friction for the
   * common "I record with mic every time" pattern.
   */
  recording: {
    /** Default toggle for the system-audio MP4 export option. */
    includeSystemAudio: boolean;
    /** Default toggle for the microphone MP4 export option. */
    includeMicrophone: boolean;
    /** Last permission fingerprint we routed the user to System
     *  Permissions for. Empty string = never routed. Recomputed at
     *  startup; if the current fingerprint differs and any permission
     *  needs attention, we route once and write the new fingerprint
     *  back so we don't nag on subsequent launches. */
    lastRoutedPermissionFingerprint: string;
  };
};

/** Theme preference. `"system"` resolves to dark/light via the
 *  renderer's `matchMedia("(prefers-color-scheme: light)")`. */
export type AppearanceTheme = "system" | "dark" | "light";

export const APPEARANCE_THEMES = ["system", "dark", "light"] as const satisfies readonly AppearanceTheme[];

export function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return (
    typeof value === "string" &&
    (APPEARANCE_THEMES as readonly string[]).includes(value)
  );
}

/** Default that mirrors `defaultSettings()` in the desktop service.
 *  Re-exported here so the inline pre-React bootstrap and the renderer
 *  hook can share a single source of truth. */
export const DEFAULT_APPEARANCE: Settings["appearance"] = {
  theme: "system"
};

export type UpdateChannel = "latest" | "prerelease";

/** Deep-partial patch shape. `undefined` = leave untouched. Each nested
 *  object is independently optional so a renderer can write a single
 *  field without echoing the rest. */
export type SettingsPatch = {
  codex?: Partial<Settings["codex"]>;
  ai?: Partial<Settings["ai"]>;
  hotkeys?: Partial<Settings["hotkeys"]>;
  experimental?: Partial<Settings["experimental"]>;
  general?: Partial<Settings["general"]>;
  appearance?: Partial<Settings["appearance"]>;
  updates?: Partial<Settings["updates"]>;
  recording?: Partial<Settings["recording"]>;
};

// ---- App update (auto-updater) types ----
//
// Mirrors the shape PwrAgnt's apps/desktop/src/shared/app-metadata.ts
// exports. PwrSnap's auto-updater (apps/desktop/src/main/auto-updater.ts)
// drives these payloads; the renderer's update banner subscribes to
// `events:app-update:status` for live updates.

export type AppUpdateCheckResult =
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "downloaded"; version: string }
  | { status: "available"; version: string };

export type AppUpdateStatus =
  | { status: "idle" }
  | { status: "skipped"; reason: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

export type AppUpdateInstallResult =
  | { status: "restarting" }
  | { status: "error"; message: string };

export type AppUpdateReleaseInfo = {
  version?: string;
  name?: string;
  url?: string;
  publishedAt?: string;
  unavailableReason?: string;
};

export type AppUpdateReleaseVersions = {
  latest: AppUpdateReleaseInfo;
  prerelease: AppUpdateReleaseInfo;
  fetchedAt: number;
};

export type AiRunSnapshot = {
  id: string;
  captureId: string;
  kind: "enrich";
  status: AiRunStatus;
  error: string | null;
  latencyMs: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type CaptureEnrichmentSummary = {
  captureId: string;
  status: AiRunStatus | null;
  acceptedTitle: string | null;
  acceptedDescription: string | null;
  acceptedTags: string[];
  suggestedTagCount: number;
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
   *   - `timed` — 5-second pre-roll, then the same auto selector as
   *     Quick Capture (region / window / ⇧-full-window). The countdown
   *     ticks next to the menubar tray icon so it doesn't pop a window
   *     that would steal key focus from whatever the user is staging
   *     (dropdowns, tooltips, the PwrSnap tray menu itself). At t=0
   *     the selector takes its frozen-screen snapshot, so the staged
   *     UI is preserved in the picker even though show() inevitably
   *     takes focus.
   */
  "capture:interactive": {
    req: { mode?: "auto" | "region" | "window" | "timed" };
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
  /** Add a user-typed tag to a capture. Normalizes the label, creates
   *  the `tags` row if it doesn't already exist (kind = 'content'),
   *  and writes a `capture_tags` row with `source = 'user'`.
   *  Returns the refreshed enrichment so the renderer can render the
   *  new accepted-tag chip without a follow-up fetch. */
  "library:addTag": {
    req: { captureId: string; label: string };
    res: CaptureEnrichment;
  };
  /** Remove a tag from a capture by label. Looks up the `tags` row by
   *  normalized label and deletes the `capture_tags` join row.
   *  Idempotent — removing a tag that isn't on the capture is a
   *  no-op. The tag row itself is left intact so future captures can
   *  reuse the label (and so the historical tag taxonomy stays
   *  stable for the Codex bias hint). */
  "library:removeTag": {
    req: { captureId: string; label: string };
    res: CaptureEnrichment;
  };
  /** Open the Phase 2 editor window for a capture. Each call opens a
   *  fresh window — edits are per-capture, not singleton. */
  "editor:open": { req: { captureId: string }; res: void };

  // ---- storage ----
  "storage:summary": { req: Record<string, never>; res: StorageSummary };
  "storage:snapshot": { req: { force?: boolean; audit?: boolean }; res: StorageSnapshot };
  "storage:clearAppCache": { req: Record<string, never>; res: StorageMaintenanceResult };
  "storage:maintainRenderCache": {
    req: { mode: RenderCacheMaintenanceMode };
    res: StorageMaintenanceResult;
  };

  // ---- overlays (Phase 2+) ----
  "overlays:list": { req: { captureId: string }; res: OverlayRow[] };
  "overlays:upsert": { req: { captureId: string; overlay: Overlay }; res: OverlayRow };
  "overlays:delete": { req: { id: string }; res: void };

  // ---- copy / share ----
  "clipboard:copy": { req: { captureId: string; preset: RenderPreset }; res: void };
  /** Render (or reuse) the cache file at `preset` and write its POSIX
   *  path as plain text to the system clipboard. The drag affordance
   *  on the same button hands off the file itself; this one is for
   *  pasting the path into terminals, editors, or chat. */
  "clipboard:copy-path": {
    req: { captureId: string; preset: RenderPreset };
    res: { path: string };
  };
  /** Write arbitrary text to the system clipboard. Used for surfaces
   *  that need to ship rendered or extracted text (OCR text, AI-derived
   *  copy, capture summaries) without going through the cache-file
   *  render pipeline that `clipboard:copy` uses. Routes through main
   *  so a future redaction or audit hook only needs to plug in once. */
  "clipboard:copyText": { req: { text: string }; res: void };

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

  // ---- app updates (electron-updater) ----
  /** Force an update check now. Returns the immediate result, but the
   *  real status flow (downloading → downloaded) lands on the
   *  `events:app-update:status` broadcast. Called by the Help → Check
   *  for Updates menu item and by the update banner's retry path. */
  "app:update:check": { req: Record<string, never>; res: AppUpdateCheckResult };
  /** Snapshot read for renderers that mount mid-flight (so the banner
   *  doesn't miss the first status event). */
  "app:update:status": { req: Record<string, never>; res: AppUpdateStatus };
  /** Restart-into-the-downloaded-update. Only valid when status is
   *  `downloaded`; otherwise returns an error. */
  "app:update:install": { req: Record<string, never>; res: AppUpdateInstallResult };
  /** Latest release versions from the GitHub API (independent of the
   *  electron-updater channel). Used by Settings → Updates to show the
   *  candidate version for each channel. */
  "app:update:releases": { req: Record<string, never>; res: AppUpdateReleaseVersions };

  // ---- float-over ----
  "float-over:dismiss": { req: Record<string, never>; res: void };

  // ---- recording (Phase 5 — Fast Video Capture, issue #64) ----
  /**
   * Resolve current screen/microphone/system-audio readiness without
   * prompting. The System Permissions page reads this on mount; the
   * recording preflight reuses the same payload to decide whether to
   * route through the in-context dialog. Cheap — backed by Electron's
   * `systemPreferences` + a single async ScreenCaptureKit probe.
   */
  "permissions:readiness": { req: Record<string, never>; res: RecordingReadiness };
  /**
   * Trigger an OS-level permission prompt where one is possible
   * (microphone). For screen + system-audio the only path is System
   * Settings → Privacy & Security; the response carries `openedSettings`
   * so the renderer can show a "Restart PwrSnap after granting" hint.
   */
  "permissions:request": {
    req: { permission: RecordingPermission };
    res: { status: RecordingPermissionStatus; openedSettings: boolean };
  };
  /**
   * Open System Settings to the right Privacy & Security pane for the
   * requested permission. Used both from the System Permissions page
   * (per-row action) and from the recording-time dialog.
   */
  "permissions:openSystemSettings": {
    req: { permission: RecordingPermission };
    res: void;
  };
  /**
   * Begin a recording session against the given subject (fixed rect or
   * full display) with the requested audio capabilities. Returns the
   * session id; lifecycle updates land on `EVENT_CHANNELS.recordingState`.
   * Concurrent starts are rejected with `code: "already_recording"`.
   *
   * The selector calls this after the user picks Video and the in-area
   * 3-2-1 countdown completes. Headless callers (agents, hotkey) can
   * pass `countdownSeconds: 0` to skip the countdown.
   */
  "recording:start": {
    req: {
      subject: RecordingSubject;
      capabilities: RecordingCapabilities;
      countdownSeconds?: number | undefined;
    };
    res: { sessionId: string };
  };
  /**
   * Stop the active recording. Persists the source clip as a Library
   * item and broadcasts `phase: "ready"` with the new `captureId`.
   * Routes the float-over to LOADED via the existing
   * `events:float-over:state` channel.
   */
  "recording:stop": { req: Record<string, never>; res: { captureId: string } };
  /**
   * Cancel the active recording. Tears down temp files, broadcasts
   * `phase: "idle"`, and does NOT persist a Library row. Used by the
   * Escape key on the in-area control and by the tray's Cancel button.
   */
  "recording:cancel": { req: Record<string, never>; res: void };
  /**
   * Discard the current session and immediately start a new one
   * with the same subject + capabilities. Wired to the Restart
   * button on the recording HUD — saves the user from having to
   * re-pick the same window/region after a botched take. Returns
   * the new session id. Fails with `not_recording` if no session
   * is in flight.
   */
  "recording:restart": { req: Record<string, never>; res: { sessionId: string } };
  /**
   * Current recording state. Renderers that mount mid-flight (the
   * Library window opened after a recording started) call this once
   * on mount to populate before the next broadcast.
   */
  "recording:state": { req: Record<string, never>; res: RecordingState };
  /**
   * Update the persisted default range for a video capture. The
   * float-over scrubber calls this when the user picks a subrange.
   */
  "video:setDefaultRange": {
    req: { captureId: string; range: VideoRange };
    res: void;
  };
  /**
   * Render and return a GIF or MP4 export for the requested range and
   * audio tracks. Cached against (captureId, range, format, audio
   * choices) — re-export with the same args returns instantly.
   * Progress lands on `EVENT_CHANNELS.renderProgress`.
   */
  "video:export": {
    req: VideoExportRequest;
    res: VideoExportResult;
  };

  // ---- codex (Phase 4+) — declared here so Phase 4 lands without protocol bumps ----
  "codex:enrich": { req: { captureId: string }; res: { runId: string } };
  "codex:enrichment": { req: { captureId: string }; res: CaptureEnrichment | null };
  "codex:enrichmentsForCaptures": {
    req: { captureIds: string[] };
    res: CaptureEnrichmentSummary[];
  };
  "codex:acceptTitle": {
    req: { captureId: string; title: string };
    res: CaptureEnrichment;
  };
  "codex:acceptDescription": {
    req: { captureId: string; description: string };
    res: CaptureEnrichment;
  };
  "codex:acceptTag": {
    req: { captureId: string; tagId: string };
    res: CaptureEnrichment;
  };
  "codex:rejectTag": {
    req: { captureId: string; tagId: string };
    res: CaptureEnrichment;
  };
  "codex:runStatus": { req: { runId: string }; res: AiRunSnapshot | null };
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
