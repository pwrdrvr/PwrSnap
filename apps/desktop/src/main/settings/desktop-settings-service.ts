// Internal settings persistence adapter. DesktopSettingsStore is the sole
// production owner. The first read hydrates an immutable snapshot from disk;
// subsequent reads stay in memory for the process lifetime. Reads
// route through an ordered legacy-shape catalog
// (see SHAPE_CATALOG below) so schema growth doesn't force eager migrations
// on read — we rewrite on the next `write`. Atomic writes serialize through
// one promise chain and replace the snapshot only after rename succeeds.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AcpAgentPreference,
  AcpSettings,
  AiSurfaceDefault,
  AiSurfaceDefaultPatch,
  AiSurfaceDefaults,
  AppearanceTheme,
  ArrowEndStyle,
  ArrowStemStyle,
  ArrowToolStyle,
  BlurEffectMode,
  BlurRadiusSetting,
  BlurToolStyle,
  ChatSettings,
  EditorCoachmarks,
  EditorMatchingText,
  EditorSettings,
  EditorSidebarPanel,
  EditorSidebarSettings,
  EditorToolStyles,
  FilenameTimestampZone,
  CapturesLocation,
  HotCpuProfileStartDelayMs,
  HotCpuProfileTriggerMode,
  LibrarySidebarTab,
  HighlightBlendMode,
  HighlightToolStyle,
  LocalAgentCapability,
  LocalAgentClientGrant,
  LocalAgentRoleProfile,
  LocalAgentRoleBudgets,
  OverlayOutlineMode,
  ShapeKind,
  ShapeToolStyle,
  SensitiveDataPattern,
  Settings,
  SettingsPatch,
  ShortcutPlatform,
  TextFontWeight,
  TextToolStyle,
  ToolColor,
  ToolSizePreset,
  QuickCaptureAction,
  UpdateChannel,
  UpdateSelectionSource,
  UpdateTrain
} from "@pwrsnap/shared";
import {
  isOverlayOutlineMode,
  DEFAULT_AI_SURFACE_DEFAULTS,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_CODEX_CAPTION_MODEL,
  DEFAULT_ENRICHMENT_REASONING_EFFORT,
  DEFAULT_HOTKEYS,
  acceleratorsAreEquivalent,
  defaultHotkeysForPlatform,
  HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT,
  HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
  HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
  GRID_ZOOM_DEFAULT,
  GRID_ZOOM_MAX,
  GRID_ZOOM_MIN,
  MAX_HIGHLIGHT_OPACITY,
  defaultEditorToolStyles,
  isAiReasoningEffort,
  isAppearanceTheme,
  isBuiltInAcpAgentId,
  isCodexCaptionModel,
  isColorToken,
  isEditorSidebarPanel,
  isHotCpuProfileStartDelayMs,
  isHotCpuProfileTriggerMode,
  isGridCopyPaletteAnchor,
  isLibrarySidebarTab,
  isLocalAgentCapability,
  isQuickCaptureAction,
  QUICK_CAPTURE_ACTION_DEFAULT,
  RECORDING_MEDIA_DEFAULTS,
  findRoleForCapabilities,
  defaultLocalAgentRoleConstraints,
  isValidRole,
  LOCAL_AGENT_BUILT_IN_ROLES,
  isRedactionStyle,
  inferUpdateSelection,
  isUpdateChannel,
  isUpdateTrain,
  isUpdateSelectionSource,
  UPDATE_CHANNEL_DEFAULT,
  UPDATE_SELECTION_SOURCE_DEFAULT,
  UPDATE_TRAIN_DEFAULT,
  shortcutPlatformFromString
} from "@pwrsnap/shared";
import { getMainLogger } from "../log";
const LEGACY_ENRICHMENT_DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULTS_MIGRATION_VERSIONS: readonly string[] = [
  "1.0.0-beta.26",
  "1.1.0-alpha.5"
];
const CURRENT_DEFAULTS_MIGRATION_VERSION = "1.1.0-alpha.5";

type Logger = ReturnType<typeof getMainLogger>;

export type DesktopSettingsServiceConfig = {
  filePath: string;
  logger?: Logger;
  /** Explicit host shortcut semantics for defaults and managed migrations. */
  shortcutPlatform?: ShortcutPlatform;
  /** Installed app version used to seed `updates.train` / `updates.channel`
   *  when both keys are absent from the file. Tests pass this explicitly
   *  so inference does not depend on Electron. */
  appVersion?: string;
  resolveAppVersion?: () => string;
  /** Narrow I/O seam for deterministic store tests. Production leaves this
   *  unset and reads UTF-8 through node:fs/promises. */
  readTextFile?: (filePath: string) => Promise<string>;
};

export type DesktopSettingsWritePreparation = {
  /** Finalize staged external state after the atomic settings rename lands. */
  commit(): void;
  /** Undo staged external state when the settings write fails. */
  rollback(): void | Promise<void>;
};

export type DesktopSettingsWriteOptions = {
  /**
   * Runs inside the service's serialized write queue, after merge and before
   * persistence. Used for resources (notably global shortcuts) that must be
   * proven available before their setting becomes durable.
   */
  prepare?: (
    current: Settings,
    merged: Settings
  ) => DesktopSettingsWritePreparation | Promise<DesktopSettingsWritePreparation>;
};

export type SerializedSettingsOperation<T> = (
  current: Settings
) => T | Promise<T>;

export type DesktopSettingsIoDiagnostics = Readonly<{
  fileReads: number;
  atomicWrites: number;
}>;

export function defaultSettings(
  shortcutPlatform: ShortcutPlatform = shortcutPlatformFromString(process.platform)
): Settings {
  return {
    schemaVersion: 1,
    lastDefaultsMigrationVersion: CURRENT_DEFAULTS_MIGRATION_VERSION,
    codex: {
      mode: "auto",
      pinnedPath: "",
      profile: "",
      captionModel: DEFAULT_CODEX_CAPTION_MODEL
    },
    ai: {
      enabled: false,
      consentAcceptedAt: null,
      budgetSafetyDisabledAt: null,
      autoAcceptSuggestions: false,
      chat: { ...DEFAULT_CHAT_SETTINGS, sensitiveDataPatterns: [] },
      // Empty surface objects mean "follow the managed default". Runtime and
      // Settings resolve enrichment to Luna Low without persisting that pair,
      // so future default changes automatically carry unpinned users forward.
      defaults: {
        libraryChat: { ...DEFAULT_AI_SURFACE_DEFAULTS.libraryChat },
        sizzleChat: { ...DEFAULT_AI_SURFACE_DEFAULTS.sizzleChat },
        enrichment: { ...DEFAULT_AI_SURFACE_DEFAULTS.enrichment }
      },
      // No ACP agents enabled on a fresh install. The user opts agents
      // into the enabled set from Settings → AI → ACP agents (additive,
      // no schemaVersion bump).
      acp: { enabledAgentIds: [], agents: {} }
    },
    // Single source of truth shared with the renderer's "Reset to
    // defaults" button. Rationale for each chord lives on the
    // `DEFAULT_HOTKEYS` declaration in @pwrsnap/shared.
    hotkeys: defaultHotkeysForPlatform(shortcutPlatform),
    general: {
      developerMode: false,
      hotCpuProfilingEnabled: false,
      hotCpuProfilingStartDelayMs: HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
      hotCpuProfilingTriggerMode: HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
      hotCpuProfilingSlowburnThresholdPercent:
        HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT,
      hotCpuProfilingCaptureHeapSnapshot: false,
      hotCpuProfilingHeapSnapshotLimit: 2,
      // Login-item registration is opt-in — silently installing
      // ourselves into the user's startup sequence on first run would
      // be hostile. The user flips it on in Settings -> General.
      launchAtLogin: false
    },
    experimental: {
      // macOS two-process split ships default-OFF (plan 2026-06-12-001):
      // regular users get the single-process (combined) app; the split
      // is opt-in via Settings → Experimental → "Two-process mode" while
      // it soaks. Ignored off macOS. Read once at process start —
      // relaunch to apply.
      processSplit: false,
      // DPI-aware export ships OFF so the default install keeps the
      // legacy 800 / 1440 / source preset widths. Power users opt in from
      // Settings → Experimental. `allowRetinaExport` only matters once the
      // toggle is on; it defaults ON so the opt-in state is "give me the
      // full Retina image at High".
      dpiAwareExport: false,
      allowRetinaExport: true
    },
    appearance: {
      // "system" tracks the OS appearance via the renderer's
      // matchMedia listener. Explicit "dark" / "light" override.
      theme: "system"
    },
    updates: {
      // Stable Latest is only the shape of the default — `selectionSource:
      // "inferred"` means the pair is re-derived from the running binary
      // on every hydration (`parseUpdates`), so a website Beta or alpha
      // download follows its own feed until somebody picks a slot.
      channel: UPDATE_CHANNEL_DEFAULT,
      train: UPDATE_TRAIN_DEFAULT,
      selectionSource: UPDATE_SELECTION_SOURCE_DEFAULT
    },
    storage: {
      // Local timestamps match what single users remember seeing on
      // screen/Finder. UTC is still available for shared-drive teams.
      filenameTimestampZone: "local",
      // Documents remains the discoverable first-run default. A real
      // capture-time TCC denial flips this to home and persists it so later
      // grants never silently split the library across two roots.
      capturesLocation: "documents"
    },
    recording: {
      // The chooser is the default: `ask` puts a Record action next to
      // Capture in the selector HUD and binds `R` to it, WITHOUT adding a
      // step — ↵ still snaps. Users who never want the affordance pick
      // "snap"; users who mostly record pick "record".
      quickCaptureAction: QUICK_CAPTURE_ACTION_DEFAULT,
      // Audio OFF, video cursor ON — from shared, because the capture
      // path needs the same three values when its settings read fails
      // and must not import this module to get them. Rationale for each
      // lives on the constant.
      includeSystemAudio: RECORDING_MEDIA_DEFAULTS.includeSystemAudio,
      includeMicrophone: RECORDING_MEDIA_DEFAULTS.includeMicrophone,
      videoCaptureCursor: RECORDING_MEDIA_DEFAULTS.videoCaptureCursor,
      // Image cursor capture is settings-only (consumed by the still
      // pipeline, never by a recording), so it stays local.
      imageCaptureCursor: true,
      lastRoutedPermissionFingerprint: "",
      // Fresh install has never triggered the macOS Screen Recording
      // prompt, so the System Permissions page + the capture gate show
      // "Not yet requested" and fire the OS prompt on first use rather
      // than dead-ending at "Open System Settings".
      screenCapturePrompted: false
    },
    editor: defaultEditorSettings(),
    library: defaultLibrarySettings(),
    localAgents: {
      // Local-agent access is an explicit opt-in. When enabled, every MCP
      // request is still subject to its Session's RBAC role and limits.
      enabled: false,
      grants: [],
      roles: LOCAL_AGENT_BUILT_IN_ROLES.map((role) => ({
        ...role,
        permissions: [...role.permissions],
        budgets: cloneLocalAgentBudgets(role.budgets)
      })),
      audit: []
    }
  };
}

