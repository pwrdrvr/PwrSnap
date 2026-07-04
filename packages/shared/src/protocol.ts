// Typed `Commands` registry. Single source of truth across main /
// preload / renderer / external transports (HTTP RPC in Phase 7, MCP
// later). Every command-bus.dispatch(name, req) call typechecks the
// request and the response against this map.
//
// Adding a command: declare it here, then register a handler in
// apps/desktop/src/main/command-bus.ts. The renderer + RPC server pick
// up the new command for free.

import type { BundleLayerNode } from "./bundle-manifest-schema-v2";
import type { CaptureEnrichment, SuggestedTag, AiRunStatus } from "./ai-enrichment-schemas";

export type Rect = { x: number; y: number; w: number; h: number };

export type CaptureRecord = {
  id: string;
  kind: "image" | "video";
  captured_at: string;
  /**
   * Pre-bundle-migration src_path. NULL for captures created after
   * the bundle migration shipped. Historical record only — never
   * read by the live read path; the legacy migration consumes this
   * once when converting old rows to bundle pairs.
   */
  legacy_src_path: string | null;
  /**
   * Path to the `.pwrsnap` ZIP bundle under ~/Documents/PwrSnap/.
   * The system of record post-migration. NULL until the legacy
   * migration walks this row.
   */
  bundle_path: string | null;
  /**
   * Paired flat composite PNG sibling — the user-shareable image
   * that double-clicks open in Photos / Quick Look / Slack.
   * Regenerable from the bundle's composite.png; the doctor
   * recreates it if missing.
   */
  flat_png_path: string | null;
  /** ISO-8601 timestamp of the most recent bundle re-pack. */
  bundle_modified_at: string | null;
  /**
   * v1 = flat overlays array; v2 = layer tree. Cached projection of
   * `manifest.bundle_format_version` from the on-disk bundle; the
   * doctor reconciles this on every reconcile pass so a rename-vs-
   * UPDATE crash gap doesn't leave the row claiming v1 while the
   * bundle is v2. Stored value is a hint, not authoritative — read
   * paths that need to dispatch on format should consult the bundle.
   */
  bundle_format_version: number;
  /**
   * Convergence checkpoint with the bundle's edit state
   * (overlays.json for v1; document.json/layers for v2). A re-pack is
   * owed when `edits_version > bundle_edits_version` (e.g., detected
   * on boot after a crash mid-debounce).
   */
  bundle_edits_version: number;
  width_px: number;
  height_px: number;
  device_pixel_ratio: number;
  byte_size: number;
  sha256: string;
  source_app_bundle_id: string | null;
  source_app_name: string | null;
  /**
   * Monotonic counter, bumped in the same transaction as every
   * edit write (overlay insert for v1; layer insert for v2 — see
   * `insertOverlay` / `rejectOverlay` in persistence/overlays-repo.ts
   * and the future `insertLayer` in persistence/layers-repo.ts).
   * Renderers append this to the `pwrsnap-cache://` URL as a
   * cache-buster so Chromium re-fetches the rendered image after
   * the user edits — without it the 5-minute browser HTTP cache
   * serves the stale render.
   *
   * Renamed from `overlays_version` in migration 0004 to unify v1/v2
   * convergence semantics. The table being read (overlays vs layers)
   * is gated by `bundle_format_version`.
   */
  edits_version: number;
  deleted_at: string | null;
  /**
   * True when the source PNG had at least one non-opaque pixel at persist
   * time (sharp `stats().isOpaque === false`). The Library grid + editor
   * paint a transparency checker behind the thumbnail when set, so a
   * genuinely-transparent capture is distinguishable from a black/white
   * fill. Always `false` for videos and for pre-0025 rows (defaulted by
   * migration without a backfill — see migration 0025).
   */
  has_alpha: boolean;
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

/**
 * `permissions:readiness` response. Superset of {@link RecordingReadiness}
 * (the OS-level snapshot) plus PwrSnap's own memory of whether it has ever
 * triggered the macOS screen-capture prompt. The System Permissions page
 * needs the flag to choose between offering "Request access" (fires the OS
 * prompt on a fresh install) and "Open System Settings" (once macOS has
 * already recorded a decision and won't re-prompt). See
 * {@link Settings.recording.screenCapturePrompted} for the macOS quirk
 * that makes this necessary.
 */
export type PermissionReadinessReport = RecordingReadiness & {
  screenCapturePrompted: boolean;
};

export type RecordingPermission = "screen" | "microphone" | "systemAudio";

/**
 * Quality tier for a video export. Mirrors the image `RenderPreset`
 * shape (low / med / high) so the renderer's preset cards feel like
 * siblings of the image L/M/H row. Each (format, preset) maps to a
 * specific encode profile (dimensions, fps, codec params) owned by
 * the main-side `recording-exporter`. See plan
 * [docs/plans/2026-05-27-001-feat-video-export-presets-plan.md] §2
 * for the current tier values.
 */
export type VideoPreset = "low" | "med" | "high";

/**
 * GIF or MP4 export request. `preset` is required — the caller picks
 * a tier (LMH); the backend never guesses. `range` defaults to the
 * source `defaultRange` when omitted. `audio` is ignored for GIF
 * (always silent) and validated against the source's available
 * tracks for MP4.
 */
export type VideoExportRequest = {
  captureId: string;
  format: "gif" | "mp4";
  preset: VideoPreset;
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
  /** Output width in pixels. Source-resolution presets (HIGH) match
   *  the source; LOW / MED apply the preset's downscale target. */
  widthPx: number;
  heightPx: number;
  fromCache: boolean;
};

/** Per-(format, preset) metric returned by `video:presetMetrics`.
 *  Mirrors `CapturePresetMetric` for images. Estimated values come
 *  back when no cache entry exists yet; exact values land after the
 *  first encode for that combination. */
export type VideoPresetMetric = {
  format: "gif" | "mp4";
  preset: VideoPreset;
  widthPx: number;
  heightPx: number;
  byteSize: number;
  fromCache: boolean;
};

export type VideoPresetMetricsResult = {
  metrics: VideoPresetMetric[];
};

/** Response from `video:prepareDrag` — mirrors `capture:prepareDrag`.
 *  `path` is the human-friendly file alias (e.g.
 *  `<filename-stem>-<preset>.<ext>`); `iconPath` points at the poster
 *  PNG used as the drag preview. */
export type VideoPrepareDragResult = {
  path: string;
  iconPath: string;
};

/** Identifies a specific cached video export. Used as the request
 *  shape for all the per-preset verbs (`video:prepareDrag`,
 *  `clipboard:copyVideoFile`, `clipboard:copyVideoPath`) so they
 *  agree on the same source-of-truth tuple. Range + audio are
 *  optional — when omitted, the handler fills them from the source
 *  record's `defaultRange` + recorded audio policy. */
export type VideoExportCoordinates = {
  captureId: string;
  format: "gif" | "mp4";
  preset: VideoPreset;
  range?: VideoRange | undefined;
  audio?: VideoExportAudio | undefined;
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

/**
 * Request shape for `library:search`. Every field is optional; supplied
 * fields combine conjunctively (AND). An all-empty request returns the
 * most-recent N captures (effectively `library:list` with a different
 * envelope) — callers should still pass `limit` so they don't get the
 * full library.
 */
export type CaptureSearchRequest = {
  /** Free-text query against title / description / OCR / source app
   *  name via the `capture_search_fts` FTS5 virtual table (migration
   *  0017). When omitted, the search degenerates to a filter-only
   *  scan ordered by `captured_at DESC`. */
  query?: string;
  /** Restrict to specific source apps. Pass `null` inside the array to
   *  match captures with no `source_app_bundle_id`. */
  appBundleIds?: Array<string | null>;
  /** Restrict to image / video kinds (empty array or absent = both). */
  kinds?: Array<"image" | "video">;
  /** ISO-8601 range, inclusive. Matched against `captured_at`. */
  dateRange?: { start: string; end: string };
  /** If true, only return captures whose `capture_enrichments.ocr_text`
   *  is non-empty. If false / absent, no OCR filter. */
  hasOcr?: boolean;
  /** Hard cap on rows returned. Defaults to 100; max 500. */
  limit?: number;
};

export type CaptureSearchResultRow = {
  record: CaptureRecord;
  /** Enrichment row, or `null` if the capture has never been through
   *  an AI run and has no user tags. (Same null semantics as
   *  `codex:enrichment`.) */
  enrichment: CaptureEnrichment | null;
  /** SQLite `snippet()` output around the FTS5 hit — a short fragment
   *  with the matched terms highlighted via `[hit]…[/hit]` markers.
   *  Non-null only when the request had a `query` AND the hit came
   *  from FTS5 (not a filter-only result). Caller-side renderer can
   *  strip the markers or render them as `<mark>`. */
  matchSnippet: string | null;
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

/**
 * Health snapshot for reads of the user's captures folder
 * (`~/Documents/PwrSnap`). On macOS, reads of user-owned files there
 * fail with EPERM when the app's TCC client (for dev runs: the
 * terminal that launched it) lacks Files & Folders → Documents
 * access AND the file carries no per-file `com.apple.macl` grant.
 * The symptom is silently broken thumbnails — the record exists, the
 * file exists, but every `open()` is denied.
 *
 * `denied` flips true on the first denial of the session and back to
 * false if every previously-denied path later reads successfully
 * (e.g. the user granted access mid-session). `deniedPathCount`
 * counts DISTINCT denied files, not raw failures, so render retries
 * don't inflate it. On full recovery the whole snapshot returns to the
 * healthy baseline (`denied: false`, count 0, all fields null), so the
 * timestamps below are scoped to the CURRENT denial episode, not the
 * lifetime of the process.
 */
export type CapturesAccessHealth = {
  denied: boolean;
  deniedPathCount: number;
  /** One affected absolute path, for log/UI context. Null whenever
   *  `denied` is false. */
  samplePath: string | null;
  /** When the current denial episode's first denial was observed.
   *  Null whenever `denied` is false; re-armed on the next episode. */
  firstDeniedAt: string | null;
  /** Most recent denial in the current episode. Null whenever `denied`
   *  is false. */
  lastDeniedAt: string | null;
};

/** Identifier for every Settings sidebar page. Used by `settings:open`
 *  to deep-link directly to a section. */
export type SettingsPage =
  | "general"
  | "hotkeys"
  | "ai"
  | "storage"
  | "system-permissions"
  | "experimental"
  | "developer"
  | "about";

/** Runtime allowlist of every valid `SettingsPage`. Kept here (not in
 *  the renderer's `settings-categories.ts`) so the main process can
 *  validate `settings:open` / `events:settings:navigate` payloads
 *  without importing renderer code. Stays in lock-step with the union
 *  above via the `satisfies` clause — adding a member to the union
 *  without adding the literal here is a type error. */
export const SETTINGS_PAGES = [
  "general",
  "hotkeys",
  "ai",
  "storage",
  "system-permissions",
  "experimental",
  "developer",
  "about"
] as const satisfies readonly SettingsPage[];

export const HOT_CPU_PROFILE_START_DELAYS_MS = [0, 5_000, 10_000] as const;
export type HotCpuProfileStartDelayMs =
  (typeof HOT_CPU_PROFILE_START_DELAYS_MS)[number];
export const HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS: HotCpuProfileStartDelayMs = 0;

export const HOT_CPU_PROFILE_TRIGGER_MODES = [
  "spike",
  "sustained",
  "slowburn"
] as const;
export type HotCpuProfileTriggerMode =
  (typeof HOT_CPU_PROFILE_TRIGGER_MODES)[number];
export const HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT: HotCpuProfileTriggerMode = "sustained";
export const HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT = 15;

export function isHotCpuProfileStartDelayMs(
  value: number
): value is HotCpuProfileStartDelayMs {
  return HOT_CPU_PROFILE_START_DELAYS_MS.includes(value as HotCpuProfileStartDelayMs);
}

export function isHotCpuProfileTriggerMode(
  value: string
): value is HotCpuProfileTriggerMode {
  return HOT_CPU_PROFILE_TRIGGER_MODES.includes(value as HotCpuProfileTriggerMode);
}

export type HotCpuProfileHeapSnapshotArtifact = {
  filename: string;
  path: string;
  phase: string;
};

export type HotCpuProfileCapturedEvent = {
  capturedAt: string;
  heapSnapshotArtifacts?: HotCpuProfileHeapSnapshotArtifact[];
  profileFilename: string;
  profilePath: string;
  sessionDirectory: string;
  sessionDirectoryName: string;
  triggerConsecutiveSamples: number;
  triggerCpuPercent: number;
  triggerMode: HotCpuProfileTriggerMode;
  triggerThresholdPercent: number;
};

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatHotCpuProfileTriggerMode(
  mode: HotCpuProfileTriggerMode
): string {
  switch (mode) {
    case "spike":
      return "Spike";
    case "sustained":
      return "Sustained";
    case "slowburn":
      return "Slowburn";
  }
}

export function formatHotCpuProfileTriggerSummary(
  event: Pick<
    HotCpuProfileCapturedEvent,
    | "triggerConsecutiveSamples"
    | "triggerCpuPercent"
    | "triggerMode"
    | "triggerThresholdPercent"
  >
): string {
  const sampleLabel =
    event.triggerConsecutiveSamples === 1
      ? "1 sample"
      : `${event.triggerConsecutiveSamples} consecutive samples`;
  return [
    `${formatHotCpuProfileTriggerMode(event.triggerMode)} (`,
    `${sampleLabel} >= ${formatPercent(event.triggerThresholdPercent)}%; `,
    `trigger sample ${formatPercent(event.triggerCpuPercent)}%)`
  ].join("");
}

export function buildHotCpuProfileHandoffMessage(
  event: HotCpuProfileCapturedEvent
): string {
  const heapSnapshotArtifacts = event.heapSnapshotArtifacts ?? [];
  const heapSnapshotLines =
    heapSnapshotArtifacts.length > 0
      ? [
          `Heap snapshots captured: ${heapSnapshotArtifacts.length}`,
          ...heapSnapshotArtifacts.flatMap((artifact) => [
            `Heap snapshot ${artifact.phase} basename: ${artifact.filename}`,
            `Heap snapshot ${artifact.phase} path: ${artifact.path}`
          ])
        ]
      : [];

  return [
    "PwrSnap captured a renderer CPU profile.",
    `Trigger: ${formatHotCpuProfileTriggerSummary(event)}`,
    `Session basename: ${event.sessionDirectoryName}`,
    `Session directory path: ${event.sessionDirectory}`,
    `CPU profile basename: ${event.profileFilename}`,
    `CPU profile path: ${event.profilePath}`,
    ...heapSnapshotLines,
    "Open the .cpuprofile in Chrome DevTools Performance, or inspect the full session directory for samples, events, and optional heap snapshots."
  ].join("\n");
}

export function isSettingsPage(value: unknown): value is SettingsPage {
  return (
    typeof value === "string" &&
    (SETTINGS_PAGES as readonly string[]).includes(value)
  );
}

/** Every secret the app persists. Plaintext values never cross the IPC
 *  boundary — the renderer only ever sees the status shape below. */
export type DesktopSettingsSecretName = "openaiApiKey";

export type SizzleTtsProvider = "openai";
export type SizzleTtsModel = "tts-1" | "tts-1-hd";
export type SizzleVoice =
  | "alloy"
  | "echo"
  | "fable"
  | "onyx"
  | "nova"
  | "shimmer";

export const SIZZLE_VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer"
] as const satisfies readonly SizzleVoice[];

/**
 * Trim range for a video-backed scene. start/end are seconds within
 * the source clip. The composer applies these as `-ss start -t (end-start)`.
 * NULL for image scenes; required for video scenes (seeded from
 * `record.video.defaultRange` when a video is first added).
 */
export type SizzleMediaTrim = {
  startSec: number;
  endSec: number;
};

/**
 * Per-scene audio source policy. Resolves at render time based on the
 * scene's capture kind and script line presence:
 *
 *   - "auto" (default):
 *       • Image scene → behaves like "voiceover" (always TTS).
 *       • Video scene with non-empty scriptLine → "voiceover" (TTS
 *         plays, video audio muted).
 *       • Video scene with empty scriptLine → "native" (the video's
 *         own audio plays).
 *   - "native": play the video's recorded audio for the trim range.
 *       Only meaningful for video scenes; for image scenes the
 *       composer falls back to "muted".
 *   - "voiceover": always synthesize TTS from scriptLine. Requires a
 *       non-empty scriptLine at render time.
 *   - "muted": no audio for this scene (composer feeds a silent mp3
 *       of the scene duration into the audio concat list).
 */
export type SizzleAudioSource = "auto" | "native" | "voiceover" | "muted";

export const SIZZLE_AUDIO_SOURCES = [
  "auto",
  "native",
  "voiceover",
  "muted"
] as const satisfies readonly SizzleAudioSource[];

export type SizzleTransitionType =
  | "none"
  | "cut"
  | "crossfade"
  | "dip-black"
  | "dip-white"
  | "push-left"
  | "slide-left"
  | "zoom-cut";

/**
 * Transition INTO this scene or beat from the previous one. The first
 * scene/beat transition is ignored (nothing precedes it). Older projects
 * stored this as a bare string ("cut" | "crossfade"); the object form
 * carries per-boundary duration while keeping read-path compatibility.
 */
export type SizzleTransition =
  | "cut"
  | "crossfade"
  | { type: SizzleTransitionType; durationSec: number };

export const SIZZLE_TRANSITIONS = [
  "none",
  "cut",
  "crossfade",
  "dip-black",
  "dip-white",
  "push-left",
  "slide-left",
  "zoom-cut"
] as const satisfies readonly SizzleTransitionType[];

/** Default crossfade duration in seconds. */
export const SIZZLE_CROSSFADE_SEC = 0.4;
export const SIZZLE_BEAT_TRANSITION_SEC = 0.18;

export function sizzleTransitionType(
  transition: SizzleTransition
): SizzleTransitionType {
  return typeof transition === "string" ? transition : transition.type;
}

export function sizzleTransitionDurationSec(
  transition: SizzleTransition
): number {
  if (typeof transition !== "string") return transition.durationSec;
  return transition === "crossfade" ? SIZZLE_CROSSFADE_SEC : 0;
}

export function normalizeSizzleTransition(
  transition: SizzleTransition | SizzleTransitionType | null | undefined,
  defaults: { type?: SizzleTransitionType; durationSec?: number } = {}
): SizzleTransition {
  if (transition === "cut" || transition === "crossfade") return transition;
  if (typeof transition === "string") {
    return {
      type: transition,
      durationSec:
        defaults.durationSec ??
        (transition === "none" ? 0 : SIZZLE_BEAT_TRANSITION_SEC)
    };
  }
  if (transition !== null && transition !== undefined) {
    return {
      type: transition.type,
      durationSec: transition.durationSec
    };
  }
  const type = defaults.type ?? "crossfade";
  if (type === "cut" || type === "crossfade") return type;
  return {
    type,
    durationSec: defaults.durationSec ?? SIZZLE_BEAT_TRANSITION_SEC
  };
}

export type SizzleVideoFitPolicy =
  | "trim"
  | "freeze-end"
  | "loop"
  | "ping-pong"
  | "speed-to-fit"
  | "smart-fit";

export const SIZZLE_VIDEO_FIT_POLICIES = [
  "trim",
  "freeze-end",
  "loop",
  "ping-pong",
  "speed-to-fit",
  "smart-fit"
] as const satisfies readonly SizzleVideoFitPolicy[];

export type SizzleBeatTiming =
  | {
      kind: "offset";
      startSec: number;
      endSec: number | null;
    }
  | {
      kind: "phrase";
      phrase: string;
      occurrence: number | null;
      offsetSec: number;
      durationSec: number | null;
    }
  // No explicit timing: the beat's start is derived by evenly dividing the
  // span between the anchored ("keyframe") beats that bound it. See
  // `distributeSequenceBeatStarts`. This is the default for new beats.
  | { kind: "auto" };

export type SizzleSequenceBeat = {
  id: string;
  captureId: string;
  timing: SizzleBeatTiming;
  mediaTrim: SizzleMediaTrim | null;
  transition: SizzleTransition;
  videoFit: SizzleVideoFitPolicy;
};

/**
 * Sequence beats are start anchors, not independent audio clips.
 * A non-final beat must run until the next beat's anchor; otherwise the
 * composer would cut a hole out of the continuous narration.
 *
 * The "first beat starts at 0" rule is NOT enforced here — it is a planner
 * rule (`distributeSequenceBeatStarts` pins index 0 to 0). Keeping it out of
 * the stored data means an `offset`/`phrase` anchor dragged to the front is
 * *parked* (inactive while it is first), not destroyed, and is restored if it
 * moves back. `auto` beats carry no length, so the non-final nulling below is
 * a no-op for them.
 */
export function normalizeSizzleSequenceBeatContinuity(
  beats: SizzleSequenceBeat[]
): SizzleSequenceBeat[] {
  return beats.map((beat, index) => {
    let timing = beat.timing;
    if (index < beats.length - 1) {
      if (timing.kind === "offset" && timing.endSec !== null) {
        timing = { ...timing, endSec: null };
      } else if (timing.kind === "phrase" && timing.durationSec !== null) {
        timing = { ...timing, durationSec: null };
      }
    }
    return timing === beat.timing ? beat : { ...beat, timing };
  });
}

/**
 * Place every sequence beat's start time using the auto/anchor model.
 *
 * `anchors[i]` is the RESOLVED start time (seconds) for an anchored beat
 * (`offset`, or a resolved `phrase`), or `null` for an `auto` beat — and for
 * an anchor that failed to resolve, which degrades to auto. The caller
 * resolves anchors however it can (the main planner uses speech timing; the
 * renderer's idle fallback only knows offsets); this function owns ONLY the
 * even-division math, so preview, the editor strip, and the final render can
 * never disagree.
 *
 * Rules:
 *  - Index 0 is always the head anchor at 0 (the first beat covers narration
 *    from the start); its `anchors[0]` value is ignored.
 *  - A run of N consecutive auto beats between anchor A (time `tA`) and the
 *    next anchor B (time `tB`, or the timeline end) divides `[tA, tB]` into
 *    N+1 equal slices; the leading anchor keeps slice 0.
 *  - Anchor times are clamped MONOTONICALLY (an anchor can never precede the
 *    previous one), so reordering can never produce a negative slice.
 */
export function distributeSequenceBeatStarts(
  anchors: ReadonlyArray<number | null>,
  durationSec: number
): number[] {
  const n = anchors.length;
  if (n === 0) return [];
  const dur = Math.max(0.1, durationSec);
  const starts = new Array<number>(n);
  starts[0] = 0;
  let runAnchorIdx = 0;
  let runAnchorTime = 0;
  const fillRun = (anchorIdx: number, tA: number, boundIdx: number, tB: number): void => {
    const autoCount = boundIdx - anchorIdx - 1;
    if (autoCount <= 0) return;
    const slice = (tB - tA) / (autoCount + 1);
    for (let k = 1; k <= autoCount; k++) starts[anchorIdx + k] = tA + k * slice;
  };
  for (let i = 1; i < n; i++) {
    const a = anchors[i];
    if (a === null || !Number.isFinite(a)) continue; // auto — fill later
    const t = Math.min(Math.max(a, runAnchorTime), dur); // monotonic clamp
    fillRun(runAnchorIdx, runAnchorTime, i, t);
    starts[i] = t;
    runAnchorIdx = i;
    runAnchorTime = t;
  }
  fillRun(runAnchorIdx, runAnchorTime, n, dur); // trailing run → timeline end
  return starts.map((s) => Math.round(s * 1000) / 1000);
}

export type SizzleSpeechTimingQuality = "precise" | "approximate";

export type SizzleSpeechTimingWarningCode =
  | "precise_unavailable"
  | "precise_failed"
  | "timing_cache_failed"
  | "empty_narration"
  | "invalid_duration"
  | "phrase_unresolved";

export type SizzleSpeechTimingWarning = {
  code: SizzleSpeechTimingWarningCode;
  message: string;
};

export type SizzleWordTiming = {
  index: number;
  word: string;
  normalized: string;
  startSec: number;
  endSec: number;
};

export type SizzleSpeechTiming = {
  text: string;
  durationSec: number;
  quality: SizzleSpeechTimingQuality;
  words: SizzleWordTiming[];
  warnings: SizzleSpeechTimingWarning[];
};

export type SizzleResolvedPhraseTiming = {
  startSec: number;
  endSec: number;
  quality: SizzleSpeechTimingQuality;
  wordStartIndex: number;
  wordEndIndex: number;
  matchedText: string;
  warnings: SizzleSpeechTimingWarning[];
};

export type SizzleSequencePreviewWarning = {
  beatId?: string;
  code: string;
  message: string;
};

export type SizzleSequencePreviewVideoFit = {
  renderMode: "trim" | "freeze-end" | "loop" | "ping-pong" | "speed-to-fit";
  inputDurationSec: number;
  playbackRate: number;
};

export type SizzleSequencePreviewBeat = {
  beatId: string;
  captureId: string;
  startSec: number;
  endSec: number;
  timing: SizzleBeatTiming;
  transition: SizzleTransition;
  videoFit: SizzleVideoFitPolicy;
  mediaTrim?: SizzleMediaTrim | null;
  fit?: SizzleSequencePreviewVideoFit | null;
};

export type SizzleSequenceTranscriptPhrase = {
  text: string;
  startSec: number;
  endSec: number;
  wordStartIndex: number;
  wordEndIndex: number;
};

export type SizzleSequencePreviewPlan = {
  audioBase64: string;
  mimeType: "audio/mpeg";
  durationSec: number;
  timingQuality: SizzleSpeechTimingQuality;
  warnings: SizzleSequencePreviewWarning[];
  transcriptPhrases: SizzleSequenceTranscriptPhrase[];
  beats: SizzleSequencePreviewBeat[];
};

/**
 * Resolve a scene's audio source policy to a concrete choice at
 * render time. Single source of truth — `auto` collapses based on
 * the capture kind + script presence; explicit values pass through
 * with one fallback (`native` on an image scene is impossible →
 * `muted`).
 *
 * Pure, deterministic, no I/O — lives in `@pwrsnap/shared` so both
 * the main-process render path and the renderer's editor UI gate
 * preview/script controls off the SAME computation. Previously
 * duplicated in both processes; that's a guaranteed-divergence
 * footgun.
 *
 * Semantics:
 *   image, auto                  → "voiceover"  (only meaningful)
 *   image, voiceover             → "voiceover"
 *   image, native                → "muted"      (no source audio)
 *   image, muted                 → "muted"
 *   video, auto, no script       → "native"     (let the clip talk)
 *   video, auto, with script     → "voiceover"  (TTS over muted clip)
 *   video, native                → "native"
 *   video, voiceover             → "voiceover"
 *   video, muted                 → "muted"
 */
export function resolveSizzleAudioSource(
  audioSource: SizzleAudioSource,
  captureKind: "image" | "video",
  scriptLine: string
): "native" | "voiceover" | "muted" {
  if (audioSource !== "auto") {
    if (captureKind === "image" && audioSource === "native") return "muted";
    return audioSource;
  }
  if (captureKind === "image") return "voiceover";
  return scriptLine.trim().length === 0 ? "native" : "voiceover";
}

export type SizzleScene = {
  id: string;
  /** `simple` is the legacy/current one-capture scene. `sequence`
   *  keeps one continuous narration block with many visual beats.
   *  Older projects have no kind; the store normalizes them to simple. */
  kind?: "simple" | "sequence";
  captureId: string;
  /** For sequence scenes this mirrors `narration` for compatibility
   *  with legacy UI and agent views until every surface is sequence-aware. */
  scriptLine: string;
  narration?: string;
  beats?: SizzleSequenceBeat[];
  durationOverrideSec: number | null;
  /** Trim range for video-backed scenes. NULL for image scenes (the
   *  composer ignores it for images). Required at render time for
   *  video scenes; seeded from `record.video.defaultRange` on add. */
  mediaTrim: SizzleMediaTrim | null;
  /** See `SizzleAudioSource`. Defaults to "auto" — resolves per-scene
   *  based on capture kind + scriptLine at render time. */
  audioSource: SizzleAudioSource;
  /** Transition INTO this scene. Ignored on scene 0. Defaults to
   *  "crossfade" for new simple scenes. */
  transition: SizzleTransition;
};

export type SizzleProject = {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  /** Stable cover image for Library/project surfaces. This is set when
   *  scenes are first added and then travels with the project instead of
   *  requiring thumbnail callers to understand simple vs sequence scenes. */
  coverCaptureId: string | null;
  scenes: SizzleScene[];
  voice: SizzleVoice;
  ttsModel: SizzleTtsModel;
  ttsProvider: SizzleTtsProvider;
  resolution: "1080p" | "720p";
  outputPath: string | null;
  lastRenderedAt: string | null;
};

export function firstSizzleSceneCaptureId(scene: SizzleScene): string | null {
  if (scene.kind === "sequence") {
    return scene.beats?.find((beat) => beat.captureId.length > 0)?.captureId ?? null;
  }
  return scene.captureId.length > 0 ? scene.captureId : null;
}

export function defaultSizzleProjectCoverCaptureId(
  scenes: readonly SizzleScene[]
): string | null {
  for (const scene of scenes) {
    const captureId = firstSizzleSceneCaptureId(scene);
    if (captureId !== null) return captureId;
  }
  return null;
}

export function resolveSizzleProjectCoverCaptureId(project: SizzleProject): string | null {
  return project.coverCaptureId ?? defaultSizzleProjectCoverCaptureId(project.scenes);
}

/**
 * The Project Asset Cart — a single global "draft" the user fills by
 * checking captures in the Library, then commits into a new or
 * existing Sizzle Reel. Persisted at `<userData>/draft-cart.json` so
 * it survives app restart (locked decision — Spotify-queue mental
 * model). There is exactly ONE cart at a time (no multi-draft); the
 * cart store is a process-wide singleton.
 *
 * `captureIds` is ordered by check sequence — the order the user
 * checked items is the order scenes get created in on commit. New
 * checks append to the end.
 */
export type DraftCart = {
  /** User-editable label. Defaults to "Untitled draft". Becomes the
   *  new project's name on `cart:commitToNewProject` if the caller
   *  doesn't override it. */
  name: string;
  /** Capture ids in check order. Deduped — toggling an already-present
   *  id removes it rather than adding a second entry. */
  captureIds: string[];
  createdAt: string;
  /** Bumped on every mutation. */
  modifiedAt: string;
};

export type SizzleRenderProgressPhase =
  | "tts"
  | "compose"
  | "encode"
  | "done"
  | "failed";

export type SizzleRenderProgressEvent = {
  projectId: string;
  phase: SizzleRenderProgressPhase;
  message: string;
  ratio: number;
  error?: { code: string; message: string };
};

/**
 * Main → every BrowserWindow during a `cart:exportZip`. The renderer that
 * started the job (matched by `jobId`) shows a determinate bar + a Cancel
 * button. `rendering` fires once per image as it's rasterized; `zipping`
 * fires once the render loop finishes and the archive is being written;
 * `done` is the terminal beat (the dispatch result carries the real
 * outcome, so subscribers only need this to clear their UI).
 */
export type CartExportProgressPhase = "rendering" | "zipping" | "done";

export type CartExportProgressEvent = {
  jobId: string;
  phase: CartExportProgressPhase;
  /** Images rasterized so far (rendered + failed). */
  completed: number;
  /** Total images that survived the skip-filter. */
  total: number;
};

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

export type DesktopCodexAuthStatus =
  | "authenticated"
  | "unauthenticated"
  | "failed";

export type DesktopCodexAuthProbe = {
  status: DesktopCodexAuthStatus;
  testedAt: string;
  durationMs: number;
  detail?: string;
  errorMessage?: string;
};

export type DesktopCodexDiscoverySnapshot = {
  candidates: DesktopCodexDiscoveryCandidate[];
  /** The path that `resolveCodexCommand` will pick for the next spawn,
   *  or `null` if none is usable. Renderers compare to `candidate.path`
   *  to draw the "Using" badge. */
  resolvedPath: string | null;
  /** Auth readiness for `resolvedPath`, from `codex login status`.
   *  `null` means no usable Codex binary resolved. */
  auth: DesktopCodexAuthProbe | null;
  /** ISO-8601 timestamp of when this snapshot was produced. */
  refreshedAt: string;
};

// ---- Codex auth-profile management (Settings → AI) ---------------------
//
// A Codex "auth profile" maps 1:1 to a CODEX_HOME directory: the System
// default (`~/.codex`) plus any `~/.codex/profiles/<name>` directory. Each
// profile carries its own `auth.json`, so a user can keep multiple ChatGPT
// accounts and switch the active one. The active profile persists via the
// existing `settings.codex.profile` string ("" = System default).
//
// The shapes below mirror `@pwrdrvr/codex-discovery`'s
// `CodexAuthProfileCandidate` / `CodexProfileLoginResponse` so the handlers
// can map the kit output straight onto the protocol with no information loss.

export type DesktopCodexAuthProfileStatus =
  | "authenticated"
  | "unauthenticated"
  | "failed";

/** One Codex auth profile surfaced in Settings → AI. `name === ""` is the
 *  System default (`~/.codex`); any other name is a
 *  `~/.codex/profiles/<name>` directory. `selected` reflects the persisted
 *  `settings.codex.profile`. Auth fields come from `codex login status` +
 *  the JWT in `auth.json`. */
export type DesktopCodexAuthProfile = {
  /** Canonical profile name; "" for the System default. */
  name: string;
  /** Human label ("System default" for the default home, else the name). */
  displayName: string;
  /** Resolved CODEX_HOME directory for this profile. */
  codexHome: string;
  /** True when this profile equals the persisted `settings.codex.profile`. */
  selected: boolean;
  /** Whether `auth.json` is present on disk (cheap, no spawn). */
  hasAuthFile: boolean;
  /** Result of `codex login status` for this profile's CODEX_HOME. */
  status: DesktopCodexAuthProfileStatus;
  /** ChatGPT account email from the JWT, when signed in. */
  email?: string;
  /** ChatGPT plan type from the JWT, when signed in. */
  planType?: string;
};

export type DesktopCodexAuthProfileList = {
  /** `~/.codex/profiles` directory the named profiles live under. */
  profileRoot: string;
  /** CODEX_HOME of the currently-selected profile. */
  effectiveCodexHome: string;
  profiles: DesktopCodexAuthProfile[];
  /** Discovery-level error (e.g. unreadable profile root), if any. */
  error?: string;
};

/** Outcome of starting (or completing) a Codex OAuth login for a profile.
 *  `started: true` means the login child spawned and (usually) the OAuth URL
 *  was opened in the browser; the user finishes in the browser. `started:
 *  false` + `authenticated: true` means the child exited already
 *  authenticated. `loginUrl` is the scraped OAuth URL (already handed to the
 *  browser via shell.openExternal). */
export type DesktopCodexProfileLoginResult = {
  profile: string;
  codexHome: string;
  started: boolean;
  authenticated?: boolean;
  loginUrl?: string;
  detail?: string;
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

/** Fallback Codex CLI models PwrSnap can show before `model/list` returns.
 *  The actual model picker is populated from the user's installed Codex
 *  App Server so newly-available models don't require an app release. */
export const CODEX_CAPTION_MODELS = ["gpt-5.4-mini"] as const;
export type CodexCaptionModel = string;
export const DEFAULT_CODEX_CAPTION_MODEL: CodexCaptionModel = "gpt-5.4-mini";

export function isCodexCaptionModel(value: unknown): value is CodexCaptionModel {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

export type CodexModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  inputModalities: Array<"text" | "image">;
  defaultServiceTier: string | null;
  isDefault: boolean;
};

export type CodexModelList = {
  models: CodexModelOption[];
  selectedModel: CodexCaptionModel;
};

// ---- Per-surface AI defaults (provider / model / reasoning) ------------
//
// The user picks, in Settings → AI, the default provider + model +
// reasoning for each of three AI surfaces (Library chat, Sizzle chat,
// Enrichment). These DEFAULTS drive the kit controller / one-shot client;
// per-thread overrides are out of scope.

/** Reasoning effort the per-surface defaults expose in the UI. This is a
 *  deliberate subset of the protocol's `ReasoningEffort`
 *  (`none|minimal|low|medium|high|xhigh`) — PwrSnap only surfaces the
 *  three the user-facing picker offers. The chosen value is sent verbatim
 *  as Codex's `effort`; widen this union (and `AI_REASONING_EFFORTS`) if
 *  we want to expose more tiers. */
export type AiReasoningEffort = "low" | "medium" | "high";

export const AI_REASONING_EFFORTS = [
  "low",
  "medium",
  "high"
] as const satisfies readonly AiReasoningEffort[];

export function isAiReasoningEffort(value: unknown): value is AiReasoningEffort {
  return (
    typeof value === "string" &&
    (AI_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/** Default provider / model / reasoning for ONE AI surface. Every field
 *  is optional; an omitted (or empty-string) field means "use the default".
 *  `provider` is a BACKEND selector for every surface (Library/Sizzle chat AND
 *  enrichment): "" / "codex" → Codex, "acp:<known-id>" → an enabled ACP agent.
 *  (It used to map to the Codex `modelProvider` for enrichment; the Settings →
 *  AI consolidation unified all three surfaces onto the backend selector.)
 *  `model` is whatever the chosen backend exposes (free-form, shape-validated);
 *  `reasoning` maps to the backend's effort. */
export type AiSurfaceDefault = {
  provider?: string;
  model?: string;
  reasoning?: AiReasoningEffort;
};

/** Patch shape for ONE surface's defaults. Distinct from
 *  `Partial<AiSurfaceDefault>` because the wire/patch form lets the
 *  renderer CLEAR a field back to "Codex default": an explicit empty
 *  string on `provider` / `model` / `reasoning` drops the stored field
 *  (substrate hygiene rule `undefined ≠ null ≠ ""`). `reasoning` accepts
 *  the empty string as its clear sentinel since it can't be `null` (the
 *  in-memory type is a closed union); a non-empty `reasoning` must still
 *  be a valid `AiReasoningEffort`, enforced at the bus validator. */
export type AiSurfaceDefaultPatch = {
  provider?: string;
  model?: string;
  reasoning?: AiReasoningEffort | "";
};

/** The three surfaces that carry per-surface defaults. */
export type AiSurfaceDefaults = {
  libraryChat: AiSurfaceDefault;
  sizzleChat: AiSurfaceDefault;
  enrichment: AiSurfaceDefault;
};

/** Identifier for one of the three default-carrying AI surfaces. Used by
 *  the Settings UI to drive the three sub-groups and by the patch shape. */
export type AiSurfaceId = keyof AiSurfaceDefaults;

export const AI_SURFACE_IDS = [
  "libraryChat",
  "sizzleChat",
  "enrichment"
] as const satisfies readonly AiSurfaceId[];

export function isAiSurfaceId(value: unknown): value is AiSurfaceId {
  return (
    typeof value === "string" &&
    (AI_SURFACE_IDS as readonly string[]).includes(value)
  );
}

/** Default `ai.defaults` state. Mirrored by `defaultSettings()` in the
 *  desktop service. Empty objects = "use the Codex default for every
 *  surface" — but note the desktop service's `parseV1` seeds
 *  `enrichment.model` from the legacy `codex.captionModel` for back-compat
 *  so existing enrichment behavior is preserved. */
export const DEFAULT_AI_SURFACE_DEFAULTS: AiSurfaceDefaults = {
  libraryChat: {},
  sizzleChat: {},
  enrichment: {}
};

// ---- ACP agents (discovery + enable in Settings → AI) -------------------
//
// PwrSnap can delegate chat to a locally-installed ACP agent CLI (Kimi /
// Qwen / Gemini / Grok) discovered + spawned by `@pwrdrvr/agent-acp`. This
// first phase (B1) is discovery + enable only: surface which agents are
// installed and let the user opt the ones they want into the enabled set
// (persisted in `Settings.ai.acp.enabledAgentIds`). Wiring an enabled agent
// as a live chat backend is a separate next phase.
//
// The agent-id value space is the kit's `BUILT_IN_ACP_STRATEGIES` ids
// (`gemini` / `grok` / `kimi` / `qwen`). The mirror below is the protocol's
// closed copy used by the bus validator + renderer guards; the kit table is
// the runtime source of truth that the main-process discovery handler reads.
// Keep this list in sync with the kit strategy ids — a mismatch only narrows
// the set the validator accepts, never widens it.

export const BUILT_IN_ACP_AGENT_IDS = [
  "gemini",
  "grok",
  "kimi",
  "qwen"
] as const;

export type BuiltInAcpAgentId = (typeof BUILT_IN_ACP_AGENT_IDS)[number];

export function isBuiltInAcpAgentId(value: unknown): value is BuiltInAcpAgentId {
  return (
    typeof value === "string" &&
    (BUILT_IN_ACP_AGENT_IDS as readonly string[]).includes(value)
  );
}

/** Friendly display names for the built-in ACP agents — kept in sync with the
 *  kit strategies' `displayName`. Lets the UI label a configured agent
 *  IMMEDIATELY (e.g. "Gemini CLI") from settings, instead of flashing the raw
 *  id ("gemini") until async discovery resolves the same name. */
const BUILT_IN_ACP_AGENT_DISPLAY_NAMES: Record<BuiltInAcpAgentId, string> = {
  gemini: "Gemini CLI",
  grok: "Grok",
  kimi: "Kimi Code CLI",
  qwen: "Qwen Code"
};

/** The friendly name for a built-in ACP agent id, or the id itself for an
 *  unknown id (so a future/custom agent still shows something). */
export function builtInAcpAgentDisplayName(id: string): string {
  return isBuiltInAcpAgentId(id) ? BUILT_IN_ACP_AGENT_DISPLAY_NAMES[id] : id;
}

/** The ACP agent id a chat thread is bound to, parsed from its id
 *  (`acp:<agent>:<session>`), or `null` for a Codex thread. The provider is
 *  baked into the thread id at creation, so it's stable even if the surface's
 *  configured provider later changes. */
export function acpAgentIdFromThreadId(threadId: string): string | null {
  const m = /^acp:([^:]+):/.exec(threadId);
  return m ? (m[1] ?? null) : null;
}

/** Human-facing provider label for a chat thread — the bound ACP agent's
 *  friendly name (e.g. "Gemini CLI") or "Codex". */
export function chatThreadProviderLabel(threadId: string): string {
  const agentId = acpAgentIdFromThreadId(threadId);
  return agentId === null ? "Codex" : builtInAcpAgentDisplayName(agentId);
}

/** Where a discovered instance's executable path was located. */
export type AcpAgentInstanceSource = "override" | "path" | "fallback";

/** One installed executable of an ACP agent that passed discovery. A single
 *  agent can have several (e.g. `qwen` under nvm AND Homebrew), each a distinct
 *  binary the user can pick between. */
export type AcpAgentInstance = {
  /** Resolved command/path that passed the probe. */
  command: string;
  /** Parsed CLI version, when the version probe yielded one. */
  version?: string;
  /** How the path was found: user override, a `PATH` match, or a fallback path. */
  source: AcpAgentInstanceSource;
};

/** One known ACP agent's discovery status, as surfaced by the
 *  `acp:discover` verb. `installed` is the only authoritative install
 *  signal (the kit's local discovery passed the strategy's probe).
 *  `instances` lists EVERY installed executable found (PATH matches +
 *  fallbacks + a passing override); `activeCommand` is the one currently in
 *  effect for spawns (override → user-picked → first found). `version` /
 *  `detail` mirror the active instance for compact display. */
export type AcpAgentDiscoveryEntry = {
  /** Kit strategy id (`gemini` / `grok` / `kimi` / `qwen`). */
  id: string;
  /** Human-facing name from the kit strategy (`Gemini CLI`, etc.). */
  displayName: string;
  /** True when the kit's local discovery found + probed the CLI. */
  installed: boolean;
  /** Parsed CLI version of the active instance, when known. */
  version?: string;
  /** Resolved command path of the active instance when installed; an install
   *  hint when not. */
  detail?: string;
  /** Every installed instance found, in candidate order. Empty when not installed. */
  instances: AcpAgentInstance[];
  /** The instance command currently in effect (override → picked → first found).
   *  Undefined when nothing is installed. */
  activeCommand?: string;
};

/** Result of `acp:discover` — every known ACP agent with its install
 *  status. Read-only; never spawns the agent in ACP server mode (the
 *  probe only runs `--version` / `--help`). */
export type AcpAgentDiscovery = {
  /** One entry per known ACP agent (built-in strategy), installed or not. */
  agents: AcpAgentDiscoveryEntry[];
};

/** One model an ACP agent advertises (from its `session/new` runtime
 *  capabilities). `id` is the value persisted as a surface's `model`. */
export type AcpAgentModelOption = {
  id: string;
  label: string;
  description?: string;
  /** True for the model the agent reports as its current/default
   *  (`currentModelId`). At most one per list; absent when the agent
   *  advertises models but no current id. The picker labels it "(default)"
   *  and annotates the "Default" entry with it. */
  isDefault?: boolean;
};

/** Result of `acp:models` — the model list a specific ACP agent advertises,
 *  so the Settings model picker can show the agent's real models (Gemini's
 *  `gemini-2.5-pro`, …) instead of Codex's. Empty `models` = the agent
 *  advertises none (or isn't installed). */
export type AcpAgentModelList = {
  /** The agent id the list is for (echoed back). */
  agentId: string;
  models: AcpAgentModelOption[];
};

/** Per-user ACP-agent enablement. Additive sub-object of `Settings.ai`.
 *  `enabledAgentIds` is the set of built-in ACP agent ids the user has
 *  opted into; defaults to empty. Order is the user's toggle order; the
 *  set is de-duplicated + validated against `BUILT_IN_ACP_AGENT_IDS` at
 *  the bus boundary. */
export type AcpSettings = {
  enabledAgentIds: string[];
  /** Per-agent path preferences, keyed by built-in agent id. A missing entry
   *  means "auto" (use the first discovered instance, no override). */
  agents?: Record<string, AcpAgentPreference>;
};

/** A user's per-agent path choice. `overridePath` is a manual absolute path
 *  (highest priority — probed even if outside `PATH`/fallbacks). `selectedPath`
 *  is a discovered instance the user clicked to pin. Both unset = auto (first
 *  discovered instance). */
export type AcpAgentPreference = {
  /** Manual override path. Empty / undefined = none. */
  overridePath?: string;
  /** User-pinned discovered instance command. Undefined = auto (first found). */
  selectedPath?: string;
};

/** Default `ai.acp` state — no agents enabled, no per-agent preferences. */
export const DEFAULT_ACP_SETTINGS: AcpSettings = {
  enabledAgentIds: [],
  agents: {}
};

export type AiEnrichmentTriggerSource =
  | "auto-enrichment"
  | "popover-enable"
  | "popover-regenerate"
  | "library-regenerate"
  | "library-action"
  | "library-chat"
  | "sizzle-chat"
  | "annotate"
  | "describe"
  | "tag"
  | "filename"
  | "sensitive-scan"
  | "unknown";

export type AiEnrichmentBudgetMode = "available" | "slow" | "safety_disabled";

export type AiEnrichmentBudgetStatus = {
  mode: AiEnrichmentBudgetMode;
  tokensAvailable: number;
  capacity: number;
  refillIntervalMs: number;
  nextTokenAt: string | null;
  limitedAttemptsLastHour: number;
  disableThreshold: number;
  disabledAt: string | null;
};

export type AppDocumentKind = "changelog" | "third-party-licenses";

export type AppDocument = {
  kind: AppDocumentKind;
  title: string;
  content: string;
};

/** What the OS reports about PwrSnap's login-item registration right
 *  now — as opposed to `Settings.general.launchAtLogin`, which is the
 *  user's saved preference. The two diverge when the OS gates the
 *  registration: macOS 13+ lets the user flip a registered login item
 *  off in System Settings → Login Items, Windows lets Task Manager →
 *  Startup apps disable the Run-key entry. Returned by
 *  `app:launchAtLoginStatus`. */
export type LaunchAtLoginStatus = {
  /** False when this build can't register a login item at all. */
  supported: boolean;
  /** Why `supported` is false. `dev-build`: unpackaged runs would
   *  register the bare Electron binary as the login item, so
   *  registration is skipped outside packaged builds. `e2e`: the
   *  Playwright harness must never touch the host machine's real
   *  startup items. `platform-unsupported`: no implementation for this
   *  platform. */
  reason?: "dev-build" | "e2e" | "platform-unsupported";
  /** True when the OS currently has a login item registered for
   *  PwrSnap. */
  registered: boolean;
  /** True when the item is registered but the user disabled it on the
   *  OS side (macOS `requires-approval`, Windows startup-approved off).
   *  PwrSnap will NOT start at login while this is set; recovery is
   *  `app:openLoginItemsSettings`. */
  blockedByOs: boolean;
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
    /** Codex model ID used for the capture-enrichment turn (captions,
     *  tag suggestions, OCR — all one Codex call). MUST be a member of
     *  `CODEX_CAPTION_MODELS`. Mini-tier is the only allowed option
     *  today because captioning is high-volume + cost-sensitive; widen
     *  the list when we want users to opt into a larger model. */
    captionModel: CodexCaptionModel;
  };
  ai: {
    /** Phase 4 AI-pipeline kill switch. */
    enabled: boolean;
    /** ISO-8601; null until the user accepts the AI consent modal. */
    consentAcceptedAt: string | null;
    /** ISO-8601; null unless the budget circuit breaker disabled AI. */
    budgetSafetyDisabledAt: string | null;
    /** When true, completed Codex enrichments are promoted from
     *  `suggested_*` to `accepted_*` automatically — the user doesn't
     *  have to click "Use draft" in the float-over toast. Off by
     *  default; the float-over surfaces an inline checkbox so users
     *  can flip the policy without leaving the capture flow. */
    autoAcceptSuggestions: boolean;
    /** Per-user Library-chat preferences (User Guidance text,
     *  sensitive-data patterns, default redaction style, first-launch
     *  banner state). Sits inside `ai` so the existing AI-consent +
     *  kill-switch fields stay close to the chat knobs the user
     *  interacts with on the same Settings page. Added per
     *  docs/plans/2026-05-28-001-feat-library-chat-editor-interface-plan.md
     *  Phase 0 + deepening §F7 #3. */
    chat: ChatSettings;
    /** Per-surface default provider / model / reasoning the user picks
     *  in Settings → AI. These flow into the kit `ChatThreadController`
     *  (Library chat, Sizzle chat) and pooled Codex enrichment
     *  (Enrichment) — see AiSurfaceDefaults for the field semantics.
     *  Additive: every leaf is optional, an omitted field means "use the
     *  Codex default" (no `model` / `modelProvider` / `effort` is sent on
     *  thread/start or turn/start). */
    defaults: AiSurfaceDefaults;
    /** ACP-agent enablement (Settings → AI → ACP agents). The set of
     *  locally-installed ACP agents the user has opted into. Additive;
     *  defaults to empty. Discovery is the `acp:discover` verb; enabling
     *  is a `settings:write` patch to `ai.acp.enabledAgentIds`. Wiring an
     *  enabled agent as a live chat backend is a separate next phase. */
    acp: AcpSettings;
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
    /** Capture the display under the cursor end-to-end (no selector).
     *  Backed by `capture:fullScreen`; unbound by default — also
     *  reachable from the tray. */
    fullScreen: string;
    /** Capture every connected display, stitched into a single image.
     *  Backed by `capture:allScreens` (mode `"stitched"`); unbound by
     *  default — also reachable from the tray. */
    allScreens: string;
    /** 5-second countdown, then the auto-mode selector. Backed by
     *  `capture:interactive` (mode `"timed"`); unbound by default —
     *  also reachable from the tray. */
    timed: string;
    /** Video-capture hotkey. Default `⌘⌥C` (Command+Alt/Option+C),
     *  deliberately NOT `⌘⇧V` — that chord is "Paste and Match
     *  Style" in browsers / Slack / Mail / iWork / Notes / etc.
     *  and globalShortcut.register wins system-wide, so binding
     *  ⌘⇧V would steal paste-without-formatting from every app
     *  on the box while PwrSnap is running. */
    videoCapture: string;
    /** Re-pop the most recent capture's float-over toast over the
     *  screen. Default `⌘⌥⇧F` (mnemonic: Float-over). The three-modifier
     *  chord keeps it clear of app/OS shortcuts — a 2-modifier default
     *  like ⌘⇧F would shadow "Find in Files" system-wide while PwrSnap
     *  runs. Rebindable/unbindable from Settings → Hotkeys. */
    reshowFloatOver: string;
  };
  general: {
    /** When true, the View menu exposes Reload / Force Reload / Toggle
     *  Developer Tools. Hidden by default so end-users see the same
     *  trim native menu as any signed Mac app; power users + bug
     *  reporters flip it on in Settings. Mirrors PwrAgnt's
     *  `general.developerMode`. */
    developerMode: boolean;
    /** Developer diagnostics: when true, the Library renderer is monitored
     *  for hot CPU samples and writes bounded `.cpuprofile` artifacts
     *  for troubleshooting. The monitor can also be armed via
     *  `PWRSNAP_HOT_CPU_PROFILING=1` for field builds where Settings
     *  is not reachable. */
    hotCpuProfilingEnabled: boolean;
    /** Delay before hot CPU monitoring starts after the user arms it,
     *  giving them time to set up the scenario they want to capture. */
    hotCpuProfilingStartDelayMs: HotCpuProfileStartDelayMs;
    /** Trigger shape for starting the CPU profile. */
    hotCpuProfilingTriggerMode: HotCpuProfileTriggerMode;
    /** Lower threshold used when trigger mode is `slowburn`. */
    hotCpuProfilingSlowburnThresholdPercent: number;
    /** Capture bounded renderer heap snapshots around the next hot CPU
     *  profile, then auto-disable after the limit is reached. */
    hotCpuProfilingCaptureHeapSnapshot: boolean;
    /** Bound heap snapshots to avoid repeatedly stalling the app or
     *  filling disk while debugging a hot renderer. */
    hotCpuProfilingHeapSnapshotLimit: number;
    /** When true, PwrSnap registers itself as an OS login item so the
     *  tray + capture hotkeys are ready right after sign-in. Login
     *  launches boot tray-only (no Library window). This is the saved
     *  PREFERENCE — the OS-side registration syncs to it in main
     *  (launch-at-login.ts) and the live OS state is reported
     *  separately via `app:launchAtLoginStatus` (macOS 13+ login items
     *  can be disabled by the user in System Settings without PwrSnap
     *  observing the change). */
    launchAtLogin: boolean;
  };
  /** Feature gates that ship default-on (or -off) while their legacy
   *  fallback still exists. Each flag documents its own exit plan —
   *  once a gate has soaked, the flag and the fallback path are
   *  deleted together. */
  experimental: {
    /** macOS two-process split (docs/plans/2026-06-12-001): the tray /
     *  capture agent and the Library run as separate processes, so the
     *  capture overlays can never flash the Dock or disturb the
     *  Library window. Default OFF — opt-in while it soaks; turning it
     *  on switches from the single-process (`combined`) boot. Read once
     *  at process start — changing it requires relaunching PwrSnap.
     *  Meaningless (ignored) off macOS, where the boot is always
     *  single-process. */
    processSplit: boolean;
    /** When true, the Low / Med / High image-export presets scale to
     *  25% / 50% / 100% of the capture's resolution (DPI-aware) instead
     *  of the legacy fixed-width clamp (800 / 1440 / source). Resolves to
     *  the `scalePhysical` / `scaleLogical` export strategies in
     *  `@pwrsnap/shared`'s `resolveExportStrategy`. Default false. See
     *  docs/plans/2026-06-14-001-feat-dpi-aware-export-presets-plan.md. */
    dpiAwareExport: boolean;
    /** Only meaningful when `dpiAwareExport` is true. When true (default)
     *  the 100% rung is the full native capture (Retina on a 2× display);
     *  when false the ladder re-anchors to the on-screen / logical
     *  resolution so the top rung is 1× with two smaller rungs below. */
    allowRetinaExport: boolean;
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
  /** Library storage and filename preferences. */
  storage: {
    /** Local is the single-user default so Finder filenames match the
     *  date/time the user remembers. UTC is opt-in for shared-drive /
     *  cross-timezone workflows where absolute ordering matters more. */
    filenameTimestampZone: FilenameTimestampZone;
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
    /** Whether PwrSnap has ever triggered the macOS Screen Recording
     *  TCC prompt on this install (by attempting a real screen grab).
     *  macOS reports `denied` for BOTH "never asked" and "explicitly
     *  denied" — `getMediaAccessStatus('screen')` is backed by the
     *  boolean `CGPreflightScreenCaptureAccess()` and NEVER returns
     *  `not-determined` for screen. This flag is the only way to tell
     *  the two apart, so the UI can offer "Request access" (which fires
     *  the OS prompt and registers PwrSnap in the Privacy pane) on a
     *  fresh install instead of a dead-end "Open System Settings" for an
     *  app that isn't in the list yet. Set the first time we trigger the
     *  prompt — from the System Permissions page button OR the first
     *  capture attempt (see the main-side screen-permission gate). */
    screenCapturePrompted: boolean;
  };
  /** v2 editor user preferences — tool style defaults (sticky-mode
   *  memory), one-time coachmark flags, matching-text affordance gate,
   *  right-sidebar pin/last-panel state. Lives behind the same Settings
   *  substrate as every other field; renderers patch via SettingsPatch
   *  and re-fetch on `events:settings:changed` (see AGENTS.md "Settings
   *  substrate"). Added per docs/plans/2026-05-23-001-feat-v2-editor-
   *  plan.md Phase 1. */
  editor: EditorSettings;
  /** Library DetailRail right-side activity bar state. Mirrors
   *  `editor.sidebar` but scoped to the Library — the two surfaces
   *  use the same RightActivityBar primitive and persist
   *  independently so users can prefer "always-open" in Library while
   *  the Editor stays unpinned, or vice versa. */
  library: LibrarySettings;
};

/** Out-of-the-box global capture hotkeys. Shared so the main-process
 *  `defaultSettings()` and the renderer's Settings → Hotkeys "Reset to
 *  defaults" both read ONE source — they previously duplicated these
 *  values and had to be kept in lock-step by hand. Empty string =
 *  unbound (main skips registration). Per-field rationale (why ⌘⇧C not
 *  ⌘⇧P; why ⌘⌥C not ⌘⇧V; why three modifiers for re-show) lives on the
 *  `Settings["hotkeys"]` type above; the short version:
 *    - quickCapture ⌘⇧C — ⌘⇧P collides with Print in browsers/iWork.
 *    - region/window/fullScreen/allScreens/timed unbound — also tray-
 *      reachable; we don't claim five more global chords by default.
 *    - videoCapture ⌘⌥C — ⌘⇧V is Paste-and-Match-Style system-wide.
 *    - reshowFloatOver ⌘⌥⇧F — three modifiers clear of app/OS chords. */
export const DEFAULT_HOTKEYS: Settings["hotkeys"] = {
  quickCapture: "CommandOrControl+Shift+C",
  region: "",
  window: "",
  fullScreen: "",
  allScreens: "",
  timed: "",
  videoCapture: "CommandOrControl+Alt+C",
  reshowFloatOver: "CommandOrControl+Alt+Shift+F"
};

// ---- Editor user preferences (Phase 1) ----------------------------------

/** Eight named annotation swatches the tool color picker exposes. Each
 *  resolves to a `--swatch-*` CSS custom property in tokens.css; the
 *  "accent" entry derives from the theme-aware `--accent` so the brand
 *  swatch deepens to the WCAG-AA tangerine on light theme. The popover
 *  also accepts arbitrary hex strings via the "Custom…" affordance,
 *  hence the `string` widening in `ToolColor`. */
export type ColorToken =
  | "red"
  | "yellow"
  | "green"
  | "blue"
  | "gray"
  | "black"
  | "white"
  | "accent";

export const COLOR_TOKENS = [
  "red",
  "yellow",
  "green",
  "blue",
  "gray",
  "black",
  "white",
  "accent"
] as const satisfies readonly ColorToken[];

export function isColorToken(value: unknown): value is ColorToken {
  return typeof value === "string" && (COLOR_TOKENS as readonly string[]).includes(value);
}

/** Either a named swatch OR a free-form CSS color string (hex / rgb /
 *  hsl). The renderer maps `ColorToken` to `var(--swatch-<name>)` at
 *  paint time; arbitrary strings pass through unchanged so the OS
 *  color-picker can write any value the user lands on. */
export type ToolColor = ColorToken | string;

/** "auto" picks a sensible default per tool kind (scaled with capture
 *  resolution); the preset buckets give the user quick taps for
 *  thicker / thinner. "x-large" is supported for arrow / rect
 *  thickness on high-DPI captures where the auto-clamped stroke gets
 *  visually thin against the image area; the text tool ignores it
 *  (maps to large) because the three text-size buckets are already
 *  well-spaced. Numeric values are the explicit-px escape hatch
 *  reserved for future power-user controls. */
export type ToolSizePreset = "auto" | "small" | "medium" | "large" | "x-large";

// Arrow end + stem style names are defined as zod enums in overlay-
// schemas.ts (the runtime source of truth for what gets persisted on
// disk in an overlay row). Re-export the types here so consumers of
// Settings.editor see them as part of the protocol surface without
// having to know about the schema barrel. The Settings preference and
// the on-disk overlay field share the same value space by design —
// picking "open-triangle" in the popover writes "open-triangle" into
// the overlay row.
export type { ArrowEndStyle, ArrowStemStyle, ShapeKind } from "./overlay-schemas";
import type {
  ArrowEndStyle,
  ArrowStemStyle,
  ShapeKind
} from "./overlay-schemas";
export type TextFontWeight = "regular" | "bold";
export type BlurEffectMode = "gaussian" | "pixelate" | "redact";

/** Discriminated so "auto" never coexists with a numeric value (zod
 *  rejects the mixed shape; downstream renderers match on `mode` for
 *  exhaustive switching). */
export type BlurRadiusSetting = { mode: "auto" } | { mode: "px"; value: number };

export type HighlightBlendMode = "multiply" | "screen" | "overlay";

export type ArrowToolStyle = {
  color: ToolColor;
  thickness: ToolSizePreset | number;
  endStyle: ArrowEndStyle;
  stemStyle: ArrowStemStyle;
  doubleEnded: boolean;
};

export type TextToolStyle = {
  color: ToolColor;
  fontSize: ToolSizePreset | number;
  weight: TextFontWeight;
};

export type ShapeToolStyle = {
  color: ToolColor;
  thickness: ToolSizePreset | number;
  filled: boolean;
  /** Which geometric primitive the Shape tool commits on its next
   *  drag. Square + circle enforce a 1:1 lock during drag (see
   *  Editor.tsx onPointerMove); rect / oval / parallelogram drag
   *  freely. */
  shape: ShapeKind;
  /** Horizontal skew in degrees applied when `shape === "parallelogram"`.
   *  Ignored for every other shape kind, but persisted so that picking
   *  Parallelogram later restores the user's last-used skew. */
  skewDeg: number;
};

export type BlurToolStyle = {
  mode: BlurEffectMode;
  radius: BlurRadiusSetting;
};

export type HighlightToolStyle = {
  color: ToolColor;
  /** 0..1; renderer clamps. The popover exposes preset stops 0.2/0.3/0.6. */
  opacity: number;
  blend: HighlightBlendMode;
};

/** Per-tool style memory. The "active" tool's style is window-scoped
 *  React state for the editor session; these are the DEFAULTS that get
 *  read at editor-open and written at editor-close (or on a 500ms
 *  debounce, whichever fires first). Cross-window broadcasts do NOT
 *  trigger live re-application — opening a second editor inherits the
 *  current default, but ongoing work in another window keeps its
 *  in-session styles. See plan §"Tool state is window-scoped (active)
 *  + Settings-backed (defaults)". */
export type EditorToolStyles = {
  arrow: ArrowToolStyle;
  text: TextToolStyle;
  shape: ShapeToolStyle;
  blur: BlurToolStyle;
  highlight: HighlightToolStyle;
};

/** One-time UI hint flags. `stoplightSeen` flips true the first time
 *  the user opens any tool style popover and the 3s stoplight palette
 *  micro-coachmark dismisses; never shown again in any popover. Mirror
 *  pattern: any future "did the user see X once?" lives here. */
export type EditorCoachmarks = {
  stoplightSeen: boolean;
};

/** Matching-text affordance gate. Default ON; the user can disable it
 *  from Settings → Editor (Phase 1.5 surface, not blocking) if the
 *  "+ Add label" affordance after arrow placement feels intrusive for
 *  their workflow. */
export type EditorMatchingText = {
  enabled: boolean;
};

export type EditorSidebarPanel = "info" | "chat" | "toolConfig" | "help";

export const EDITOR_SIDEBAR_PANELS = [
  "info",
  "chat",
  "toolConfig",
  "help"
] as const satisfies readonly EditorSidebarPanel[];

export function isEditorSidebarPanel(value: unknown): value is EditorSidebarPanel {
  return (
    typeof value === "string" &&
    (EDITOR_SIDEBAR_PANELS as readonly string[]).includes(value)
  );
}

/** Right-edge activity bar persistence. `pinned` keeps the chosen
 *  panel open across editor sessions; `lastSelectedPanel` is what
 *  re-opens when the user re-pins. Hover-pop behavior is rendered
 *  the same regardless. */
export type EditorSidebarSettings = {
  pinned: boolean;
  lastSelectedPanel: EditorSidebarPanel;
};

export type EditorSettings = {
  toolStyles: EditorToolStyles;
  coachmarks: EditorCoachmarks;
  matchingText: EditorMatchingText;
  sidebar: EditorSidebarSettings;
};

// ---- Library DetailRail settings ---------------------------------------

/** Tab identifier for the Library DetailRail right-side activity bar.
 *  Mirrors `EditorSidebarPanel` for symmetry but scoped to the
 *  Library — the available surfaces (Info / OCR / Chat / Project /
 *  Layers) are different from the editor's (Info / Chat / Tool Config
 *  / Help). `project` is gated at render time to only appear when at
 *  least one sizzle project exists and the active capture is one of
 *  its scenes; `layers` is gated to image captures that have an
 *  editor mounted (Reel/Focus); both are absent otherwise. */
export type LibrarySidebarTab =
  | "info"
  | "ocr"
  | "chat"
  | "project"
  | "cart"
  | "layers";

export const LIBRARY_SIDEBAR_TABS = [
  "info",
  "ocr",
  "chat",
  "project",
  "cart",
  "layers"
] as const satisfies readonly LibrarySidebarTab[];

export function isLibrarySidebarTab(value: unknown): value is LibrarySidebarTab {
  return (
    typeof value === "string" &&
    (LIBRARY_SIDEBAR_TABS as readonly string[]).includes(value)
  );
}

/** Persisted state for the Library DetailRail's right-bar. */
export type LibrarySidebarSettings = {
  pinned: boolean;
  lastSelectedTab: LibrarySidebarTab;
};

export type LibrarySettings = {
  detailRail: LibrarySidebarSettings;
  /** When true (default), moving a capture to Trash pops a small confirm
   *  popover next to the delete button. Users can untick "Don't ask again"
   *  in that popover to set this false — deletes then go straight to Trash
   *  (still recoverable via the Undo toast / ⌘Z and the Trash view). Re-
   *  enable from Settings → Storage & retention. */
  confirmBeforeTrash: boolean;
  /** Sticky Library-grid thumbnail size: the *target thumbnail width in
   *  px*. The grid picks the column count whose resulting cell width is
   *  CLOSEST to this target (round-to-nearest), so cell sizes stay centered
   *  on the target as the window resizes instead of ballooning before a
   *  column is added. A larger value = bigger thumbnails / fewer columns.
   *  Pinch-to-zoom on the grid steps this through {@link GRID_ZOOM_LEVELS}.
   *  Stored as a raw px number rather than a level index so the value
   *  survives changes to the level ladder (readers snap to the nearest
   *  level). Clamped to [{@link GRID_ZOOM_MIN}, {@link GRID_ZOOM_MAX}]. */
  gridZoom: number;
};

/** Discrete Library-grid zoom levels — target thumbnail min-widths in px,
 *  ascending (smallest thumbnails / most columns → largest / fewest).
 *  Pinch-to-zoom snaps between adjacent entries. The contract (this list,
 *  the default, and the bounds) lives in shared so the main-process
 *  settings service/validator and the renderer agree on one source of
 *  truth. The snap/step *behavior* lives in the renderer
 *  (apps/desktop/src/renderer/src/lib/gridZoom.ts). */
export const GRID_ZOOM_LEVELS = [120, 150, 180, 220, 280, 360] as const;
/** Default grid thumbnail min-width — matches the historical CSS
 *  `minmax(180px, 1fr)`. Must be one of {@link GRID_ZOOM_LEVELS}. */
export const GRID_ZOOM_DEFAULT = 180;
export const GRID_ZOOM_MIN = GRID_ZOOM_LEVELS[0];
export const GRID_ZOOM_MAX = GRID_ZOOM_LEVELS[GRID_ZOOM_LEVELS.length - 1];

// ---- Chat substrate types (Library Chat — Phase 0) ---------------------
//
// The RUNTIME SOURCE OF TRUTH for these is `chat-schemas.ts` (zod), and
// the `@pwrsnap/shared` barrel re-exports that module wholesale. We only
// IMPORT the few types referenced by the Commands map below — re-
// exporting them from here too would collide with the barrel's
// `export * from "./chat-schemas"`. Mirrors how `ArrowEndStyle` is owned
// by overlay-schemas.ts. See plan §F2 #9.
import type {
  ChatApprovalDecision,
  ChatMessage,
  LibraryChatThreadView
} from "./chat-schemas";

// ---- Chat redaction defaults + user-provided patterns ------------------
//
// Two preferences the chat agent reads on every turn:
//
//   • `defaultRedactionStyle` — when the agent applies an opaque
//     redaction (over a credit-card field, an API key, etc.), should
//     it use a blackout rectangle (irreversible) or a blur (reversible
//     via deconvolution — see Phase 0 deepening §F12 + aCropalypse
//     CVE-2023-21036). Default `"blackout"` because the most-common
//     user ask is "hide my secrets" and blackout is the safe answer.
//
//   • `sensitiveDataPatterns` — named regexes the user has taught the
//     agent. Each is `{name, pattern}`. Names like "SSN", "InternalTicketId".
//     The pattern is a regex string ("\\d{3}-\\d{2}-\\d{4}"). NEVER a
//     real secret — only the SHAPE. The Settings UI warns about this
//     and runs a secret-shape sniff on save (Phase 0 deepening §F4 H3).

/** Redaction strategy. `"blackout"` paints an opaque rectangle — not
 *  reversible. `"blur"` paints a gaussian blur — reversible by
 *  deconvolution (see aCropalypse), so DO NOT use for secrets the
 *  user wants permanently hidden. */
export type RedactionStyle = "blackout" | "blur";

export const REDACTION_STYLES = ["blackout", "blur"] as const satisfies readonly RedactionStyle[];

export function isRedactionStyle(value: unknown): value is RedactionStyle {
  return typeof value === "string" && (REDACTION_STYLES as readonly string[]).includes(value);
}

/** One row in `Settings.ai.chat.sensitiveDataPatterns`. The `name` is
 *  the user-facing handle AND the unique identifier the chat agent
 *  references (e.g., `redact_text_pattern { pattern_name: "SSN" }`).
 *  The `pattern` is the regex string — compiled at use site, not at
 *  store time (cheap + safe; recompile on every match). */
export type SensitiveDataPattern = {
  name: string;
  pattern: string;
};

/** Per-user chat preferences. Sits under `Settings.ai.chat` to leave
 *  room for future chat-only knobs (confirm-batch threshold, tone,
 *  per-turn op cap) without flattening more fields onto `ai.*`. Phase
 *  0 deepening §F7 #3. */
export type ChatSettings = {
  /** Free-form per-user system-prompt addition. Empty string = no
   *  guidance set. Cap 8KB enforced at the bus validator. Injected
   *  verbatim into the chat system prompt's L2 layer on every turn.
   *  Never leaves the device until the user sends a chat turn (then
   *  it travels to Codex as part of the system prompt). */
  userGuidance: string;
  /** Named regex patterns. Cap 32 enforced at the validator; each
   *  `name` ≤ 64 chars, each `pattern` ≤ 512 chars. Uniqueness on
   *  `name` enforced. Pattern must compile as a JS RegExp at save
   *  time (RE2 migration tracked separately — see plan §F4 H1). */
  sensitiveDataPatterns: SensitiveDataPattern[];
  /** Default redaction style when the agent has to pick. Per-pattern
   *  override is intentionally NOT a knob (Phase 0 deepening §F8 cut
   *  the per-row `redactionStyle` field as YAGNI; one global default
   *  + agent picks per call is sufficient). */
  defaultRedactionStyle: RedactionStyle;
  /** True once the user has dismissed the Settings → AI → Chat
   *  first-launch disclosure banner (which warns about iCloud +
   *  Time Machine + plaintext exposure at ~/Documents/PwrSnap/Chats/).
   *  Persisted so the banner doesn't re-appear after a relaunch. */
  firstLaunchBannerDismissed: boolean;
};

/** Default `ai.chat` state. Mirrored by `defaultSettings()` in the
 *  desktop service; re-exported here so the inline pre-React bootstrap
 *  and the renderer hook share one source of truth. */
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  userGuidance: "",
  sensitiveDataPatterns: [],
  defaultRedactionStyle: "blackout",
  firstLaunchBannerDismissed: false
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

/** Timestamp zone used in generated `.pwrsnap` filenames. */
export type FilenameTimestampZone = "local" | "utc";

/** Deep-partial patch shape. `undefined` = leave untouched. Each nested
 *  object is independently optional so a renderer can write a single
 *  field without echoing the rest. */
export type SettingsPatch = {
  codex?: Partial<Settings["codex"]>;
  experimental?: Partial<Settings["experimental"]>;
  /** `ai` is deeper than the other top-level branches because Library
   *  chat preferences live under `ai.chat`. Each leaf within `chat` is
   *  independently optional so a single textarea blur can ship just
   *  `{ ai: { chat: { userGuidance: "..." } } }` without re-echoing
   *  patterns, redaction style, or the banner-dismiss flag. Empty
   *  string is the explicit "cleared" sentinel per the substrate
   *  hygiene rule `undefined ≠ null ≠ ""`. */
  ai?: {
    enabled?: Settings["ai"]["enabled"];
    consentAcceptedAt?: Settings["ai"]["consentAcceptedAt"];
    budgetSafetyDisabledAt?: Settings["ai"]["budgetSafetyDisabledAt"];
    autoAcceptSuggestions?: Settings["ai"]["autoAcceptSuggestions"];
    chat?: Partial<ChatSettings>;
    /** Per-surface defaults. Each surface is independently optional, and
     *  within a surface each leaf (`provider` / `model` / `reasoning`) is
     *  optional too — so the UI can ship just `{ ai: { defaults: {
     *  libraryChat: { model: "gpt-…" } } } }` without re-echoing the rest.
     *  Empty string is the explicit "cleared → use Codex default"
     *  sentinel per the substrate hygiene rule `undefined ≠ null ≠ ""`. */
    defaults?: {
      libraryChat?: AiSurfaceDefaultPatch;
      sizzleChat?: AiSurfaceDefaultPatch;
      enrichment?: AiSurfaceDefaultPatch;
    };
    /** ACP-agent enablement patch. `enabledAgentIds` REPLACES the stored
     *  set wholesale (the renderer ships the full desired set on each
     *  toggle, mirroring `ai.chat.sensitiveDataPatterns`). An empty array
     *  is a meaningful value (clear all), not a "leave alone" sentinel —
     *  `undefined` / missing `acp` leaves the stored set untouched. The
     *  bus validator rejects unknown agent ids. */
    acp?: Partial<AcpSettings>;
  };
  hotkeys?: Partial<Settings["hotkeys"]>;
  general?: Partial<Settings["general"]>;
  appearance?: Partial<Settings["appearance"]>;
  updates?: Partial<Settings["updates"]>;
  storage?: Partial<Settings["storage"]>;
  recording?: Partial<Settings["recording"]>;
  /** Editor preferences are deep-nested (toolStyles per tool kind),
   *  so the patch type drops one level deeper than the other branches.
   *  Each leaf style is `Partial<>` so a swatch click can ship just the
   *  changed field rather than re-echoing the full style block. */
  editor?: {
    toolStyles?: {
      arrow?: Partial<ArrowToolStyle>;
      text?: Partial<TextToolStyle>;
      shape?: Partial<ShapeToolStyle>;
      blur?: Partial<BlurToolStyle>;
      highlight?: Partial<HighlightToolStyle>;
    };
    coachmarks?: Partial<EditorCoachmarks>;
    matchingText?: Partial<EditorMatchingText>;
    sidebar?: Partial<EditorSidebarSettings>;
  };
  /** Library DetailRail preferences — currently just the right-bar
   *  pin + last-tab state. Mirrors the `editor.sidebar` patch shape
   *  one level deeper since the Library carries more rail-shaped
   *  surfaces over time. */
  library?: {
    detailRail?: Partial<LibrarySidebarSettings>;
    confirmBeforeTrash?: boolean;
    /** Sticky grid thumbnail size (target min-width px). See
     *  {@link LibrarySettings.gridZoom}. */
    gridZoom?: number;
  };
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
  | {
      status: "install-failed";
      version: string;
      currentVersion: string;
      attemptedAt: string;
      channel: UpdateChannel;
    }
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
  captureId: string | null;
  kind: "enrich" | "chat";
  task: string;
  triggerSource: AiEnrichmentTriggerSource;
  selectedModel: string | null;
  status: AiRunStatus;
  error: string | null;
  latencyMs: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type AiUsageStatus = "available" | "unavailable";
export type AiUsagePriceStatus = "available" | "unavailable";

export type AiUsageTokenBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  modelContextWindow: number | null;
};

export type AiUsageRateSnapshot = {
  model: string;
  serviceTier: string | null;
  contextClass: string | null;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

export type AiUsageCostEstimate =
  | {
      status: "available";
      currency: "USD";
      catalogVersion: string;
      pricingSourceUrl: string;
      pricedAt: string;
      rateSnapshot: AiUsageRateSnapshot;
      uncachedInputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      uncachedInputCostMicros: number;
      cachedInputCostMicros: number;
      outputCostMicros: number;
      totalCostMicros: number;
    }
  | {
      status: "unavailable";
      reason: string;
    };

export type AiRunMediaTransform =
  | "prepared-jpeg"
  | "bare-image"
  | "video-frame"
  | "rendered-composite"
  | "unknown";

export type AiRunMediaInput = {
  id: string;
  aiRunId: string;
  ordinal: number;
  role: string;
  transform: AiRunMediaTransform;
  sourceMimeType: string | null;
  sentMimeType: string;
  format: string;
  encoder: string | null;
  quality: number | null;
  sourceWidthPx: number | null;
  sourceHeightPx: number | null;
  sentWidthPx: number;
  sentHeightPx: number;
  sentByteSize: number;
  maxEdgePx: number | null;
  maxBytes: number | null;
  scaleRatio: number | null;
  videoPositionPct: number | null;
  videoTimestampSec: number | null;
  createdAt: string;
};

export type AiRunUsageDetail = {
  run: AiRunSnapshot;
  threadId: string | null;
  turnId: string | null;
  model: string | null;
  /** Friendly display label for `model` (e.g. "Grok Build" for `grok-build`),
   *  resolved from the ACP model caches at read time. Null when unknown (a Codex
   *  model, or an agent never probed) — the UI falls back to the raw `model`. */
  modelLabel?: string | null;
  /** Friendly label for the run's REQUESTED model (`run.selectedModel`), resolved
   *  from the caches; falls back to the raw id, null when none was requested.
   *  The UI shows it while a run is in flight (effective `model` not yet known),
   *  and uses it for the "you picked X — agent ran Y" override note when the
   *  agent overrode the pick (e.g. Grok rejecting `set_model` for Composer 2.5). */
  selectedModelLabel?: string | null;
  modelProvider: string | null;
  serviceTier: string | null;
  usageStatus: AiUsageStatus;
  usageUnavailableReason: string | null;
  tokens: AiUsageTokenBreakdown | null;
  cost: AiUsageCostEstimate;
  mediaInputs: AiRunMediaInput[];
};

export type AiUsageSummaryWindow = "24h" | "7d" | "30d";
export type AiUsageThreadSurface = "library-chat" | "sizzle-chat";

export type AiUsageSummaryBucket = {
  task: string;
  triggerSource: AiEnrichmentTriggerSource;
  model: string | null;
  runCount: number;
  usageUnavailableCount: number;
  priceUnavailableCount: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  estimatedTotalCostMicros: number;
};

export type AiUsageSummary = {
  window: AiUsageSummaryWindow;
  since: string;
  generatedAt: string;
  runCount: number;
  usageUnavailableCount: number;
  priceUnavailableCount: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  estimatedTotalCostMicros: number;
  currency: "USD";
  buckets: AiUsageSummaryBucket[];
};

export type AiUsageRunListItem = {
  run: AiRunSnapshot;
  subjectKind: "run" | "thread";
  threadId: string | null;
  threadName: string | null;
  threadSurface: AiUsageThreadSurface | null;
  turnCount: number | null;
  model: string | null;
  modelProvider: string | null;
  serviceTier: string | null;
  usageStatus: AiUsageStatus;
  usageUnavailableReason: string | null;
  priceStatus: AiUsagePriceStatus;
  priceUnavailableReason: string | null;
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  estimatedTotalCostMicros: number | null;
  currency: "USD" | null;
};

export type AiUsageRunsPage = {
  items: AiUsageRunListItem[];
  nextOffset: number | null;
};

export type CaptureEnrichmentSummary = {
  captureId: string;
  status: AiRunStatus | null;
  error: string | null;
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
   * Fast Video Capture entry point for UI surfaces (the tray's Record
   * button, the Library's Video chip). Opens the auto-mode selector to
   * pick a region / window, then routes the commit to `recording:start`
   * — the exact flow the `videoCapture` global hotkey drives via
   * `runInteractiveRecord()`. Fire-and-forget: the selector, countdown,
   * and recording lifecycle all surface on the `events:recording:*`
   * broadcasts, so the renderer gets nothing back beyond the ack. The
   * companion to `capture:interactive` (which persists an image), kept
   * as its own verb so the snap and video paths stay explicit.
   */
  "capture:videoInteractive": { req: Record<string, never>; res: void };
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
  /**
   * Capture a single display end-to-end (no selector). Omit `displayId`
   * (or pass `undefined`) to capture the display the cursor is currently
   * on — the tray uses this so the renderer never has to enumerate
   * displays first. PwrSnap chrome (tray popover, float-over toast) is
   * hidden for one compositor frame so it doesn't bleed into the
   * captured pixels.
   */
  "capture:fullScreen": { req: { displayId?: number | undefined }; res: CaptureRecord };
  /**
   * Capture every connected display. `mode: "split"` produces one
   * capture record per display (N rows in the library). `mode:
   * "stitched"` composites every display's PNG onto the virtual-desktop
   * union rect and persists as a single capture. PwrSnap chrome is
   * hidden for one compositor frame, same as `capture:fullScreen`.
   */
  "capture:allScreens": {
    req: { mode: "split" | "stitched" };
    res: { records: CaptureRecord[] };
  };
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
  /**
   * Bulk lookup. Returns rows in the **input order**, with deleted
   * rows omitted (NOT included as nulls). Missing ids are silently
   * dropped. The library Sizzle Reels project-mode view uses this
   * to render a project's scenes in scene order without N round-trips
   * through `library:byId`. Capped at 500 ids per call.
   */
  "library:listByIds": {
    req: { ids: string[] };
    res: { rows: CaptureRecord[] };
  };
  /**
   * Bulk lookup PLUS per-row enrichment. Returns `{ record, enrichment }`
   * pairs in INPUT order; deleted + missing rows are dropped silently
   * (matches `library:listByIds`). Same 500-id cap.
   *
   * Why this exists: the Project Asset Cart's right-rail display needs
   * the script-line preview (from accepted/suggested description) for
   * every cart item, and the agent's chat tools need title /
   * description / OCR to reason about captures. Doing this through
   * `library:listByIds` + N `codex:enrichment` round-trips is 2N
   * dispatches; this is 2 (one captures query, one enrichment query
   * — see `listEnrichmentsByCaptureIds` in enrichment-repo).
   *
   * `enrichment` is `null` for captures that have never been through
   * an AI run AND have no user tags. (Same null semantics as
   * `codex:enrichment`.)
   */
  "library:listByIdsWithMetadata": {
    req: { ids: string[] };
    res: {
      rows: Array<{
        record: CaptureRecord;
        enrichment: CaptureEnrichment | null;
      }>;
    };
  };
  /**
   * Full-text + filter search across the live capture set.
   *
   * Every filter field is optional; they combine conjunctively. The
   * `query` arg searches an FTS5 virtual table (`capture_search_fts`,
   * migration 0017) that mirrors `capture_enrichments` and `captures`
   * — title, description, OCR text, source app name. The returned
   * `matchSnippet` is the SQLite `snippet()` function output around
   * the FTS hit; it's only non-null when `query` is set.
   *
   * Soft-deleted captures are always excluded.
   *
   * Used by the Sizzle Composer Chat agent's `library_search` tool
   * to let the user write big-prompt video briefs ("show me Telegram
   * onboarding screens, then the pairing code, then…") and have the
   * agent pick relevant captures across the user's whole library.
   *
   * Result is capped at `limit` (default 100, max 500). No cursor —
   * if the agent needs more than 500 hits its query is too broad.
   */
  "library:search": {
    req: CaptureSearchRequest;
    res: { rows: CaptureSearchResultRow[] };
  };
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
  /** Snapshot of macOS permission denials on captures-folder reads.
   *  Renderers read this once on mount, then subscribe to
   *  `events:storage:captures-access` for changes. */
  "storage:capturesAccessHealth": { req: Record<string, never>; res: CapturesAccessHealth };
  /** Open System Settings → Privacy & Security → Files & Folders so
   *  the user can grant Documents access. No-op off macOS. */
  "storage:openCapturesAccessSettings": { req: Record<string, never>; res: void };
  /** Actively verify captures-folder (Documents) write access by issuing
   *  a real write probe — which also re-triggers the macOS consent prompt
   *  + re-registers PwrSnap in the Privacy pane when macOS has no decision
   *  on file. Updates the captures-access-health snapshot (so the Library
   *  banner + the Settings row reflect the result) and returns the
   *  outcome. Backs the System Permissions "Check access" button. */
  "storage:checkCapturesAccess": {
    req: Record<string, never>;
    res: { granted: boolean };
  };

  // ---- layers (v2 captures only) ----
  /** List the live layer tree for a v2 capture. Flat array; tree is
   *  built by the consumer via parent_id pointers. Refuses v1
   *  captures (use overlays:* instead). */
  "layers:list": { req: { captureId: string }; res: BundleLayerNode[] };
  /** Insert a layer node. The node carries its own id (nanoid) and
   *  parent_id. Caller validates the shape; main re-validates via
   *  the zod discriminated union before persisting.
   *
   *  `bumpZIndexToMax` (optional, default false) signals that the
   *  insert is a FRESH DRAW that should land at the top of the stack
   *  — the repo resolves z_index to `MAX(existing) + Z_INDEX_INSERT_GAP`
   *  and ignores `layer.z_index`. Fresh-draw callers
   *  (commitArrow / commitRect / etc.) pass `true`. Update-in-place
   *  callers (updateGeometry / updateOverlay / undo restore) leave it
   *  off and the repo stores `layer.z_index` verbatim — including 0
   *  (the Send-to-Back case, which the heuristic-based pre-fix mis-
   *  detected and auto-bumped on every drag-drop). */
  "layers:upsert": {
    req: { captureId: string; layer: BundleLayerNode; bumpZIndexToMax?: boolean };
    res: BundleLayerNode;
  };
  /** Update an existing live layer in place, preserving its id and
   *  z-order. Intended for style/geometry edits where the annotation is
   *  conceptually the same object (for example: make this arrow
   *  x-large), not a fresh draw. */
  "layers:update": {
    req: { captureId: string; layer: BundleLayerNode };
    res: BundleLayerNode;
  };
  /** Move a layer to a new parent (or root via newParentId=null).
   *  Refuses cycles via a recursive-CTE check inside a BEGIN
   *  IMMEDIATE transaction — safe under concurrent reparents from
   *  multiple IPC dispatchers. */
  "layers:reparent": {
    req: { id: string; newParentId: string | null };
    res: { status: "ok" | "would_create_cycle" | "not_found" };
  };
  /** Atomic UPDATE on z_index. Renderers typically use gap-based
   *  reordering (1000-step increments) so most reorders touch only
   *  the moving layer. */
  "layers:reorder": { req: { id: string; zIndex: number }; res: void };
  /** Atomic bulk z-order update. Used by agent tools that rewrite an
   *  ordered layer list instead of issuing several independent
   *  reorder calls. */
  "layers:reorderMany": {
    req: { orders: { id: string; zIndex: number }[] };
    res: void;
  };
  /** Soft-delete a layer. Cascades rejected_at transitively to every
   *  descendant in one transaction — leaving orphaned-but-live
   *  children would render undefined behavior. */
  "layers:delete": { req: { id: string }; res: void };

  /** Atomically apply a v2 viewport crop: re-normalize existing layers,
   *  insert a crop marker layer, and update the capture canvas
   *  dimensions in one main-side transaction. */
  "bundle:cropCanvas": {
    req: {
      captureId: string;
      rect: { x: number; y: number; w: number; h: number };
      source?: "user" | "codex";
    };
    res: {
      previousWidthPx: number;
      previousHeightPx: number;
      widthPx: number;
      heightPx: number;
    };
  };

  /** Render the current composite (source + applied layers) to a
   *  downscaled PNG and return it base64-encoded. Powers the Library
   *  chat agent's `render_composite` vision tool — the agent grounds
   *  redaction/annotation placement on the actual pixels. Goes through
   *  the bake render coordinator (content-addressed cache; does NOT
   *  bump BAKE_PIPELINE_VERSION). `maxEdgePx` clamps the longest edge
   *  (default 720, hard max 1440) to bound the bytes sent to the model
   *  + the LLM image-token cost. PNG (not WebP) for vision-model
   *  compatibility. Works for image captures only. */
  "render:composite": {
    req: { captureId: string; maxEdgePx?: number };
    res: { base64: string; mimeType: "image/png"; widthPx: number; heightPx: number };
  };

  // ---- canvas (v2 captures only) ----
  /** Update the canvas dimensions of a v2 capture. Writes the new
   *  `width_px`/`height_px` to the `captures` row, bumps `edits_version`
   *  so the doctor knows the bundle needs a re-pack, and broadcasts
   *  `events:captures:changed` + `events:overlays:changed` so any open
   *  editor + library window re-fetches the new dims.
   *
   *  This is the v2-native crop semantic — Option A from the plan:
   *  data-layer only, source raster bytes are preserved. Layers whose
   *  absolute coords fall outside the new canvas still exist; the
   *  compositor clips them at canvas bounds. A future undo can grow
   *  the canvas back to original dims and the layers come back fully.
   *
   *  Refuses v1 captures (use overlays:upsert with a CropOverlay).
   *  Refuses widths/heights ≤ 0 and any that exceed the source raster's
   *  natural dimensions (can't "crop bigger" than what was captured). */
  "bundle:updateCanvasDimensions": {
    req: { captureId: string; widthPx: number; heightPx: number };
    res: { previousWidthPx: number; previousHeightPx: number };
  };

  // ---- copy / share ----
  "clipboard:copy": { req: { captureId: string; preset: RenderPreset }; res: void };
  /** Render (or reuse) the image preset cache file and copy it as an
   *  OS file URL so paste targets receive a real PNG filename. */
  "clipboard:copy-file": {
    req: { captureId: string; preset: RenderPreset };
    res: { path: string };
  };
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
  /** v2 only: serialize selected layers (or the entire live tree if
   *  layerIds omitted) into a clipboard payload — private UTI for
   *  PwrSnap-to-PwrSnap fidelity. Standard rendered image copy goes
   *  through clipboard:copy; Electron cannot atomically co-write an
   *  arbitrary private UTI and image bytes. */
  "clipboard:copyLayerFragment": {
    req: { captureId: string; layerIds?: string[] };
    res: { layerCount: number; sourceCount: number; bytes: number };
  };
  /** v2 only: paste a previously-copied fragment into the target
   *  capture. Returns the inserted layer ids so the renderer can
   *  select / animate them. Refuses on v1 captures. */
  "clipboard:pasteLayerFragment": {
    req: { captureId: string; parentId?: string | null };
    res: { insertedLayerIds: string[]; fallbackUsedPng: boolean };
  };

  // ---- editor (v2 only) ----
  /** Phase 5: paste a raster image from the system clipboard as a new
   *  raster layer on the target capture. Mirrors the 5-defense pipeline
   *  from `clipboard:pasteLayerFragment` (size cap, sha256, sharp probe,
   *  dimension cap, sanitized errors). sharp decode + sha256 runs in a
   *  worker thread so the IPC main thread doesn't block on multi-MB
   *  PNGs. If `positionXn`/`positionYn` are provided, the new layer's
   *  transform translates so its top-left lands at that normalized
   *  canvas point; otherwise it lands at the canvas center.
   *
   *  Returns the inserted layer's id so the renderer can select it.
   *  Refuses v1 captures (`v1_capture_use_v2`). */
  "editor:pasteImageAsLayer": {
    req: {
      captureId: string;
      positionXn?: number;
      positionYn?: number;
    };
    res: { layerId: string };
  };
  /** Phase 5: Finder drag-drop equivalent of `editor:pasteImageAsLayer`.
   *  Caller hands a filesystem path; the handler runs `assertSafePastedFile`
   *  (symlink + privileged-dir reject) and then the same worker-backed
   *  decode + sha256 pipeline. Path strings never leak back to the renderer
   *  on rejection — sanitized error codes only. */
  "editor:dropImageAsLayer": {
    req: {
      captureId: string;
      filePath: string;
      positionXn?: number;
      positionYn?: number;
    };
    res: { layerId: string };
  };

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
  /** Open an external URL in the user's default browser. The main-side
   *  handler enforces an https-only host allowlist (PwrSnap product +
   *  docs site + the public GitHub repo) so the renderer can't smuggle
   *  arbitrary navigation through `shell.openExternal`. Used by the
   *  About page's Website / Documentation / Repository links. */
  "app:openExternal": {
    req: { url: string };
    res: void;
  };
  /** Live OS-side launch-at-login state (distinct from the saved
   *  `general.launchAtLogin` preference — macOS/Windows let the user
   *  disable a registered login item OS-side without telling us). The
   *  General page re-reads this after every toggle so the row reflects
   *  what the OS will actually do at next sign-in. */
  "app:launchAtLoginStatus": {
    req: Record<string, never>;
    res: LaunchAtLoginStatus;
  };
  /** Open the OS surface where the user manages startup items (macOS
   *  System Settings → Login Items, Windows Settings → Startup apps).
   *  Recovery path for the `blockedByOs` state. No-op res on platforms
   *  without a deep link. */
  "app:openLoginItemsSettings": {
    req: Record<string, never>;
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

  // ---- system ----
  /**
   * Snapshot of every connected display. The tray uses this to label
   * the All Screens toggle (`N×` vs `1×`) with the live display count;
   * future surfaces can read display bounds without reaching into
   * Electron's `screen` module from the renderer.
   */
  "system:listDisplays": {
    req: Record<string, never>;
    res: {
      displays: Array<{
        id: number;
        bounds: Rect;
        scaleFactor: number;
        isPrimary: boolean;
      }>;
    };
  };

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
  "permissions:readiness": { req: Record<string, never>; res: PermissionReadinessReport };
  /**
   * Trigger an OS-level permission prompt. Microphone uses
   * `askForMediaAccess`. Screen + system-audio issue a real screen-source
   * request (`desktopCapturer.getSources`), which drives the macOS
   * first-grant dialog AND registers PwrSnap in the Privacy pane — this
   * is how a fresh install gets listed there at all. The handler records
   * `recording.screenCapturePrompted` so the next time around the UI
   * routes to System Settings via `permissions:openSystemSettings` (macOS
   * won't prompt twice). Returns the live status read back after the prompt.
   */
  "permissions:request": {
    req: { permission: RecordingPermission };
    res: { status: RecordingPermissionStatus };
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
   * Render and return a GIF or MP4 export for the requested range,
   * preset (LMH), and audio tracks. Cached against (captureId,
   * range, format, preset, audio choices) — re-export with the same
   * args returns instantly. Progress lands on
   * `EVENT_CHANNELS.renderProgress`.
   */
  "video:export": {
    req: VideoExportRequest;
    res: VideoExportResult;
  };
  /**
   * Per-(format, preset) metrics for a video capture. Mirrors
   * `capture:presetMetrics` for images. Returns six entries (2
   * formats × 3 presets). Estimated dims/bytes for combinations that
   * haven't been encoded yet; exact values once the cache has them.
   * The renderer's preset grid calls this on mount to populate the
   * cards before any click.
   */
  "video:presetMetrics": {
    req: { captureId: string };
    res: VideoPresetMetricsResult;
  };
  /**
   * Prepare a video export for native drag-out. Ensures the encoded
   * file exists (cache-hit or fresh encode), generates the drag
   * icon (poster frame), and returns a human-friendly file alias
   * via `prepareRenderedFileAlias`. The main-side IPC listener for
   * `video:drag-start` calls this then fires
   * `event.sender.startDrag({ file, icon })`. Mirrors
   * `capture:prepareDrag` for images.
   */
  "video:prepareDrag": {
    req: VideoExportCoordinates;
    res: VideoPrepareDragResult;
  };
  /**
   * Encode (cache-hit if already done) and copy the resulting file
   * to the system clipboard as a file promise — on macOS, this
   * writes `public.file-url` to NSPasteboard so paste in
   * Slack/Mail/Finder drops the binary using the friendly export
   * alias basename. Sibling of `clipboard:copy` for images, but
   * image clipboard:copy writes raw bytes via nativeImage; videos
   * can't fit through that API so we use file-url instead.
   */
  "clipboard:copyVideoFile": {
    req: VideoExportCoordinates;
    res: { path: string };
  };
  /**
   * Encode (cache-hit if already done) and write the encoded file's
   * POSIX path to the system clipboard as text. Sibling of
   * `clipboard:copy-path` for images.
   */
  "clipboard:copyVideoPath": {
    req: VideoExportCoordinates;
    res: { path: string };
  };

  // ---- codex (Phase 4+) — declared here so Phase 4 lands without protocol bumps ----
  "codex:enrich": {
    req: { captureId: string; triggerSource?: AiEnrichmentTriggerSource };
    res: { runId: string };
  };
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
  "codex:acceptFilenameStem": {
    req: { captureId: string; filenameStem: string };
    res: CaptureEnrichment;
  };
  /** Bulk accept — applies any subset of `{title, description,
   *  filenameStem}` in a single DB transaction + a single broadcast.
   *  Used by the sidebar's prominent "Use draft" button so users get
   *  one atomic accept instead of three sequential dispatches. Omits
   *  tags on purpose; those have their own +/× chip workflow. */
  "codex:acceptAllDrafts": {
    req: {
      captureId: string;
      title?: string;
      description?: string;
      filenameStem?: string;
    };
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
  "codex:budgetStatus": { req: Record<string, never>; res: AiEnrichmentBudgetStatus };

  // ---- Codex auth-profile management (Settings → AI) ----
  /** Enumerate Codex auth profiles (System default + `~/.codex/profiles/*`),
   *  each with signed-in status + account email from `codex login status`
   *  and the cached JWT. Backed by `@pwrdrvr/codex-discovery`. */
  "codex:profiles:list": {
    req: Record<string, never>;
    res: DesktopCodexAuthProfileList;
  };
  /** Create a new `~/.codex/profiles/<name>` auth profile (the name is
   *  normalized + validated). Does NOT log in or select it — the renderer
   *  follows up with a settings patch (select) + `codex:profiles:login`. */
  "codex:profiles:create": {
    req: { name: string };
    res: DesktopCodexAuthProfile;
  };
  /** Start (or re-start) the Codex OAuth login for a profile. Spawns
   *  `codex login` against the profile's CODEX_HOME, scrapes the OAuth URL,
   *  and opens it in the browser via `shell.openExternal`. Resolves once the
   *  URL is opened (`started: true`) or the child exits already
   *  authenticated. */
  "codex:profiles:login": {
    req: { name: string };
    res: DesktopCodexProfileLoginResult;
  };
  "codex:models": {
    req: { includeHidden?: boolean };
    res: CodexModelList;
  };
  // ---- ACP agent discovery (Settings → AI) ----
  /** Discover which built-in ACP agents (Kimi / Qwen / Gemini / Grok) are
   *  installed on this machine. Read-only — wraps `@pwrdrvr/agent-acp`
   *  local discovery, which probes each strategy's CLI with `--version` /
   *  `--help` (no ACP server spawn). Returns every known agent with its
   *  install status so the renderer can list installed + not-installed
   *  agents and let the user enable installed ones. */
  "acp:discover": {
    req: Record<string, never>;
    res: AcpAgentDiscovery;
  };
  /** List the models a specific installed ACP agent advertises. Spawns the
   *  agent in ACP mode, opens a throwaway session to read its runtime models,
   *  and tears it down — so the Settings model picker can show the agent's
   *  real models instead of Codex's. Empty list when the agent isn't
   *  installed or advertises none. */
  "acp:models": {
    /** `refresh: true` bypasses the persisted/in-memory cache and re-spawns the
     *  agent to re-read its models (e.g. after upgrading the agent binary). */
    req: { agentId: string; refresh?: boolean };
    res: AcpAgentModelList;
  };
  "codex:usageSummary": {
    req: { window: AiUsageSummaryWindow };
    res: AiUsageSummary;
  };
  "codex:usageRuns": {
    req: { limit?: number; offset?: number };
    res: AiUsageRunsPage;
  };
  "codex:usageRunDetail": {
    req: { runId: string };
    res: AiRunUsageDetail | null;
  };
  "codex:annotate": {
    req: { captureId: string; triggerSource?: AiEnrichmentTriggerSource };
    res: { runId: string };
  };
  "codex:describe": {
    req: { captureId: string; triggerSource?: AiEnrichmentTriggerSource };
    res: { runId: string };
  };
  "codex:tag": {
    req: { captureId: string; triggerSource?: AiEnrichmentTriggerSource };
    res: { runId: string };
  };
  "codex:filename": {
    req: { captureId: string; triggerSource?: AiEnrichmentTriggerSource };
    res: { runId: string };
  };
  "codex:sensitiveScan": {
    req: { captureId: string; triggerSource?: AiEnrichmentTriggerSource };
    res: { runId: string };
  };
  "codex:cancel": { req: { runId: string }; res: void };
  "codex:ask": { req: { captureId: string; message: string }; res: { threadId: string } };

  // ---- Library Chat (Phase 0) — long-lived, tool-equipped chat threads ----
  //
  // The user-facing agent that lives in the Library sidebar. Threads are
  // persistent (Codex rollout + our pwrsnap-thread.json sidecar) and
  // survive relaunch. See docs/plans/2026-05-28-001-feat-library-chat-
  // editor-interface-plan.md. Streaming + approval flows ride the
  // `events:libraryChat:*` channels (see ipc.ts), not these verbs.

  /** List all (non-archived by default) chat threads for the thread-list
   *  rail. `includeArchived` surfaces archived threads for a "show
   *  archived" toggle. */
  /** List chat threads. `anchorCaptureId` scopes the list to one
   *  capture's threads (chats are glued to assets — the rail shows only
   *  the focused capture's threads). Omit to list every thread. */
  "codex:libraryChat:list": {
    req: { includeArchived?: boolean; anchorCaptureId?: string | null };
    res: { threads: LibraryChatThreadView[] };
  };
  /** Create a new thread. `name` optional — main mints a default
   *  ("Chat <date>") when omitted. `anchorCaptureId` glues the thread
   *  to the capture it was started from. `provider`/`model`/`reasoning`
   *  are the thread's chosen backend config (from the New-Chat chips);
   *  omitted = the surface's Settings default. They're persisted on the
   *  thread and locked once it has a first message. Returns the view for
   *  optimistic rendering. */
  "codex:libraryChat:create": {
    req: {
      name?: string;
      anchorCaptureId?: string | null;
      provider?: string;
      model?: string;
      reasoning?: string;
    };
    res: LibraryChatThreadView;
  };
  /** Send a user message + (optionally) attached image paths. Returns
   *  the turnId; streaming deltas + the committed assistant message
   *  arrive via `events:libraryChat:*`. `anchorCaptureId` lets the
   *  renderer pin the thread to whatever the user is currently viewing
   *  so the per-turn context is accurate. */
  "codex:libraryChat:send": {
    req: {
      threadId: string;
      text: string;
      imageAttachmentPaths?: string[];
      anchorCaptureId?: string | null;
    };
    res: { turnId: string };
  };
  /** Full message history for a thread (read on open / re-subscribe). */
  "codex:libraryChat:history": {
    req: { threadId: string };
    res: { messages: ChatMessage[] };
  };
  /** Rename a thread. */
  "codex:libraryChat:rename": {
    req: { threadId: string; name: string };
    res: LibraryChatThreadView;
  };
  /** Archive / unarchive a thread (soft delete — never destroys the
   *  Codex rollout). */
  "codex:libraryChat:archive": {
    req: { threadId: string; archived: boolean };
    res: LibraryChatThreadView;
  };
  /** Interrupt an in-flight turn (turn/interrupt). No-op if idle. */
  "codex:libraryChat:interrupt": {
    req: { threadId: string };
    res: void;
  };
  /** Resolve a pending approval. Carries (threadId, turnId, approvalId)
   *  so a late resolution can't land in the wrong turn (plan §F10 T3). */
  "codex:libraryChat:approval": {
    req: {
      threadId: string;
      turnId: string;
      approvalId: string;
      decision: ChatApprovalDecision;
    };
    res: void;
  };

  // ── Sizzle composer chat ────────────────────────────────────────────
  // Second surface on the shared chat substrate (mirrors codex:libraryChat:*).
  // `anchorCaptureId` carries the Sizzle PROJECT id this thread is scoped
  // to — the substrate's anchor field is surface-neutral, and a project id
  // (`sz_…`) never collides with a capture id. Mutations are bound to it.
  "codex:sizzleChat:list": {
    req: { includeArchived?: boolean; anchorCaptureId?: string | null };
    res: { threads: LibraryChatThreadView[] };
  };
  "codex:sizzleChat:create": {
    req: {
      name?: string;
      anchorCaptureId?: string | null;
      provider?: string;
      model?: string;
      reasoning?: string;
    };
    res: LibraryChatThreadView;
  };
  "codex:sizzleChat:send": {
    req: {
      threadId: string;
      text: string;
      imageAttachmentPaths?: string[];
      anchorCaptureId?: string | null;
    };
    res: { turnId: string };
  };
  "codex:sizzleChat:history": {
    req: { threadId: string };
    res: { messages: ChatMessage[] };
  };
  "codex:sizzleChat:rename": {
    req: { threadId: string; name: string };
    res: LibraryChatThreadView;
  };
  "codex:sizzleChat:archive": {
    req: { threadId: string; archived: boolean };
    res: LibraryChatThreadView;
  };
  "codex:sizzleChat:interrupt": {
    req: { threadId: string };
    res: void;
  };
  "codex:sizzleChat:approval": {
    req: {
      threadId: string;
      turnId: string;
      approvalId: string;
      decision: ChatApprovalDecision;
    };
    res: void;
  };

  "sizzle:open": { req: { projectId?: string }; res: void };
  "sizzle:list": { req: Record<string, never>; res: { projects: SizzleProject[] } };
  "sizzle:create": { req: { name: string }; res: SizzleProject };
  "sizzle:duplicate": {
    req: { id: string; name?: string; forkChat?: boolean };
    res: SizzleProject;
  };
  "sizzle:update": {
    req: {
      id: string;
      patch: Partial<Omit<SizzleProject, "id" | "createdAt">>;
    };
    res: SizzleProject;
  };
  "sizzle:delete": { req: { id: string }; res: void };
  "sizzle:render": {
    req: { id: string };
    res: { outputPath: string; durationSec: number };
  };
  "sizzle:revealOutput": { req: { id: string }; res: void };
  /**
   * Toggle a capture's membership in a project. If the capture is
   * already a scene of the project, remove that scene. Otherwise
   * append a new scene seeded with the capture's Codex enrichment
   * description (mirrors the editor's "Add scene" flow). Returns the
   * updated project for optimistic UI rendering.
   *
   * Used by the in-Library "Add captures" mode where every grid cell
   * gets a +/✓ overlay.
   */
  "sizzle:toggleScene": {
    req: { projectId: string; captureId: string };
    res: SizzleProject;
  };
  /** Synthesize (or fetch from cache) the per-scene audio and
   *  return it as a base64-encoded audio blob the renderer can play in an
   *  <audio> tag. Used by the per-scene ▶ button so users can preview
   *  the voiceover or native clip audio without rendering the full reel.
   *  Returns the same audio file the renderer pipeline will use, so
   *  what you preview is what you get. */
  "sizzle:previewSceneAudio": {
    req: { projectId: string; sceneId: string };
    res: { audioBase64: string; mimeType: "audio/mpeg" | "audio/mp4"; durationSec: number };
  };
  /** Resolve a sequence scene's narration audio + visual beat windows
   *  for the editor timeline. This is intentionally lighter than render:
   *  it synthesizes/loads narration timing, resolves phrase anchors, and
   *  returns beat windows plus warnings, but it does not compose video. */
  "sizzle:previewSequenceScenePlan": {
    req: { projectId: string; sceneId: string };
    res: SizzleSequencePreviewPlan;
  };
  /** Cache-only read of a sequence scene's narration audio for the
   *  editor waveform. Unlike `previewSequenceScenePlan`, this NEVER
   *  synthesizes or hits any API — it only returns content-addressed
   *  cache files that are already on disk (audio, plus cached transcript
   *  phrases when speech timing was previously resolved). Safe to call
   *  proactively on reel open without spending TTS/transcription credits;
   *  returns `{ cached: false }` when the audio has not been generated yet. */
  "sizzle:loadSequenceSceneAudio": {
    req: { projectId: string; sceneId: string };
    res:
      | {
          cached: true;
          audioBase64: string;
          mimeType: "audio/mpeg";
          transcriptPhrases: SizzleSequenceTranscriptPhrase[];
        }
      | { cached: false };
  };

  // ── Project Asset Cart ──────────────────────────────────────────────
  // The single global draft cart the user fills from the Library, then
  // commits into a new or existing Sizzle Reel. See `DraftCart`. Every
  // mutating verb returns the updated cart so the renderer can render
  // optimistically; they ALSO broadcast `events:cart:changed` so other
  // windows / the DetailRail tab stay in sync.
  "cart:get": { req: Record<string, never>; res: DraftCart };
  /** Add the capture if absent, remove it if already present. New
   *  additions append to the END of `captureIds` (check order). */
  "cart:toggle": { req: { captureId: string }; res: DraftCart };
  /** Move the item at `from` to index `to` (clamped to bounds). */
  "cart:reorder": { req: { from: number; to: number }; res: DraftCart };
  "cart:remove": { req: { captureId: string }; res: DraftCart };
  "cart:rename": { req: { name: string }; res: DraftCart };
  "cart:clear": { req: Record<string, never>; res: DraftCart };
  /**
   * Mint a new Sizzle Reel from the cart contents (scenes in cart
   * order), clear the cart, and return the new project. `name`
   * overrides the cart's `name` for the project title when supplied.
   */
  "cart:commitToNewProject": {
    req: { name?: string };
    res: SizzleProject;
  };
  /**
   * Append the cart's captures to an existing project's scenes
   * (skipping any captureIds already present — the "Add to existing"
   * affordance de-dups), clear the cart, return the updated project.
   */
  "cart:commitToExisting": {
    req: { projectId: string };
    res: SizzleProject;
  };
  /**
   * Export the cart's image captures as a single Zip at one preset size
   * (Low/Med/High). Prompts for a save location, renders each image at the
   * preset (reusing the cached export pipeline), zips them, and reveals the
   * file. Non-image / trashed / missing captures are skipped (counted in
   * `skipped`). Does NOT mutate the cart. Returns an error with code
   * `cancelled` if the user dismisses the save dialog, or `nothing_to_export`
   * if no image survives the filter.
   */
  "cart:exportZip": {
    req: {
      captureIds: string[];
      preset: RenderPreset;
      /** Slug used as the default save filename (before .zip). */
      suggestedName?: string;
      /**
       * Renderer-minted id correlating this export to its progress
       * broadcasts (`EVENT_CHANNELS.cartExportProgress`) and to a
       * `cart:exportZip:cancel` for the same job.
       */
      jobId: string;
    };
    res: {
      path: string;
      fileCount: number;
      byteSize: number;
      /** Captures filtered out before rendering (video / trashed / missing). */
      skipped: number;
      /** Images that errored during render and were left out of the zip. */
      failed: number;
    };
  };
  /**
   * Cancel an in-flight `cart:exportZip` by its `jobId`. The export bails
   * at the next inter-render checkpoint and returns its own `cancelled`
   * error; this verb just trips the abort. `cancelled` is false when no
   * job by that id is running (already finished / unknown).
   */
  "cart:exportZip:cancel": {
    req: { jobId: string };
    res: { cancelled: boolean };
  };
  /**
   * Render the cart's images at `preset`, zip them to a temp file, and
   * return its path — the drag bridge (`IPC_CART_ZIP_DRAG_START`) hands the
   * file to `WebContents.startDrag` so the user can drag the Zip straight
   * out to Finder / Slack / a folder. No save dialog (that's
   * `cart:exportZip`); same skip-filter (image-only). `iconPath` is the
   * first rendered image, used as the drag cursor image (null if none).
   */
  "cart:prepareZipDrag": {
    req: { captureIds: string[]; preset: RenderPreset; suggestedName?: string };
    res: { path: string; fileCount: number; iconPath: string | null };
  };
};

export type CommandName = keyof Commands;
export type Req<C extends CommandName> = Commands[C]["req"];
export type Res<C extends CommandName> = Commands[C]["res"];
