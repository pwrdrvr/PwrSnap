// Typed `Commands` registry. Single source of truth across main /
// preload / renderer / external transports (HTTP RPC in Phase 7, MCP
// later). Every command-bus.dispatch(name, req) call typechecks the
// request and the response against this map.
//
// Adding a command: declare it here, then register a handler in
// apps/desktop/src/main/command-bus.ts. The renderer + RPC server pick
// up the new command for free.

import type { BundleLayerNode } from "./bundle-manifest-schema-v2";
import type { Overlay, OverlayRow } from "./overlay-schemas";
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
export type DesktopSettingsSecretName = "grokApiKey" | "openaiApiKey";

export type SizzleTtsProvider = "openai" | "xai";
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

export type SizzleScene = {
  id: string;
  captureId: string;
  scriptLine: string;
  durationOverrideSec: number | null;
};

export type SizzleProject = {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  scenes: SizzleScene[];
  voice: SizzleVoice;
  ttsModel: SizzleTtsModel;
  ttsProvider: SizzleTtsProvider;
  resolution: "1080p" | "720p";
  outputPath: string | null;
  lastRenderedAt: string | null;
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

/** Codex CLI models PwrSnap will spawn for the capture-enrichment turn.
 *  Sourced from https://developers.openai.com/codex/models — kept as a
 *  literal union so the validator, the renderer dropdown, and the
 *  Settings type all draw from one list. Mini-tier only today because
 *  captioning fires on every capture; expand when there's a reason to
 *  spend a larger model's tokens on a screenshot description. */
export const CODEX_CAPTION_MODELS = ["gpt-5.4-mini"] as const;
export type CodexCaptionModel = (typeof CODEX_CAPTION_MODELS)[number];
export const DEFAULT_CODEX_CAPTION_MODEL: CodexCaptionModel = "gpt-5.4-mini";

export function isCodexCaptionModel(value: unknown): value is CodexCaptionModel {
  return (
    typeof value === "string" &&
    (CODEX_CAPTION_MODELS as readonly string[]).includes(value)
  );
}

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
export type { ArrowEndStyle, ArrowStemStyle } from "./overlay-schemas";
import type { ArrowEndStyle, ArrowStemStyle } from "./overlay-schemas";
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

export type RectToolStyle = {
  color: ToolColor;
  thickness: ToolSizePreset | number;
  filled: boolean;
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
  rect: RectToolStyle;
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
 *  Library — the available surfaces (Info / OCR / Chat) are
 *  different from the editor's (Info / Chat / Tool Config / Help). */
export type LibrarySidebarTab = "info" | "ocr" | "chat";

export const LIBRARY_SIDEBAR_TABS = [
  "info",
  "ocr",
  "chat"
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
};

// ---- Chat message content (Phase 7 prep, exported only) ----------------
//
// Defined here so Phase 7's `chat-schemas.ts` zod definitions and the
// renderer's chat panel can share the same discriminated-union shape.
// Phase 1 does NOT reference these — kept so the protocol surface stays
// a single source of truth as later phases land.

export type ChatMessageContent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; toolName: string; argsJson: string; callId: string }
  | {
      kind: "tool_result";
      callId: string;
      resultJson: string;
      /** True for tool failures the AI saw and (typically) self-corrected
       *  from. Stored so the chat panel can render a subtle "AI's last
       *  call was rejected — retrying" indicator without inferring it
       *  from a parse of resultJson. */
      isError?: boolean;
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
  /** Editor preferences are deep-nested (toolStyles per tool kind),
   *  so the patch type drops one level deeper than the other branches.
   *  Each leaf style is `Partial<>` so a swatch click can ship just the
   *  changed field rather than re-echoing the full style block. */
  editor?: {
    toolStyles?: {
      arrow?: Partial<ArrowToolStyle>;
      text?: Partial<TextToolStyle>;
      rect?: Partial<RectToolStyle>;
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
  | { status: "error"; message: string };

export type AppUpdateInstallResult =
  | { status: "restarting" }
  | { status: "error"; message: string };

/**
 * Progress payload for `events:legacy-bundle-migration:progress`. Fired
 * by the one-shot legacy → v1-bundle wrapper on first boot post-bundle-
 * format. Library shows an "Upgrading library…" banner while status is
 * "running"; banner auto-dismisses on "complete".
 *
 *   • `total` — rows the runner queued at start. Includes parked
 *     (exhausted-retry) rows in the count so the user sees a stable
 *     denominator even across boots that find new attempts.
 *   • `done` — rows that have either succeeded OR been parked
 *     (giving up after MAX_ATTEMPTS). Both count toward "done" since
 *     neither will be retried this run.
 *   • `failed` — subset of `done` that failed (parked or transient).
 *     A run with `failed > 0` after `status === "complete"` is worth
 *     surfacing as a one-time toast.
 */
export type LegacyBundleMigrationProgress =
  | { status: "running"; total: number; done: number; failed: number }
  | { status: "complete"; total: number; done: number; failed: number };

/**
 * Progress payload for `events:v1-to-v2-doctor:progress`. Fired by the
 * v1 → v2 bundle doctor (apps/desktop/src/main/persistence/
 * v1-to-v2-doctor.ts) for both the boot-time reconcile sweep AND
 * per-capture lazy upgrades. Editor toolbar consumes this to show the
 * "Upgrading…" banner during a doctor run; library banner reports
 * boot-time progress.
 *
 * Two scopes share the channel:
 *   • Boot-time sweep — fired once at run start (with total), throttled
 *     per row, once at completion.
 *   • Per-capture lazy — fired at start (`captureId` set, `total: 1`),
 *     once at success or failure.
 *
 * The `captureId` field disambiguates per-capture events from the
 * boot-time global progress (captureId === null in the latter).
 * Mirrors the LegacyBundleMigrationProgress shape so the renderer
 * can reuse the same banner component.
 */
export type V1ToV2DoctorProgress =
  | {
      status: "running";
      captureId: string | null;
      total: number;
      done: number;
      failed: number;
    }
  | {
      status: "complete";
      captureId: string | null;
      total: number;
      done: number;
      failed: number;
    }
  | {
      /** Per-capture failure event. `captureId` set; `errorCode`
       *  carries the structured error envelope so the editor banner
       *  can offer a Retry button bound to the right capture. */
      status: "failed";
      captureId: string;
      errorCode: string;
      attempts: number;
      parked: boolean;
    };

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

  /** Current status of the legacy-bundle migration, or `null` if no
   *  migration has run this boot. The migration also broadcasts live
   *  updates via `EVENT_CHANNELS.legacyBundleMigrationProgress`; this
   *  verb exists to recover from the cold-start race where the
   *  renderer's banner mounts AFTER the first progress events were
   *  sent (and thus dropped — `webContents.send` is fire-and-forget,
   *  not buffered). The banner queries this on mount to pick up the
   *  current snapshot, then watches the event channel for updates. */
  "migration:status": {
    req: Record<string, never>;
    res: LegacyBundleMigrationProgress | null;
  };

  // ---- v1 → v2 bundle doctor ----
  /** Trigger the per-capture v1 → v2 bundle doctor for `captureId`.
   *  Idempotent: returns `{ migrated: false, reason: "already_v2" }`
   *  if the bundle on disk is already v2 (reads the bundle manifest,
   *  not the DB row — heals mid-crash gaps where the row claims v1
   *  but the bundle is already v2). Per-capture retry budget (5
   *  attempts); after exhaustion the row parks and the editor renders
   *  read-only with a Retry button that calls `v1ToV2:retry`.
   *
   *  Atomic ordering inside the implementation:
   *    1. atomicWriteBundle(tempPath, v2_bytes) + fsync
   *    2. BEGIN IMMEDIATE
   *       INSERT INTO layers (...);
   *       UPDATE captures SET bundle_format_version=2, bundle_path=tempPath, ...;
   *       COMMIT
   *    3. rename(tempPath → finalBundlePath) + dir-fsync
   *    4. DELETE FROM overlays WHERE capture_id = ?
   *
   *  Each step is independently recoverable; `reconcileV1ToV2OnBoot`
   *  heals any mid-step crash.
   */
  "v1ToV2:upgrade": {
    req: { captureId: string };
    res: { migrated: boolean; reason?: "already_v2" | "parked" | "no_bundle" };
  };
  /** Cached-snapshot reader for the v1 → v2 doctor. Same race-safe
   *  pattern as `migration:status` — late-mounting renderers query
   *  this once on mount to pick up the current state, then subscribe
   *  to `events:v1-to-v2-doctor:progress` for updates. Returns null
   *  if no doctor activity has happened this session. */
  "v1ToV2:status": {
    req: Record<string, never>;
    res: V1ToV2DoctorProgress | null;
  };
  /** Clear a parked capture's retry budget so the doctor can re-attempt
   *  on next user open. Sets `v1_to_v2_attempts = 0` and clears
   *  `v1_to_v2_last_failed_at` + `v1_to_v2_last_error_code`. Bound to
   *  the Retry button on the editor's "Couldn't upgrade — read-only
   *  view" banner. */
  "v1ToV2:retry": {
    req: { captureId: string };
    res: void;
  };

  // ---- storage ----
  "storage:summary": { req: Record<string, never>; res: StorageSummary };
  "storage:snapshot": { req: { force?: boolean; audit?: boolean }; res: StorageSnapshot };
  "storage:clearAppCache": { req: Record<string, never>; res: StorageMaintenanceResult };
  "storage:maintainRenderCache": {
    req: { mode: RenderCacheMaintenanceMode };
    res: StorageMaintenanceResult;
  };

  // ---- overlays (v1 captures only) ----
  "overlays:list": { req: { captureId: string }; res: OverlayRow[] };
  "overlays:upsert": { req: { captureId: string; overlay: Overlay }; res: OverlayRow };
  "overlays:delete": { req: { id: string }; res: void };
  /** Update an overlay's `z_index`. Mirrors `layers:reorder` for v1
   *  captures so the renderer can use the same `kind: "reorder"`
   *  dispatch op across both formats without format-specific
   *  branching. The handler computes the new value; the renderer
   *  picks values with gap (~1000-step) so most reorders avoid
   *  re-numbering neighbors. Atomic UPDATE on z_index; id preserved
   *  (unlike upsert which would churn the id on every move). */
  "overlays:reorder": { req: { id: string; zIndex: number }; res: void };

  // ---- layers (v2 captures only) ----
  /** List the live layer tree for a v2 capture. Flat array; tree is
   *  built by the consumer via parent_id pointers. Refuses v1
   *  captures (use overlays:* instead). */
  "layers:list": { req: { captureId: string }; res: BundleLayerNode[] };
  /** Insert a layer node. The node carries its own id (nanoid) and
   *  parent_id. Caller validates the shape; main re-validates via
   *  the zod discriminated union before persisting. */
  "layers:upsert": { req: { captureId: string; layer: BundleLayerNode }; res: BundleLayerNode };
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
  /** Soft-delete a layer. Cascades rejected_at transitively to every
   *  descendant in one transaction — leaving orphaned-but-live
   *  children would render undefined behavior. */
  "layers:delete": { req: { id: string }; res: void };

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
   *  PwrSnap-to-PwrSnap fidelity, standard PNG fallback for everyone
   *  else (Slack, Messages, Mail). */
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
  "codex:annotate": { req: { captureId: string }; res: { runId: string } };
  "codex:describe": { req: { captureId: string }; res: { runId: string } };
  "codex:tag": { req: { captureId: string }; res: { runId: string } };
  "codex:filename": { req: { captureId: string }; res: { runId: string } };
  "codex:sensitiveScan": { req: { captureId: string }; res: { runId: string } };
  "codex:cancel": { req: { runId: string }; res: void };
  "codex:ask": { req: { captureId: string; message: string }; res: { threadId: string } };

  "sizzle:open": { req: { projectId?: string }; res: void };
  "sizzle:list": { req: Record<string, never>; res: { projects: SizzleProject[] } };
  "sizzle:create": { req: { name: string }; res: SizzleProject };
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
  /** Synthesize (or fetch from cache) the per-scene voiceover and
   *  return it as a base64-encoded MP3 the renderer can play in an
   *  <audio> tag. Used by the per-scene ▶ button so users can preview
   *  the voiceover for a single line without rendering the full reel.
   *  Returns the same audio file the renderer pipeline will use, so
   *  what you preview is what you get. */
  "sizzle:previewSceneAudio": {
    req: { projectId: string; sceneId: string };
    res: { audioBase64: string; mimeType: "audio/mpeg"; durationSec: number };
  };
};

export type CommandName = keyof Commands;
export type Req<C extends CommandName> = Commands[C]["req"];
export type Res<C extends CommandName> = Commands[C]["res"];