/** Library preferences default. Currently just the DetailRail
 *  right-bar state. Pinned + Info-first is the more discoverable
 *  default in Library (vs. the editor's collapsed default) — Library
 *  users mostly come to read details, not to draw on canvas. */
function defaultLibrarySettings(): Settings["library"] {
  return {
    detailRail: {
      pinned: true,
      lastSelectedTab: "info"
    },
    // Follow-the-selection is the default: the floating copy palette
    // should show up next to the tile the user just clicked, not parked
    // at the bottom of the stage.
    gridCopyPalette: {
      anchor: "follow"
    },
    // Confirm soft-deletes by default; users can opt out via the popover's
    // "Don't ask again" or re-enable in Settings → Storage & retention.
    confirmBeforeTrash: true,
    // Matches the historical CSS `minmax(180px, 1fr)`. Pinch-to-zoom on
    // the grid steps this through GRID_ZOOM_LEVELS.
    gridZoom: GRID_ZOOM_DEFAULT
  };
}

/** Default tool style memory + sidebar state for the v2 editor (Phase 1).
 *  Pulled into its own function because the editor block is materially
 *  bigger than the other sections AND parseV1 re-uses these as the
 *  fallback when an older file lacks the `editor` field entirely. */
function defaultEditorSettings(): EditorSettings {
  return {
    // Factory defaults live in @pwrsnap/shared (defaultEditorToolStyles)
    // so the renderer's tool-state hook falls back to the SAME values
    // while `settings:read` is in flight — a fresh install's persisted
    // defaults and the pre-settle in-memory defaults cannot drift.
    toolStyles: defaultEditorToolStyles(),
    coachmarks: {
      // Flips true the first time the user opens any tool style popover
      // and the 3s stoplight micro-coachmark auto-dismisses.
      stoplightSeen: false
    },
    matchingText: {
      // "+ Add label" affordance appears after arrow placement by
      // default. User can disable from Settings → Editor if it feels
      // intrusive for their workflow.
      enabled: true
    },
    sidebar: {
      // Default to collapsed (hover-pop only) so a first-time user
      // sees the chromeless v1-equivalent editor; the moment they
      // click an activity bar icon, the panel pins. lastSelectedPanel
      // defaults to "toolConfig" so re-pinning lands on the most
      // immediately-useful surface.
      pinned: false,
      lastSelectedPanel: "toolConfig"
    }
  };
}

/** One entry in the legacy-shape catalog. Newest first; the first
 *  entry that returns a non-null Settings wins.
 *
 *  Today's catalog has exactly one entry — the current v1 shape. The
 *  pattern is here from day one so adding a v0-recognizer or a future
 *  v2-recognizer is one new entry and zero structural change. See
 *  PwrAgnt's docs/config-file-evolution.md. */
type ShapeEntry = {
  shape: string;
  parse(
    raw: unknown,
    appVersion: string,
    shortcutPlatform: ShortcutPlatform
  ): Settings | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickStringOrNull(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return fallback;
}

function pickMode(value: unknown): "auto" | "pinned" {
  return value === "pinned" ? "pinned" : "auto";
}

function pickAppearanceTheme(value: unknown, fallback: AppearanceTheme): AppearanceTheme {
  return isAppearanceTheme(value) ? value : fallback;
}

function pickFilenameTimestampZone(
  value: unknown,
  fallback: FilenameTimestampZone
): FilenameTimestampZone {
  return value === "utc" || value === "local" ? value : fallback;
}

function pickCapturesLocation(
  value: unknown,
  fallback: CapturesLocation
): CapturesLocation {
  return value === "documents" || value === "home" ? value : fallback;
}

function pickQuickCaptureAction(
  value: unknown,
  fallback: QuickCaptureAction
): QuickCaptureAction {
  return isQuickCaptureAction(value) ? value : fallback;
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pickHotCpuProfileStartDelayMs(
  value: unknown,
  fallback: HotCpuProfileStartDelayMs
): HotCpuProfileStartDelayMs {
  return typeof value === "number" && isHotCpuProfileStartDelayMs(value)
    ? value
    : fallback;
}

function pickHotCpuProfileTriggerMode(
  value: unknown,
  fallback: HotCpuProfileTriggerMode
): HotCpuProfileTriggerMode {
  return typeof value === "string" && isHotCpuProfileTriggerMode(value)
    ? value
    : fallback;
}

function pickHotCpuHeapSnapshotLimit(value: unknown, fallback: number): number {
  const picked = pickNumber(value, fallback);
  return Math.min(Math.max(Math.round(picked), 1), 3);
}

function pickPercent(value: unknown, fallback: number): number {
  const picked = pickNumber(value, fallback);
  return Math.min(Math.max(picked, 1), 100);
}

// ---- Editor settings picks (Phase 1) ----------------------------------

function pickToolColor(value: unknown, fallback: ToolColor): ToolColor {
  if (isColorToken(value)) return value;
  if (typeof value === "string") return value;
  return fallback;
}

function pickToolSizePreset(value: unknown, fallback: ToolSizePreset | number): ToolSizePreset | number {
  if (
    value === "auto" ||
    value === "small" ||
    value === "medium" ||
    value === "large" ||
    value === "x-large"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function pickArrowEndStyle(value: unknown, fallback: ArrowEndStyle): ArrowEndStyle {
  if (value === "filled-triangle" || value === "open-triangle" || value === "line" || value === "dot") return value;
  return fallback;
}

function pickArrowStemStyle(value: unknown, fallback: ArrowStemStyle): ArrowStemStyle {
  if (value === "solid" || value === "dashed" || value === "dotted") return value;
  return fallback;
}

function pickTextFontWeight(value: unknown, fallback: TextFontWeight): TextFontWeight {
  if (value === "regular" || value === "bold") return value;
  return fallback;
}

function pickOverlayOutlineMode(
  value: unknown,
  fallback: OverlayOutlineMode
): OverlayOutlineMode {
  return isOverlayOutlineMode(value) ? value : fallback;
}

function pickBlurEffectMode(value: unknown, fallback: BlurEffectMode): BlurEffectMode {
  if (value === "gaussian" || value === "pixelate" || value === "redact") return value;
  return fallback;
}

function pickBlurRadiusSetting(value: unknown, fallback: BlurRadiusSetting): BlurRadiusSetting {
  if (!isRecord(value)) return fallback;
  if (value.mode === "auto") return { mode: "auto" };
  if (value.mode === "px" && typeof value.value === "number" && Number.isFinite(value.value) && value.value > 0) {
    return { mode: "px", value: value.value };
  }
  return fallback;
}

function pickHighlightBlendMode(value: unknown, fallback: HighlightBlendMode): HighlightBlendMode {
  if (value === "multiply" || value === "screen" || value === "overlay") return value;
  return fallback;
}

function pickEditorSidebarPanel(value: unknown, fallback: EditorSidebarPanel): EditorSidebarPanel {
  return isEditorSidebarPanel(value) ? value : fallback;
}

function parseArrowToolStyle(raw: unknown, defaults: ArrowToolStyle): ArrowToolStyle {
  if (!isRecord(raw)) return defaults;
  return {
    color: pickToolColor(raw.color, defaults.color),
    thickness: pickToolSizePreset(raw.thickness, defaults.thickness),
    endStyle: pickArrowEndStyle(raw.endStyle, defaults.endStyle),
    stemStyle: pickArrowStemStyle(raw.stemStyle, defaults.stemStyle),
    doubleEnded: pickBoolean(raw.doubleEnded, defaults.doubleEnded),
    outline: pickOverlayOutlineMode(raw.outline, defaults.outline)
  };
}

function parseTextToolStyle(raw: unknown, defaults: TextToolStyle): TextToolStyle {
  if (!isRecord(raw)) return defaults;
  return {
    color: pickToolColor(raw.color, defaults.color),
    fontSize: pickToolSizePreset(raw.fontSize, defaults.fontSize),
    weight: pickTextFontWeight(raw.weight, defaults.weight),
    // Stripe is not offered for text (the picker hides it); a stored
    // stripe (older file / out-of-band write) parses back to the
    // default so the Border row always shows a selectable state.
    outline:
      raw.outline === "stripe"
        ? defaults.outline
        : pickOverlayOutlineMode(raw.outline, defaults.outline)
  };
}

function pickShapeKind(value: unknown, fallback: ShapeKind): ShapeKind {
  if (
    value === "rect" ||
    value === "square" ||
    value === "circle" ||
    value === "oval" ||
    value === "parallelogram"
  ) {
    return value;
  }
  return fallback;
}

function pickFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseShapeToolStyle(raw: unknown, defaults: ShapeToolStyle): ShapeToolStyle {
  if (!isRecord(raw)) return defaults;
  return {
    color: pickToolColor(raw.color, defaults.color),
    thickness: pickToolSizePreset(raw.thickness, defaults.thickness),
    filled: pickBoolean(raw.filled, defaults.filled),
    shape: pickShapeKind(raw.shape, defaults.shape),
    skewDeg: pickFiniteNumber(raw.skewDeg, defaults.skewDeg),
    outline: pickOverlayOutlineMode(raw.outline, defaults.outline)
  };
}

function parseBlurToolStyle(raw: unknown, defaults: BlurToolStyle): BlurToolStyle {
  if (!isRecord(raw)) return defaults;
  return {
    mode: pickBlurEffectMode(raw.mode, defaults.mode),
    radius: pickBlurRadiusSetting(raw.radius, defaults.radius)
  };
}

function parseHighlightToolStyle(raw: unknown, defaults: HighlightToolStyle): HighlightToolStyle {
  if (!isRecord(raw)) return defaults;
  // Clamp opacity to the marker range so a stale/corrupt setting
  // can't render a fully-opaque highlight that hides the image.
  const opacityRaw = pickNumber(raw.opacity, defaults.opacity);
  const opacity = Math.min(MAX_HIGHLIGHT_OPACITY, Math.max(0, opacityRaw));
  return {
    color: pickToolColor(raw.color, defaults.color),
    opacity,
    blend: pickHighlightBlendMode(raw.blend, defaults.blend)
  };
}

function parseEditorToolStyles(raw: unknown, defaults: EditorToolStyles): EditorToolStyles {
  if (!isRecord(raw)) return defaults;
  // Legacy fallback: pre-Shape rename, the tool block was keyed
  // `toolStyles.rect` (carrying ShapeToolStyle minus the shape / skewDeg
  // fields). Read `shape` first and fall back to `rect` so an older
  // settings.json keeps the user's color/thickness/filled picks across
  // the rename. Either source flows through parseShapeToolStyle, which
  // fills in the new `shape`/`skewDeg` fields from defaults when absent.
  const shapeRaw = raw.shape ?? raw.rect;
  return {
    arrow: parseArrowToolStyle(raw.arrow, defaults.arrow),
    text: parseTextToolStyle(raw.text, defaults.text),
    shape: parseShapeToolStyle(shapeRaw, defaults.shape),
    blur: parseBlurToolStyle(raw.blur, defaults.blur),
    highlight: parseHighlightToolStyle(raw.highlight, defaults.highlight)
  };
}

function parseEditorCoachmarks(raw: unknown, defaults: EditorCoachmarks): EditorCoachmarks {
  if (!isRecord(raw)) return defaults;
  return {
    stoplightSeen: pickBoolean(raw.stoplightSeen, defaults.stoplightSeen)
  };
}

function parseEditorMatchingText(raw: unknown, defaults: EditorMatchingText): EditorMatchingText {
  if (!isRecord(raw)) return defaults;
  return {
    enabled: pickBoolean(raw.enabled, defaults.enabled)
  };
}

function parseEditorSidebar(raw: unknown, defaults: EditorSidebarSettings): EditorSidebarSettings {
  if (!isRecord(raw)) return defaults;
  return {
    pinned: pickBoolean(raw.pinned, defaults.pinned),
    lastSelectedPanel: pickEditorSidebarPanel(raw.lastSelectedPanel, defaults.lastSelectedPanel)
  };
}

function parseEditorSettings(raw: unknown, defaults: EditorSettings): EditorSettings {
  if (!isRecord(raw)) return defaults;
  return {
    toolStyles: parseEditorToolStyles(raw.toolStyles, defaults.toolStyles),
    coachmarks: parseEditorCoachmarks(raw.coachmarks, defaults.coachmarks),
    matchingText: parseEditorMatchingText(raw.matchingText, defaults.matchingText),
    sidebar: parseEditorSidebar(raw.sidebar, defaults.sidebar)
  };
}

/** beta.26 stops materializing PwrSnap's managed enrichment default in user
 *  settings. Clear the exact historical GPT-5.4 Mini/Low shape back to `{}` so
 *  subsequent managed-default changes carry the user forward automatically. */
function migrateEnrichmentDefaultToManagedLuna(defaults: AiSurfaceDefaults): AiSurfaceDefaults {
  const enrichment = defaults.enrichment;
  const hasHistoricalEffort =
    enrichment.reasoning === undefined ||
    enrichment.reasoning === DEFAULT_ENRICHMENT_REASONING_EFFORT;
  const isMaterializedHistoricalDefault =
    enrichment.model === LEGACY_ENRICHMENT_DEFAULT_MODEL;

  if (
    enrichment.provider !== undefined ||
    !hasHistoricalEffort ||
    !isMaterializedHistoricalDefault
  ) {
    return defaults;
  }
  return {
    ...defaults,
    enrichment: {}
  };
}

/** The pair every pre-`selectionSource` settings file landed on when
 *  nobody had chosen: the shape `defaultSettings()` shipped at the time,
 *  and what the old `parseUpdates` filled a missing `train` with. This is
 *  a HISTORICAL FACT about files already on disk, so it is frozen here
 *  rather than read from `UPDATE_*_DEFAULT` — moving the shipped default
 *  later must not retroactively reclassify those files as deliberate
 *  pins and freeze that population on Stable Latest forever. */
const LEGACY_UNCHOSEN_UPDATE_PAIR: { channel: UpdateChannel; train: UpdateTrain } = {
  channel: "latest",
  train: "stable"
};

/** Classify a settings file written before `updates.selectionSource`
 *  existed. A complete pair that is NOT the historical unchosen pair
 *  could only have been written by a deliberate click or by the old
 *  version-seeding path, and both mean "leave it alone" — so it reads as
 *  `"user"`. Everything else (no pair, a half pair, or that pair) is
 *  indistinguishable from "never chose", so it reads as `"inferred"` and
 *  gets re-derived from the running binary.
 *
 *  The one behavior change this migration can produce: an operator who
 *  deliberately pinned Stable/Latest while running an alpha is moved back
 *  onto Beta/Prerelease once. That is the same state as the bug it fixes —
 *  an alpha build being offered v1.0.3 and never told about the newer
 *  alpha — and there is no signal on disk that separates the two. Their
 *  next click writes `"user"` and pins for good. */
function legacyUpdateSelectionSource(
  channel: UpdateChannel | undefined,
  train: UpdateTrain | undefined
): UpdateSelectionSource {
  if (channel === undefined || train === undefined) return "inferred";
  if (
    channel === LEGACY_UNCHOSEN_UPDATE_PAIR.channel &&
    train === LEGACY_UNCHOSEN_UPDATE_PAIR.train
  ) {
    return "inferred";
  }
  return "user";
}

function parseUpdates(
  raw: unknown,
  appVersion: string,
  defaults: Settings["updates"]
): Settings["updates"] {
  const updates = isRecord(raw) ? raw : {};
  const storedChannel = isUpdateChannel(updates.channel) ? updates.channel : undefined;
  const storedTrain = isUpdateTrain(updates.train) ? updates.train : undefined;
  const source = isUpdateSelectionSource(updates.selectionSource)
    ? updates.selectionSource
    : legacyUpdateSelectionSource(storedChannel, storedTrain);
  // A pin is honoured even when one axis did not survive the round trip
  // (a truncated write, a hand edit that misspelled a value). Re-inferring
  // the whole pair there would silently discard the axis that IS valid and
  // un-pin the selection — on an alpha binary that quietly moves a
  // deliberate Stable pin onto the alpha feed. Fall back per axis instead.
  if (source === "user") {
    return {
      channel: storedChannel ?? defaults.channel,
      train: storedTrain ?? defaults.train,
      selectionSource: "user"
    };
  }
  // An inferred selection is RE-DERIVED on every hydration from the
  // version of the binary doing the reading, so installing an alpha over a
  // stable build (or the reverse) moves the feed with it instead of
  // stranding the install on a slot it can never advance from.
  return { ...inferUpdateSelection(appVersion), selectionSource: "inferred" };
}

function parseV1(
  raw: unknown,
  appVersion = "",
  shortcutPlatform: ShortcutPlatform = shortcutPlatformFromString(process.platform)
): Settings | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== 1) return null;
  const defaults = defaultSettings(shortcutPlatform);
  const codex = isRecord(raw.codex) ? raw.codex : {};
  const ai = isRecord(raw.ai) ? raw.ai : {};
  const hotkeys = isRecord(raw.hotkeys) ? raw.hotkeys : {};
  const general = isRecord(raw.general) ? raw.general : {};
  const experimental = isRecord(raw.experimental) ? raw.experimental : {};
  const appearance = isRecord(raw.appearance) ? raw.appearance : {};
  const updates = isRecord(raw.updates) ? raw.updates : {};
  const storage = isRecord(raw.storage) ? raw.storage : {};
  const recording = isRecord(raw.recording) ? raw.recording : {};
  const localAgents = parseLocalAgentsSettings(raw.localAgents, defaults.localAgents);
  if (localAgents === null) return null;
  const storedDefaultsMigrationVersion =
    typeof raw.lastDefaultsMigrationVersion === "string" &&
    raw.lastDefaultsMigrationVersion.trim().length > 0
      ? raw.lastDefaultsMigrationVersion.trim()
      : undefined;
  const storedCaptionModel = isCodexCaptionModel(codex.captionModel)
    ? codex.captionModel
    : defaults.codex.captionModel;
  let aiSurfaceDefaults = parseAiSurfaceDefaults(ai.defaults);
  let parsedHotkeys: Settings["hotkeys"] = {
    quickCapture: pickString(hotkeys.quickCapture, defaults.hotkeys.quickCapture),
    region: pickString(hotkeys.region, defaults.hotkeys.region),
    window: pickString(hotkeys.window, defaults.hotkeys.window),
    fullScreen: pickString(hotkeys.fullScreen, defaults.hotkeys.fullScreen),
    allScreens: pickString(hotkeys.allScreens, defaults.hotkeys.allScreens),
    timed: pickString(hotkeys.timed, defaults.hotkeys.timed),
    videoCapture: pickString(hotkeys.videoCapture, defaults.hotkeys.videoCapture),
    reshowFloatOver: pickString(
      hotkeys.reshowFloatOver,
      defaults.hotkeys.reshowFloatOver
    )
  };
  const storedDefaultsMigrationIndex =
    storedDefaultsMigrationVersion === undefined
      ? -1
      : DEFAULTS_MIGRATION_VERSIONS.indexOf(storedDefaultsMigrationVersion);
  const recognizesDefaultsMigrationVersion =
    storedDefaultsMigrationVersion === undefined || storedDefaultsMigrationIndex >= 0;
  if (recognizesDefaultsMigrationVersion) {
    for (
      let index = storedDefaultsMigrationIndex + 1;
      index < DEFAULTS_MIGRATION_VERSIONS.length;
      index += 1
    ) {
      const version = DEFAULTS_MIGRATION_VERSIONS[index];
      if (version === "1.0.0-beta.26") {
        aiSurfaceDefaults = migrateEnrichmentDefaultToManagedLuna(aiSurfaceDefaults);
      }
      if (version === "1.1.0-alpha.5" && shortcutPlatform !== "darwin") {
        const platformDefaults = defaultHotkeysForPlatform(shortcutPlatform);
        parsedHotkeys = {
          ...parsedHotkeys,
          videoCapture: acceleratorsAreEquivalent(
            parsedHotkeys.videoCapture,
            DEFAULT_HOTKEYS.videoCapture,
            shortcutPlatform
          )
            ? platformDefaults.videoCapture
            : parsedHotkeys.videoCapture,
          reshowFloatOver: acceleratorsAreEquivalent(
            parsedHotkeys.reshowFloatOver,
            DEFAULT_HOTKEYS.reshowFloatOver,
            shortcutPlatform
          )
            ? platformDefaults.reshowFloatOver
            : parsedHotkeys.reshowFloatOver
        };
      }
    }
  }
  return {
    schemaVersion: 1,
    lastDefaultsMigrationVersion: recognizesDefaultsMigrationVersion
      ? CURRENT_DEFAULTS_MIGRATION_VERSION
      : storedDefaultsMigrationVersion,
    codex: {
      mode: pickMode(codex.mode ?? defaults.codex.mode),
      pinnedPath: pickString(codex.pinnedPath, defaults.codex.pinnedPath),
      profile: pickString(codex.profile, defaults.codex.profile),
      // `captionModel` landed after v1 shipped; older files won't have
      // it. Codex model availability is account/build dependent, so keep
      // valid model-id strings instead of pinning this parser to a stale
      // hardcoded allowlist.
      captionModel: storedCaptionModel
    },
    ai: {
      enabled: pickBoolean(ai.enabled, defaults.ai.enabled),
      consentAcceptedAt: pickStringOrNull(ai.consentAcceptedAt, defaults.ai.consentAcceptedAt),
      budgetSafetyDisabledAt: pickStringOrNull(
        ai.budgetSafetyDisabledAt,
        defaults.ai.budgetSafetyDisabledAt
      ),
      autoAcceptSuggestions: pickBoolean(
        ai.autoAcceptSuggestions,
        defaults.ai.autoAcceptSuggestions
      ),
      // `ai.chat.*` landed in the Library Chat plan (Phase 0). Older
      // files won't have it; parseChatSettings falls through to
      // DEFAULT_CHAT_SETTINGS for any missing nested field so the
      // in-memory shape is always complete and the next write rewrites
      // with the full block. No `schemaVersion` bump per the additive
      // convention (see AGENTS.md "Settings substrate").
      chat: parseChatSettings(ai.chat, defaults.ai.chat),
      // `ai.defaults.*` is additive — older files won't have it. Missing
      // surface fields stay empty (= follow the managed default); the legacy
      // `codex.captionModel` is intentionally ignored. The defaults migration
      // above clears only the exact materialized historical Mini/Low default.
      // Explicit provider/model/effort choices are preserved.
      // No `schemaVersion` bump per the additive convention.
      defaults: aiSurfaceDefaults,
      // `ai.acp.*` is additive — older files won't have it. Falls through
      // to an empty enabled set; only recognized built-in agent ids
      // survive the parse so a stale/forged file can't enable an unknown
      // agent. No `schemaVersion` bump per the additive convention.
      acp: parseAcpSettings(ai.acp)
    },
    // Missing fields use the current platform defaults. The managed-default
    // ledger above migrates only physical matches for historical defaults,
    // preserving every genuinely customized chord.
    hotkeys: parsedHotkeys,
    general: {
      // `general.developerMode` and `general.launchAtLogin` landed
      // after v1 shipped; older files won't have them. pickBoolean
      // fills in the default (false) so the fields are always present
      // in-memory.
      developerMode: pickBoolean(general.developerMode, defaults.general.developerMode),
      hotCpuProfilingEnabled: pickBoolean(
        general.hotCpuProfilingEnabled,
        defaults.general.hotCpuProfilingEnabled
      ),
      hotCpuProfilingStartDelayMs: pickHotCpuProfileStartDelayMs(
        general.hotCpuProfilingStartDelayMs,
        defaults.general.hotCpuProfilingStartDelayMs
      ),
      hotCpuProfilingTriggerMode: pickHotCpuProfileTriggerMode(
        general.hotCpuProfilingTriggerMode,
        defaults.general.hotCpuProfilingTriggerMode
      ),
      hotCpuProfilingSlowburnThresholdPercent: pickPercent(
        general.hotCpuProfilingSlowburnThresholdPercent,
        defaults.general.hotCpuProfilingSlowburnThresholdPercent
      ),
      hotCpuProfilingCaptureHeapSnapshot: pickBoolean(
        general.hotCpuProfilingCaptureHeapSnapshot,
        defaults.general.hotCpuProfilingCaptureHeapSnapshot
      ),
      hotCpuProfilingHeapSnapshotLimit: pickHotCpuHeapSnapshotLimit(
        general.hotCpuProfilingHeapSnapshotLimit,
        defaults.general.hotCpuProfilingHeapSnapshotLimit
      ),
      launchAtLogin: pickBoolean(general.launchAtLogin, defaults.general.launchAtLogin)
    },
    experimental: {
      // `experimental.*` is additive — older files won't have these.
      // pickBoolean fills the defaults (processSplit + dpiAwareExport OFF,
      // allowRetinaExport ON) so the fields are always present in-memory.
      // No `schemaVersion` bump per the additive convention.
      processSplit: pickBoolean(experimental.processSplit, defaults.experimental.processSplit),
      dpiAwareExport: pickBoolean(
        experimental.dpiAwareExport,
        defaults.experimental.dpiAwareExport
      ),
      allowRetinaExport: pickBoolean(
        experimental.allowRetinaExport,
        defaults.experimental.allowRetinaExport
      )
    },
    appearance: {
      // `appearance` landed after v1 shipped; older files won't have
      // it. pickAppearanceTheme returns the default ("system") for
      // missing or invalid input so the field is always present
      // in-memory and the next write rewrites the file with the full
      // shape.
      theme: pickAppearanceTheme(appearance.theme, defaults.appearance.theme)
    },
    updates: parseUpdates(updates, appVersion, defaults.updates),
    storage: {
      // `storage.filenameTimestampZone` landed after v1 shipped;
      // older files default to local time so filenames match what
      // users remember from their wall clock.
      filenameTimestampZone: pickFilenameTimestampZone(
        storage.filenameTimestampZone,
        defaults.storage.filenameTimestampZone
      ),
      // Additive v1 field: older settings files keep the historical
      // Documents default; only an explicit successful fallback writes home.
      capturesLocation: pickCapturesLocation(
        storage.capturesLocation,
        defaults.storage.capturesLocation
      )
    },
    recording: {
      // `recording.*` landed after v1 shipped; older files won't have
      // it. Defaults to audio OFF + an empty fingerprint so the
      // startup permission routing fires once after the first launch
      // on the new build.
      //
      // `quickCaptureAction` is additive on top of that (no schemaVersion
      // bump): an older file has no value, so it takes the `ask` default
      // and existing installs gain the Record affordance without losing
      // ↵-to-snap.
      quickCaptureAction: pickQuickCaptureAction(
        recording.quickCaptureAction,
        defaults.recording.quickCaptureAction
      ),
      includeSystemAudio: pickBoolean(recording.includeSystemAudio, defaults.recording.includeSystemAudio),
      includeMicrophone: pickBoolean(recording.includeMicrophone, defaults.recording.includeMicrophone),
      // `videoCaptureCursor` / `imageCaptureCursor` landed with the
      // cursor-capture-control feature; older files won't have them.
      // pickBoolean fills the ON default so existing installs keep the
      // pre-setting behavior (video bakes in the cursor).
      videoCaptureCursor: pickBoolean(recording.videoCaptureCursor, defaults.recording.videoCaptureCursor),
      imageCaptureCursor: pickBoolean(recording.imageCaptureCursor, defaults.recording.imageCaptureCursor),
      lastRoutedPermissionFingerprint: pickString(
        recording.lastRoutedPermissionFingerprint,
        defaults.recording.lastRoutedPermissionFingerprint
      ),
      // `screenCapturePrompted` landed with the first-run permission fix;
      // older files won't have it. Default false so existing installs
      // re-run the honest first-run prompt path once (harmless if screen
      // is already granted — the gate short-circuits before prompting).
      screenCapturePrompted: pickBoolean(
        recording.screenCapturePrompted,
        defaults.recording.screenCapturePrompted
      )
    },
    // `editor.*` landed in the v2-editor refresh. Older files won't
    // have it; parseEditorSettings falls through
    // to defaults for any missing nested field so the in-memory shape
    // is always complete and the next write rewrites the file with the
    // full block. No `schemaVersion` bump per the additive convention.
    editor: parseEditorSettings(raw.editor, defaults.editor),
    // `library.*` is additive too — older files won't have it. Falls
    // through to defaultLibrarySettings() (pinned + Info) when missing.
    library: parseLibrarySettings(raw.library, defaults.library),
    // `localAgents.*` is security and audit state. A malformed entry
    // invalidates the settings shape so read() quarantines the complete
    // source file instead of silently erasing grant or audit history.
    localAgents
  };
}

/** Parse a single sensitive-data-pattern row from an on-disk JSON
 *  value. Rejects anything that isn't `{name: string, pattern: string}`;
 *  trims fields; caps lengths defensively (the bus validator also
 *  rejects oversize input, but the on-disk path could see corruption
 *  or an old format we never shipped). Returns `null` for rejection. */
function parsePatternRow(raw: unknown): SensitiveDataPattern | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const pattern = typeof raw.pattern === "string" ? raw.pattern.trim() : "";
  if (name.length === 0 || name.length > 64) return null;
  if (pattern.length === 0 || pattern.length > 512) return null;
  return { name, pattern };
}

/** Parse `Settings.ai.chat` from an on-disk JSON value. Falls through
 *  to defaults for any missing / corrupt field; dedupes patterns by
 *  case-sensitive `name` keeping first-seen; caps the array at 32. */
function parseChatSettings(raw: unknown, defaults: ChatSettings): ChatSettings {
  if (!isRecord(raw)) return { ...defaults, sensitiveDataPatterns: [...defaults.sensitiveDataPatterns] };
  const patternsRaw = Array.isArray(raw.sensitiveDataPatterns) ? raw.sensitiveDataPatterns : [];
  const seen = new Set<string>();
  const patterns: SensitiveDataPattern[] = [];
  for (const entry of patternsRaw) {
    if (patterns.length >= 32) break;
    const row = parsePatternRow(entry);
    if (row === null) continue;
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    patterns.push(row);
  }
  return {
    userGuidance: pickString(raw.userGuidance, defaults.userGuidance),
    sensitiveDataPatterns: patterns,
    defaultRedactionStyle: isRedactionStyle(raw.defaultRedactionStyle)
      ? raw.defaultRedactionStyle
      : defaults.defaultRedactionStyle,
    firstLaunchBannerDismissed: pickBoolean(
      raw.firstLaunchBannerDismissed,
      defaults.firstLaunchBannerDismissed
    )
  };
}

/** Parse one `ai.defaults.<surface>` object. Only keeps a leaf when it's
 *  a non-empty string (provider / model) or a recognized reasoning value;
 *  everything else is dropped so the in-memory shape omits the field
 *  entirely (= "use the managed default"). */
function parseAiSurfaceDefault(raw: unknown): AiSurfaceDefault {
  const out: AiSurfaceDefault = {};
  const rec = isRecord(raw) ? raw : {};
  if (typeof rec.provider === "string") {
    // `provider` is a BACKEND selector for every surface now: "codex" or
    // "acp:<known-id>". Keep only valid selectors; a legacy free-text Codex
    // modelProvider token (e.g. "openai" on the old enrichment surface) is
    // dropped → Codex default. "" / "codex" also drop to the implicit default.
    const provider = rec.provider.trim();
    if (provider.startsWith("acp:") && isBuiltInAcpAgentId(provider.slice("acp:".length))) {
      out.provider = provider;
    }
  }
  if (typeof rec.model === "string" && rec.model.trim().length > 0) {
    out.model = rec.model.trim();
  }
  if (isAiReasoningEffort(rec.reasoning)) {
    out.reasoning = rec.reasoning;
  }
  return out;
}

/** Parse `ai.defaults` from an on-disk JSON value. Each surface falls
 *  through to an empty object when missing. */
function parseAiSurfaceDefaults(raw: unknown): AiSurfaceDefaults {
  const rec = isRecord(raw) ? raw : {};
  return {
    libraryChat: parseAiSurfaceDefault(rec.libraryChat),
    sizzleChat: parseAiSurfaceDefault(rec.sizzleChat),
    enrichment: parseAiSurfaceDefault(rec.enrichment)
  };
}

/** Parse `ai.acp` from an on-disk JSON value. Keeps only recognized
 *  built-in agent ids (de-duplicated, order preserved) so a stale or
 *  forged file can't enable an unknown agent. Missing / malformed input
 *  falls through to an empty enabled set. */
function parseAcpSettings(raw: unknown): AcpSettings {
  if (!isRecord(raw) || !Array.isArray(raw.enabledAgentIds)) {
    return { enabledAgentIds: [], agents: {} };
  }
  const seen = new Set<string>();
  const enabledAgentIds: string[] = [];
  for (const entry of raw.enabledAgentIds) {
    if (!isBuiltInAcpAgentId(entry)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    enabledAgentIds.push(entry);
  }
  return { enabledAgentIds, agents: parseAcpAgentPreferences(raw.agents) };
}

/** Parse `ai.acp.agents` — a per-agent path-preference map. Keeps only
 *  recognized built-in agent ids and only string `overridePath` / `selectedPath`
 *  values; anything else is dropped so a forged file can't smuggle in arbitrary
 *  keys/shapes. */
function parseAcpAgentPreferences(
  raw: unknown
): Record<string, AcpAgentPreference> {
  if (!isRecord(raw)) return {};
  const agents: Record<string, AcpAgentPreference> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isBuiltInAcpAgentId(id) || !isRecord(value)) continue;
    const pref: AcpAgentPreference = {};
    if (typeof value.overridePath === "string" && value.overridePath.length > 0) {
      pref.overridePath = value.overridePath;
    }
    if (typeof value.selectedPath === "string" && value.selectedPath.length > 0) {
      pref.selectedPath = value.selectedPath;
    }
    if (pref.overridePath !== undefined || pref.selectedPath !== undefined) {
      agents[id] = pref;
    }
  }
  return agents;
}

function parseLibrarySettings(
  raw: unknown,
  defaults: Settings["library"]
): Settings["library"] {
  if (!isRecord(raw)) return defaults;
  // confirmBeforeTrash is parsed independently of detailRail so a file
  // that's missing or has a malformed detailRail still keeps the user's
  // delete-confirmation choice (and vice versa).
  const confirmBeforeTrash = pickBoolean(
    raw.confirmBeforeTrash,
    defaults.confirmBeforeTrash
  );
  // gridZoom is additive (older files won't have it) and parsed
  // independently of detailRail. Clamp to the valid band; out-of-range
  // or non-numeric values fall back to the default. Renderers snap the
  // clamped value to the nearest GRID_ZOOM_LEVELS entry, so we don't
  // force-snap here — any in-band number round-trips.
  const gridZoom = clampGridZoom(pickNumber(raw.gridZoom, defaults.gridZoom));
  // gridCopyPalette is additive too (older files won't have it) and is
  // parsed independently of detailRail for the same reason.
  const gridCopyPalette = parseGridCopyPaletteSettings(
    raw.gridCopyPalette,
    defaults.gridCopyPalette
  );
  const detailRaw = raw.detailRail;
  if (!isRecord(detailRaw)) {
    return {
      detailRail: defaults.detailRail,
      gridCopyPalette,
      confirmBeforeTrash,
      gridZoom
    };
  }
  // Route the on-disk tab value through the shared type guard so the
  // accepted set has a single source of truth (the protocol's
  // LIBRARY_SIDEBAR_TABS array). A new tab id only has to be added in
  // one place to round-trip through settings.
  const pickedTab: LibrarySidebarTab = isLibrarySidebarTab(
    detailRaw.lastSelectedTab
  )
    ? detailRaw.lastSelectedTab
    : defaults.detailRail.lastSelectedTab;
  return {
    detailRail: {
      pinned: pickBoolean(detailRaw.pinned, defaults.detailRail.pinned),
      lastSelectedTab: pickedTab
    },
    gridCopyPalette,
    confirmBeforeTrash,
    gridZoom
  };
}

/** Parse the persisted Grid copy-palette prefs. Unknown/garbage anchor
 *  values fall back to the default (`follow`) rather than quarantining
 *  the whole file — this is a cosmetic placement preference. */
function parseGridCopyPaletteSettings(
  raw: unknown,
  defaults: Settings["library"]["gridCopyPalette"]
): Settings["library"]["gridCopyPalette"] {
  if (!isRecord(raw)) return defaults;
  return {
    anchor: isGridCopyPaletteAnchor(raw.anchor) ? raw.anchor : defaults.anchor
  };
}

/** Clamp a grid-zoom px value to the valid [MIN, MAX] band. NaN /
 *  non-finite inputs are handled upstream by pickNumber. */
function clampGridZoom(value: number): number {
  return Math.min(GRID_ZOOM_MAX, Math.max(GRID_ZOOM_MIN, value));
}

function parseLocalAgentsSettings(
  raw: unknown,
  defaults: Settings["localAgents"]
): Settings["localAgents"] | null {
  if (raw === undefined) return defaults;
  if (!isRecord(raw)) return null;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return null;
  if (raw.grants !== undefined && !Array.isArray(raw.grants)) return null;
  if (raw.roles !== undefined && !Array.isArray(raw.roles)) return null;
  if (raw.audit !== undefined && !Array.isArray(raw.audit)) return null;
  const rolesRaw = raw.roles ?? defaults.roles;
  if (rolesRaw.length > 100) return null;
  const roleIds = new Set<string>();
  const roles: LocalAgentRoleProfile[] = [];
  for (const roleRaw of rolesRaw) {
    const role = parseLocalAgentRole(roleRaw);
    if (role === null || roleIds.has(role.id)) return null;
    roleIds.add(role.id);
    roles.push(role);
  }
  const grantsRaw = raw.grants ?? [];
  const seen = new Set<string>();
  const grants: LocalAgentClientGrant[] = [];
  for (const grantRaw of grantsRaw) {
    const grant = parseLocalAgentGrant(grantRaw);
    if (grant === null || seen.has(grant.id)) return null;
    seen.add(grant.id);
    let roleId = grant.roleId;
    if (roleId === undefined) {
      let role = findRoleForCapabilities(roles, grant.capabilities);
      if (role === undefined) {
        role = {
          id: `migrated.${grants.length + 1}`,
          name: `${grant.name} Access`.slice(0, 200),
          description: "Migrated from a pre-RBAC local-agent capability grant.",
          builtIn: false,
          permissions: [...grant.capabilities],
          ...defaultLocalAgentRoleConstraints(grant.capabilities)
        };
        while (roleIds.has(role.id)) {
          role.id = `${role.id}.next`;
        }
        roleIds.add(role.id);
        roles.push(role);
      }
      roleId = role.id;
    }
    grants.push({ ...grant, roleId });
  }
  const auditRaw = raw.audit ?? [];
  if (auditRaw.length > 500) return null;
  const audit: Settings["localAgents"]["audit"] = [];
  const auditIds = new Set<string>();
  for (const auditEntryRaw of auditRaw) {
    const entry = parseLocalAgentAuditEntry(auditEntryRaw);
    if (entry === null || auditIds.has(entry.id)) return null;
    auditIds.add(entry.id);
    audit.push(entry);
  }
  return {
    enabled: raw.enabled ?? defaults.enabled,
    grants,
    roles,
    audit
  };
}

function parseLocalAgentRole(raw: unknown): LocalAgentRoleProfile | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.description !== "string" ||
    typeof raw.builtIn !== "boolean" ||
    !Array.isArray(raw.permissions) ||
    raw.permissions.some((permission) => !isLocalAgentCapability(permission))
  ) {
    return null;
  }
  const role: LocalAgentRoleProfile = {
    id: raw.id.trim(),
    name: raw.name.trim(),
    description: raw.description,
    builtIn: raw.builtIn,
    permissions: parseLocalAgentCapabilities(raw.permissions),
    maxCaptureAgeDays: null,
    budgets: cloneLocalAgentBudgets(
      defaultLocalAgentRoleConstraints(
        parseLocalAgentCapabilities(raw.permissions)
      ).budgets
    )
  };
  const defaults = defaultLocalAgentRoleConstraints(role.permissions);
  if (raw.maxCaptureAgeDays === null) {
    role.maxCaptureAgeDays = null;
  } else if (raw.maxCaptureAgeDays === undefined) {
    role.maxCaptureAgeDays = defaults.maxCaptureAgeDays;
  } else if (
    typeof raw.maxCaptureAgeDays === "number" &&
    Number.isInteger(raw.maxCaptureAgeDays)
  ) {
    role.maxCaptureAgeDays = raw.maxCaptureAgeDays;
  } else {
    return null;
  }
  if (raw.budgets !== undefined) {
    const budgets = parseLocalAgentBudgets(raw.budgets);
    if (budgets === null) return null;
    role.budgets = budgets;
  }
  return isValidRole(role) ? role : null;
}

function parseLocalAgentBudgets(raw: unknown): LocalAgentRoleBudgets | null {
  if (!isRecord(raw)) return null;
  const parseBudget = (value: unknown): { limit: number; windowSeconds: number } | null => {
    if (
      !isRecord(value) ||
      typeof value.limit !== "number" ||
      typeof value.windowSeconds !== "number"
    ) return null;
    return { limit: value.limit, windowSeconds: value.windowSeconds };
  };
  const search = parseBudget(raw.search);
  const preview = parseBudget(raw["preview.read"]);
  const original = parseBudget(raw["original.read"]);
  const edit = parseBudget(raw.edit);
  const deletion = parseBudget(raw.delete);
  if (
    search === null ||
    preview === null ||
    original === null ||
    edit === null ||
    deletion === null
  ) return null;
  return {
    search,
    "preview.read": preview,
    "original.read": original,
    edit,
    delete: deletion
  };
}

function cloneLocalAgentBudgets(value: LocalAgentRoleBudgets): LocalAgentRoleBudgets {
  return {
    search: { ...value.search },
    "preview.read": { ...value["preview.read"] },
    "original.read": { ...value["original.read"] },
    edit: { ...value.edit },
    delete: { ...value.delete }
  };
}

function parseLocalAgentAuditEntry(
  raw: unknown
): Settings["localAgents"]["audit"][number] | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.id !== "string" ||
    typeof raw.clientId !== "string" ||
    typeof raw.action !== "string" ||
    typeof raw.subjectId !== "string" ||
    typeof raw.occurredAt !== "string" ||
    !isLocalAgentCapability(raw.capability) ||
    (raw.subjectKind !== "capture" && raw.subjectKind !== "sizzle") ||
    (raw.outcome !== "success" && raw.outcome !== "failure")
  ) {
    return null;
  }
  const actions = new Set([
    "capture.original.read",
    "capture.export",
    "capture.edit",
    "trash.write",
    "sizzle.preview.read",
    "sizzle.full.read"
  ]);
  if (!actions.has(raw.action)) return null;
  const expectedCapability = raw.action as LocalAgentCapability;
  const expectedSubjectKind = raw.action.startsWith("sizzle.") ? "sizzle" : "capture";
  if (
    raw.capability !== expectedCapability ||
    raw.subjectKind !== expectedSubjectKind
  ) {
    return null;
  }
  return {
    id: raw.id.slice(0, 128),
    clientId: raw.clientId.slice(0, 128),
    action: raw.action as Settings["localAgents"]["audit"][number]["action"],
    capability: raw.capability,
    subjectKind: raw.subjectKind,
    subjectId: raw.subjectId.slice(0, 256),
    outcome: raw.outcome,
    occurredAt: raw.occurredAt
  };
}

function parseLocalAgentGrant(raw: unknown): LocalAgentClientGrant | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const roleId = typeof raw.roleId === "string" ? raw.roleId.trim() : undefined;
  if (id.length === 0 || id.length > 128) return null;
  if (name.length === 0 || name.length > 200) return null;
  if (
    !Array.isArray(raw.capabilities) ||
    raw.capabilities.some((capability) => !isLocalAgentCapability(capability))
  ) {
    return null;
  }
  const capabilities = parseLocalAgentCapabilities(raw.capabilities);
  if (capabilities.length === 0) return null;
  const createdAt = pickIsoishString(raw.createdAt);
  const updatedAt = pickIsoishString(raw.updatedAt);
  if (createdAt === null || updatedAt === null) return null;
  const lastUsedAt = pickIsoishStringOrNull(raw.lastUsedAt);
  const revokedAt = pickIsoishStringOrNull(raw.revokedAt);
  if (lastUsedAt === undefined || revokedAt === undefined) return null;
  const oauthClient = parseLocalAgentOAuthClient(raw.oauthClient);
  if (raw.oauthClient !== undefined && oauthClient === null) {
    return null;
  }
  return {
    id,
    name,
    ...(roleId !== undefined && roleId.length > 0 ? { roleId } : {}),
    capabilities,
    createdAt,
    updatedAt,
    lastUsedAt,
    revokedAt,
    ...(oauthClient !== null ? { oauthClient } : {})
  };
}

function parseLocalAgentOAuthClient(
  raw: unknown
): NonNullable<LocalAgentClientGrant["oauthClient"]> | null {
  if (!isRecord(raw)) return null;
  const clientId = typeof raw.clientId === "string" ? raw.clientId.trim() : "";
  const clientName = typeof raw.clientName === "string" ? raw.clientName.trim() : "";
  const registeredAt = typeof raw.registeredAt === "string" ? raw.registeredAt : "";
  if (
    clientId.length === 0 ||
    clientId.length > 128 ||
    clientName.length === 0 ||
    clientName.length > 200 ||
    registeredAt.length === 0 ||
    !Number.isFinite(Date.parse(registeredAt))
  ) {
    return null;
  }
  const redirectUris = parseBoundedStringArray(raw.redirectUris, 8, 2_048);
  const grantTypes = parseBoundedStringArray(raw.grantTypes, 8, 128);
  const responseTypes = parseBoundedStringArray(raw.responseTypes, 8, 128);
  if (
    redirectUris.length === 0 ||
    redirectUris.some((uri) => !URL.canParse(uri)) ||
    !grantTypes.includes("authorization_code") ||
    !responseTypes.includes("code")
  ) {
    return null;
  }
  return {
    clientId,
    clientName,
    redirectUris,
    clientUri: parseNullableBoundedString(raw.clientUri, 2_048),
    scope: parseNullableBoundedString(raw.scope, 2_048),
    grantTypes,
    responseTypes,
    softwareId: parseNullableBoundedString(raw.softwareId, 256),
    softwareVersion: parseNullableBoundedString(raw.softwareVersion, 128),
    registeredAt
  };
}

function parseBoundedStringArray(
  raw: unknown,
  maxItems: number,
  maxLength: number
): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0 && value.length <= maxLength
    )
    .slice(0, maxItems);
}

function parseNullableBoundedString(
  raw: unknown,
  maxLength: number
): string | null {
  return typeof raw === "string" && raw.length > 0 && raw.length <= maxLength
    ? raw
    : null;
}

function parseLocalAgentCapabilities(raw: unknown): LocalAgentCapability[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<LocalAgentCapability>();
  for (const value of raw) {
    if (!isLocalAgentCapability(value)) continue;
    seen.add(value);
  }
  return [...seen];
}

function pickIsoishString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pickIsoishStringOrNull(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const SHAPE_CATALOG: readonly ShapeEntry[] = [
  { shape: "v1", parse: parseV1 }
];

export class DesktopSettingsService {
  private readonly filePath: string;
  private readonly log: Logger;
  private readonly resolveAppVersion: () => string;
  private readonly shortcutPlatform: ShortcutPlatform;
  private readonly readTextFile: (filePath: string) => Promise<string>;

  /** Immutable current snapshot. It is process-local by design: split-mode
   *  processes each hydrate once, while settings writes remain agent-owned
   *  and renderer/main listeners receive the existing change broadcast. */
  private snapshot: Settings | null = null;

  /** Coalesces concurrent cold readers so startup consumers (storage,
   *  hotkeys, tray, updater, AI) never race into duplicate disk parses. */
  private hydrationInflight: Promise<Settings> | null = null;

  /** Serializes writes. Ordinary reads return the
   *  current immutable snapshot immediately; a mutation publishes its next
   *  snapshot only after the atomic file rename succeeds. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  private fileReadCount = 0;
  private atomicWriteCount = 0;

  constructor(config: DesktopSettingsServiceConfig) {
    this.filePath = config.filePath;
    this.log = config.logger ?? getMainLogger("pwrsnap:settings-service");
    this.shortcutPlatform =
      config.shortcutPlatform ?? shortcutPlatformFromString(process.platform);
    this.resolveAppVersion =
      config.resolveAppVersion ??
      (() => config.appVersion ?? "");
    this.readTextFile =
      config.readTextFile ??
      ((filePath) => readFile(filePath, "utf8"));
  }

  private currentAppVersion(): string {
    return this.resolveAppVersion();
  }

  private withInferredUpdates(settings: Settings): Settings {
    return {
      ...settings,
      updates: {
        ...inferUpdateSelection(this.currentAppVersion()),
        selectionSource: UPDATE_SELECTION_SOURCE_DEFAULT
      }
    };
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** Synchronous access for callers that cannot await during object
   *  construction (notably BrowserWindow appearance seeding). Returns null
   *  only before this process's startup hydration has completed. */
  getCurrentSnapshot(): Settings | null {
    return this.snapshot;
  }

  readIoDiagnostics(): DesktopSettingsIoDiagnostics {
    return Object.freeze({
      fileReads: this.fileReadCount,
      atomicWrites: this.atomicWriteCount
    });
  }

  /** Adopt a trusted snapshot delivered by the owning process. Split-mode
   *  library uses this on the settings-changed bridge event so synchronous
   *  window/menu consumers stay current without reading the shared file.
   *  This never persists and never accepts renderer input directly. */
  adoptTrustedSnapshot(settings: Settings): Settings {
    const normalized = this.normalizeForSnapshot(settings);
    const current = this.replaceSnapshot(normalized);
    return current;
  }

  /**
   * Load + normalize settings.
   *
   * Returns defaults when the file is missing (first launch). On
   * corruption — JSON parse fail OR no shape in the catalog matches —
   * renames the bad file to `<name>.corrupt-<isoTimestamp>.json`,
   * logs at `warn`, returns defaults. We intentionally do NOT delete
   * the bad file: it's the user's prior config and a future tool may
   * be able to recover from it.
   */
  async read(): Promise<Settings> {
    if (this.snapshot !== null) return this.snapshot;
    if (this.hydrationInflight !== null) return this.hydrationInflight;

    const hydration = this.loadFromDisk();
    this.hydrationInflight = hydration;
    try {
      return await hydration;
    } finally {
      if (this.hydrationInflight === hydration) {
        this.hydrationInflight = null;
      }
    }
  }

  private async loadFromDisk(): Promise<Settings> {
    this.fileReadCount += 1;
    let raw: string;
    try {
      raw = await this.readTextFile(this.filePath);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") {
        return this.replaceSnapshot(
          this.withInferredUpdates(defaultSettings(this.shortcutPlatform))
        );
      }
      // A non-ENOENT failure does not prove the file is absent. Leave the
      // store unhydrated and reject so a later read can recover; critically,
      // write() also rejects before prepare/persistence instead of replacing a
      // valid-but-temporarily-unreadable file with defaults plus one patch.
      this.log.warn("settings-service: read failed, leaving store unhydrated", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      throw cause;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      await this.quarantine(`json_parse: ${cause instanceof Error ? cause.message : String(cause)}`);
      return this.replaceSnapshot(
        this.withInferredUpdates(defaultSettings(this.shortcutPlatform))
      );
    }

    for (const entry of SHAPE_CATALOG) {
      const normalized = entry.parse(
        parsed,
        this.currentAppVersion(),
        this.shortcutPlatform
      );
      if (normalized !== null) return this.replaceSnapshot(normalized);
    }

    await this.quarantine("no_shape_matched");
    return this.replaceSnapshot(
      this.withInferredUpdates(defaultSettings(this.shortcutPlatform))
    );
  }

  /**
   * Run an external-state operation under the same serialization baton as
   * settings writes. This is for mutations whose correctness depends on the
   * persisted settings snapshot (for example retrying one native global
   * shortcut): the operation cannot observe or alter staged state in the
   * middle of another write's prepare → atomic rename → commit sequence.
   *
   * The callback must not call `write()` on this service; doing so would try
   * to acquire the same non-reentrant queue from inside itself.
   */
  async withSerializedSettings<T>(
    operation: SerializedSettingsOperation<T>
  ): Promise<T> {
    return this.enqueue(async () => operation(await this.read()));
  }

  /**
   * Deep-merge `patch` into the current settings and persist atomically.
   *
   * Semantics for the patch:
   *   • `undefined` (or missing key) at any depth means "leave untouched".
   *   • A present value — including `""` (empty string), `null`, `false`,
   *     `0` — IS a write. (`codex.pinnedPath: ""` is how the renderer
   *     clears a pin.)
   *
   * Writes are serialized through a single promise chain so concurrent
   * `write` calls observe each other's results — the second write merges
   * onto the immutable snapshot committed by the first.
   *
   * Returns the merged response shape the caller can echo to renderers. The
   * internal snapshot is normalized independently, preserving the historical
   * contract where an explicit managed-default token can appear in the write
   * response even though a subsequent read omits that default-valued field.
   */
  async write(
    patch: SettingsPatch,
    options: DesktopSettingsWriteOptions = {}
  ): Promise<Settings> {
    const task = async (): Promise<Settings> => {
      const current = await this.read();
      const merged = mergeSettings(current, patch);
      // A disk round-trip used to re-run shape normalization after every
      // write. Preserve that invariant without the I/O: additive defaults and
      // migrations must appear in the cached result exactly as they would
      // after a fresh process launch.
      const normalized = this.normalizeForSnapshot(merged);
      const prepared = options.prepare === undefined
        ? undefined
        : await options.prepare(current, merged);
      try {
        await this.atomicWriteJson(normalized);
      } catch (cause) {
        if (prepared !== undefined) {
          try {
            await prepared.rollback();
          } catch (rollbackCause) {
            this.log.error("settings-service: staged write rollback failed", {
              path: this.filePath,
              message:
                rollbackCause instanceof Error
                  ? rollbackCause.message
                  : String(rollbackCause)
            });
          }
        }
        throw cause;
      }
      // The rename is the settings commit point. Publish the same canonical
      // shape immediately, then finalize the already-staged external state.
      this.replaceSnapshot(normalized);
      prepared?.commit();
      return deepFreeze(merged);
    };

    // Chain onto the existing queue so concurrent writes serialize.
    // Use `.catch(() => undefined).then(task)` so the queue's baton is
    // always a resolved Promise — `then(task, task)` runs `task` on
    // both fulfillment and rejection (correct intent) but is harder
    // to reason about, and the prior double-chain through
    // `this.writeQueue = next.then(_, _)` discarded inner results
    // without strictly serializing concurrent writes. The caller of
    // `next` still observes any rejection from `task`; only the
    // queue itself swallows it so subsequent writes can proceed.
    return this.enqueue(task);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  // ---- internals ----

  private replaceSnapshot(settings: Settings): Settings {
    const immutable = deepFreeze(settings);
    this.snapshot = immutable;
    return immutable;
  }

  private normalizeForSnapshot(input: unknown): Settings {
    for (const entry of SHAPE_CATALOG) {
      const normalized = entry.parse(
        input,
        this.currentAppVersion(),
        this.shortcutPlatform
      );
      if (normalized !== null) return normalized;
    }
    throw new Error("settings-service: merged settings did not match a known shape");
  }

  private async quarantine(reason: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = `${this.filePath}.corrupt-${stamp}.json`;
    try {
      await rename(this.filePath, quarantinePath);
      this.log.warn("settings-service: quarantined corrupt settings file", {
        path: this.filePath,
        quarantine: quarantinePath,
        reason
      });
    } catch (cause) {
      this.log.warn("settings-service: failed to quarantine corrupt file", {
        path: this.filePath,
        reason,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  protected async atomicWriteJson(value: Settings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const json = `${JSON.stringify(value, null, 2)}\n`;
    try {
      await writeFile(tmpPath, json, "utf8");
      await rename(tmpPath, this.filePath);
      this.atomicWriteCount += 1;
    } catch (cause) {
      // Best-effort cleanup of an orphaned tmp file. If the rename
      // itself failed mid-flight (rare on POSIX), the next write
      // overwrites cleanly.
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
      throw cause;
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return {
    schemaVersion: 1,
    lastDefaultsMigrationVersion:
      current.lastDefaultsMigrationVersion ?? CURRENT_DEFAULTS_MIGRATION_VERSION,
    codex: mergeSection(current.codex, patch.codex),
    ai: mergeAi(current.ai, patch.ai),
    hotkeys: mergeSection(current.hotkeys, patch.hotkeys),
    general: mergeSection(current.general, patch.general),
    experimental: mergeSection(current.experimental, patch.experimental),
    appearance: mergeSection(current.appearance, patch.appearance),
    updates: mergeUpdates(current.updates, patch.updates),
    storage: mergeSection(current.storage, patch.storage),
    recording: mergeSection(current.recording, patch.recording),
    editor: mergeEditor(current.editor, patch.editor),
    library: mergeLibrary(current.library, patch.library),
    localAgents: mergeLocalAgents(current.localAgents, patch.localAgents)
  };
}

/** AI merge is one level deeper than the flat-shallow mergeSection
 *  because `chat` is itself an object that callers want to patch
 *  field-by-field (e.g., just `userGuidance` from a textarea blur).
 *  Mirrors `mergeEditor` / `mergeLibrary`. */
function mergeAi(current: Settings["ai"], patch: SettingsPatch["ai"]): Settings["ai"] {
  if (patch === undefined) return current;
  return {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    consentAcceptedAt:
      patch.consentAcceptedAt !== undefined ? patch.consentAcceptedAt : current.consentAcceptedAt,
    budgetSafetyDisabledAt:
      patch.budgetSafetyDisabledAt !== undefined
        ? patch.budgetSafetyDisabledAt
        : current.budgetSafetyDisabledAt,
    autoAcceptSuggestions:
      patch.autoAcceptSuggestions !== undefined
        ? patch.autoAcceptSuggestions
        : current.autoAcceptSuggestions,
    // `chat` is a sub-object; merge field-by-field. Empty array on
    // sensitiveDataPatterns IS a meaningful value (cleared list), not
    // a "leave alone" sentinel — substrate rule `undefined ≠ null ≠ ""`.
    chat: mergeChat(current.chat, patch.chat),
    defaults: mergeAiSurfaceDefaults(current.defaults, patch.defaults),
    acp: mergeAcp(current.acp, patch.acp)
  };
}

/** Merge `ai.acp`. `enabledAgentIds` REPLACES the stored set wholesale
 *  when present (the renderer ships the full desired set on each toggle,
 *  mirroring `chat.sensitiveDataPatterns`); an empty array clears it. An
 *  undefined `acp` / undefined `enabledAgentIds` leaves the stored set
 *  untouched. The bus validator has already rejected unknown ids by the
 *  time the patch reaches here. */
function mergeAcp(
  current: AcpSettings,
  patch: Partial<AcpSettings> | undefined
): AcpSettings {
  if (patch === undefined) return current;
  return {
    enabledAgentIds:
      patch.enabledAgentIds !== undefined
        ? patch.enabledAgentIds
        : current.enabledAgentIds,
    agents: mergeAcpAgents(current.agents ?? {}, patch.agents)
  };
}

/** Merge `ai.acp.agents` per agent id. Unlike `enabledAgentIds` (replace), the
 *  agents map merges field-by-field: a patched agent's `overridePath` /
 *  `selectedPath` updates only those leaves, and an explicit `""` / `null`
 *  clears that leaf (→ "auto"). An agent whose entry becomes empty is dropped
 *  so the stored shape stays minimal. Other agents are left untouched. */
function mergeAcpAgents(
  current: Record<string, AcpAgentPreference>,
  patch: Record<string, AcpAgentPreference> | undefined
): Record<string, AcpAgentPreference> {
  if (patch === undefined) return current;
  const next: Record<string, AcpAgentPreference> = { ...current };
  for (const [id, prefPatch] of Object.entries(patch)) {
    if (prefPatch === undefined) continue;
    const merged: AcpAgentPreference = { ...next[id] };
    if ("overridePath" in prefPatch) {
      const value = prefPatch.overridePath;
      if (value === undefined || value === null || value === "") {
        delete merged.overridePath;
      } else {
        merged.overridePath = value;
      }
    }
    if ("selectedPath" in prefPatch) {
      const value = prefPatch.selectedPath;
      if (value === undefined || value === null || value === "") {
        delete merged.selectedPath;
      } else {
        merged.selectedPath = value;
      }
    }
    if (merged.overridePath === undefined && merged.selectedPath === undefined) {
      delete next[id];
    } else {
      next[id] = merged;
    }
  }
  return next;
}

/** Merge `ai.defaults` field-by-field across the three surfaces. Each
 *  surface is independently optional; within a surface each leaf is
 *  too. Per the substrate hygiene rule, an explicit empty string clears
 *  the field (→ "use Codex default"), while `undefined` leaves it
 *  untouched. The stored shape OMITS cleared fields so it matches what
 *  `parseAiSurfaceDefault` produces on the next read. */
type AiDefaultsPatch = NonNullable<NonNullable<SettingsPatch["ai"]>["defaults"]>;

function mergeAiSurfaceDefaults(
  current: AiSurfaceDefaults,
  patch: AiDefaultsPatch | undefined
): AiSurfaceDefaults {
  if (patch === undefined) return current;
  return {
    libraryChat: mergeAiSurfaceDefault(current.libraryChat, patch.libraryChat),
    sizzleChat: mergeAiSurfaceDefault(current.sizzleChat, patch.sizzleChat),
    enrichment: mergeAiSurfaceDefault(current.enrichment, patch.enrichment)
  };
}

function mergeAiSurfaceDefault(
  current: AiSurfaceDefault,
  patch: AiSurfaceDefaultPatch | undefined
): AiSurfaceDefault {
  if (patch === undefined) return current;
  const out: AiSurfaceDefault = { ...current };
  // provider / model / reasoning: explicit "" clears the key (→ Codex
  // default); any non-empty value sets it; undefined leaves it as-is.
  if (patch.provider !== undefined) {
    if (patch.provider.trim().length === 0) delete out.provider;
    else out.provider = patch.provider.trim();
  }
  if (patch.model !== undefined) {
    if (patch.model.trim().length === 0) delete out.model;
    else out.model = patch.model.trim();
  }
  if (patch.reasoning !== undefined) {
    if (patch.reasoning === "") delete out.reasoning;
    else out.reasoning = patch.reasoning;
  }
  return out;
}

function mergeChat(
  current: ChatSettings,
  patch: Partial<ChatSettings> | undefined
): ChatSettings {
  if (patch === undefined) return current;
  return {
    userGuidance: patch.userGuidance !== undefined ? patch.userGuidance : current.userGuidance,
    sensitiveDataPatterns:
      patch.sensitiveDataPatterns !== undefined
        ? patch.sensitiveDataPatterns
        : current.sensitiveDataPatterns,
    defaultRedactionStyle:
      patch.defaultRedactionStyle !== undefined
        ? patch.defaultRedactionStyle
        : current.defaultRedactionStyle,
    firstLaunchBannerDismissed:
      patch.firstLaunchBannerDismissed !== undefined
        ? patch.firstLaunchBannerDismissed
        : current.firstLaunchBannerDismissed
  };
}

/** Library merge is one level deeper than the flat-shallow mergeSection
 *  because `detailRail` is itself an object. Mirrors `mergeEditor`. */
function mergeLibrary(
  current: Settings["library"],
  patch: SettingsPatch["library"]
): Settings["library"] {
  if (patch === undefined) return current;
  return {
    detailRail: mergeSection(current.detailRail, patch.detailRail),
    gridCopyPalette: mergeSection(
      current.gridCopyPalette,
      patch.gridCopyPalette
    ),
    confirmBeforeTrash:
      patch.confirmBeforeTrash !== undefined
        ? patch.confirmBeforeTrash
        : current.confirmBeforeTrash,
    gridZoom:
      patch.gridZoom !== undefined
        ? clampGridZoom(patch.gridZoom)
        : current.gridZoom
  };
}

function mergeLocalAgents(
  current: Settings["localAgents"],
  patch: SettingsPatch["localAgents"]
): Settings["localAgents"] {
  if (patch === undefined) return current;
  return {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    grants: patch.grants !== undefined ? patch.grants : current.grants,
    roles: patch.roles !== undefined ? patch.roles : current.roles,
    audit: patch.audit !== undefined ? patch.audit : current.audit
  };
}

/** Editor merge is one level deeper than the flat-shallow mergeSection
 *  because toolStyles is itself an object keyed by tool kind. Without
 *  this, a swatch click that ships `editor: { toolStyles: { arrow: {
 *  color: "red" } } }` would clobber text/rect/blur/highlight styles.
 *  The leaf style blocks (arrow/text/rect/blur/highlight) DO merge
 *  shallowly because each leaf field is independently replaceable. */
function mergeEditor(
  current: EditorSettings,
  patch: SettingsPatch["editor"]
): EditorSettings {
  if (patch === undefined) return current;
  return {
    toolStyles: mergeToolStyles(current.toolStyles, patch.toolStyles),
    coachmarks: mergeSection(current.coachmarks, patch.coachmarks),
    matchingText: mergeSection(current.matchingText, patch.matchingText),
    sidebar: mergeSection(current.sidebar, patch.sidebar)
  };
}

function mergeToolStyles(
  current: EditorToolStyles,
  patch: NonNullable<SettingsPatch["editor"]>["toolStyles"]
): EditorToolStyles {
  if (patch === undefined) return current;
  return {
    arrow: mergeSection(current.arrow, patch.arrow),
    text: mergeSection(current.text, patch.text),
    shape: mergeSection(current.shape, patch.shape),
    blur: mergeSection(current.blur, patch.blur),
    highlight: mergeSection(current.highlight, patch.highlight)
  };
}

/** `selectionSource` is main-owned, so it is derived here rather than
 *  accepted from the patch: naming EITHER axis is what makes a selection
 *  a user's pin. Deriving it means no call site can persist a slot the
 *  next hydration would silently re-infer away. */
function mergeUpdates(
  current: Settings["updates"],
  patch: SettingsPatch["updates"]
): Settings["updates"] {
  if (patch === undefined) return current;
  const picked = patch.channel !== undefined || patch.train !== undefined;
  return {
    channel: patch.channel ?? current.channel,
    train: patch.train ?? current.train,
    selectionSource: picked ? "user" : current.selectionSource
  };
}

function mergeSection<T extends Record<string, unknown>>(
  current: T,
  patch: Partial<T> | undefined
): T {
  if (patch === undefined) return current;
  const out: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch) as Array<keyof T & string>) {
    const value = patch[key];
    if (value === undefined) continue; // leave untouched
    out[key] = value;
  }
  return out as T;
}
