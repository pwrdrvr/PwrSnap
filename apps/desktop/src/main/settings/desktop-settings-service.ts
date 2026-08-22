// Atomic write via tmp+rename. Reads route through an ordered legacy-
// shape catalog (see SHAPE_CATALOG below) so schema growth doesn't
// force eager migrations on read — we rewrite on the next `write`.
// Concurrent writes serialize through a single promise chain.

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
  CodexTestResult,
  DesktopCodexAuthProbe as SharedCodexAuthProbe,
  DesktopCodexCandidateSource as SharedCodexCandidateSource,
  DesktopCodexDiscoveryCandidate as SharedCodexCandidate,
  DesktopCodexDiscoverySnapshot as SharedCodexSnapshot,
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
  ShapeKind,
  ShapeToolStyle,
  SensitiveDataPattern,
  Settings,
  SettingsPatch,
  TextFontWeight,
  TextToolStyle,
  ToolColor,
  ToolSizePreset,
  UpdateChannel,
  UpdateTrain
} from "@pwrsnap/shared";
import {
  DEFAULT_AI_SURFACE_DEFAULTS,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_CODEX_CAPTION_MODEL,
  DEFAULT_ENRICHMENT_REASONING_EFFORT,
  DEFAULT_HOTKEYS,
  HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT,
  HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
  HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
  GRID_ZOOM_DEFAULT,
  GRID_ZOOM_MAX,
  GRID_ZOOM_MIN,
  MAX_HIGHLIGHT_OPACITY,
  DEFAULT_PARALLELOGRAM_SKEW_DEG,
  DEFAULT_SHAPE_KIND,
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
  findRoleForCapabilities,
  defaultLocalAgentRoleConstraints,
  isValidRole,
  LOCAL_AGENT_BUILT_IN_ROLES,
  isRedactionStyle,
  inferUpdateSelection,
  isUpdateChannel,
  isUpdateTrain
} from "@pwrsnap/shared";
import {
  compareCodexCliVersions,
  discoverCodexCommands,
  MINIMUM_CODEX_CLI_VERSION,
  probeCodexAuth,
  resolveCodexCommand,
  selectResolvedCodexCommand
} from "./codex-discovery";
import { getMainLogger } from "../log";
import { execAgentCommand } from "../ai/agent-command";

/** Per-probe timeout for Codex `--version` in `testCodex`. Mirrors
 *  PwrAgnt's `DEFAULT_PROBE_TIMEOUT_MS`. */
const CODEX_TEST_TIMEOUT_MS = 7500;
const ERROR_MESSAGE_LIMIT = 240;
const LEGACY_ENRICHMENT_DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULTS_MIGRATION_VERSIONS: readonly string[] = ["1.0.0-beta.26"];
const CURRENT_DEFAULTS_MIGRATION_VERSION = "1.0.0-beta.26";

type Logger = ReturnType<typeof getMainLogger>;

export type DesktopSettingsServiceConfig = {
  filePath: string;
  logger?: Logger;
  /** Installed app version used to seed `updates.train` / `updates.channel`
   *  when both keys are absent from the file. Tests pass this explicitly
   *  so inference does not depend on Electron. */
  appVersion?: string;
  resolveAppVersion?: () => string;
};

export function defaultSettings(): Settings {
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
    hotkeys: { ...DEFAULT_HOTKEYS },
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
      // Default to Stable Latest. A missing settings file still goes
      // through `inferUpdateSelection` in `read()` so a website Beta
      // download follows that feed until the user picks something.
      channel: "latest",
      train: "stable"
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
      // Audio defaults OFF — recording either source is privacy-
      // relevant; we'd rather have the user explicitly toggle ON
      // for their first MP4 export than silently default to "yes
      // include everything". Once they pick, the choice persists.
      includeSystemAudio: false,
      includeMicrophone: false,
      // Cursor defaults ON for both modes: video has always baked in
      // the cursor (the native recorder hardcoded it), and Phase 1
      // preserves that. Image consumption lands in Phase 3; the field
      // is seeded now so the later change is additive.
      videoCaptureCursor: true,
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
    toolStyles: {
      // Default to the brand accent (tangerine) rather than picking a
      // stoplight color — neutral choice for a first-time user who
      // hasn't established a personal pattern yet. The shared-COLOR-
      // slot pattern means the first swatch they pick will propagate
      // across all tools.
      arrow: {
        color: "accent",
        thickness: "auto",
        endStyle: "filled-triangle",
        stemStyle: "solid",
        doubleEnded: false
      },
      text: {
        color: "accent",
        fontSize: "auto",
        weight: "regular"
      },
      shape: {
        color: "accent",
        thickness: "auto",
        filled: false,
        shape: DEFAULT_SHAPE_KIND,
        skewDeg: DEFAULT_PARALLELOGRAM_SKEW_DEG
      },
      blur: {
        mode: "gaussian",
        radius: { mode: "auto" }
      },
      highlight: {
        // Yellow is the canonical highlight color (same as a yellow
        // marker on paper); not part of the cross-tool shared COLOR
        // slot because highlight is the one tool whose semantic is
        // "color = visual emphasis" rather than "color = severity".
        color: "yellow",
        opacity: 0.3,
        blend: "multiply"
      }
    },
    coachmarks: {
      // Flips true the first time the user opens any tool style popover
      // and the 3s stoplight micro-coachmark auto-dismisses.
      stoplightSeen: false
    },
    matchingText: {
      // "+ Add label" affordance appears after arrow placement by
      // default. User can disable it from the EDITOR card on
      // Settings → General if it feels intrusive for their workflow.
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
  parse(raw: unknown, appVersion: string): Settings | null;
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
    doubleEnded: pickBoolean(raw.doubleEnded, defaults.doubleEnded)
  };
}

function parseTextToolStyle(raw: unknown, defaults: TextToolStyle): TextToolStyle {
  if (!isRecord(raw)) return defaults;
  return {
    color: pickToolColor(raw.color, defaults.color),
    fontSize: pickToolSizePreset(raw.fontSize, defaults.fontSize),
    weight: pickTextFontWeight(raw.weight, defaults.weight)
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
    skewDeg: pickFiniteNumber(raw.skewDeg, defaults.skewDeg)
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

function parseUpdates(
  raw: unknown,
  appVersion: string,
  defaults: Settings["updates"]
): Settings["updates"] {
  const updates = isRecord(raw) ? raw : {};
  const hasChannel = isUpdateChannel(updates.channel);
  const hasTrain = isUpdateTrain(updates.train);
  // Infer the version-derived pair only when neither key exists. A
  // pre-train config with only `channel = "prerelease"` must stay on
  // Stable so installing a 1.1.0-beta binary does not silently move
  // that operator onto Beta Prerelease / alphas.
  if (!hasChannel && !hasTrain) {
    return inferUpdateSelection(appVersion);
  }
  return {
    channel: hasChannel ? (updates.channel as UpdateChannel) : defaults.channel,
    train: hasTrain ? (updates.train as UpdateTrain) : defaults.train
  };
}

function parseV1(raw: unknown, appVersion = ""): Settings | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== 1) return null;
  const defaults = defaultSettings();
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
      // convention. See docs/plans/2026-05-28-001-feat-library-chat-
      // editor-interface-plan.md and §F13 substrate compliance.
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
    hotkeys: {
      quickCapture: pickString(hotkeys.quickCapture, defaults.hotkeys.quickCapture),
      region: pickString(hotkeys.region, defaults.hotkeys.region),
      window: pickString(hotkeys.window, defaults.hotkeys.window),
      // `fullScreen` / `allScreens` / `timed` landed after v1 shipped;
      // older files won't have them. pickString fills in the current
      // default ("" = unbound) so the fields are always present in-memory.
      fullScreen: pickString(hotkeys.fullScreen, defaults.hotkeys.fullScreen),
      allScreens: pickString(hotkeys.allScreens, defaults.hotkeys.allScreens),
      timed: pickString(hotkeys.timed, defaults.hotkeys.timed),
      // `videoCapture` landed after v1 shipped; older files won't have
      // it. pickString fills in the current default for that case so
      // the field is always present in-memory.
      videoCapture: pickString(hotkeys.videoCapture, defaults.hotkeys.videoCapture),
      // `reshowFloatOver` landed after v1 shipped; older files won't have
      // it. pickString fills in the current default (⌘⌥⇧F) so the field
      // is always present in-memory.
      reshowFloatOver: pickString(hotkeys.reshowFloatOver, defaults.hotkeys.reshowFloatOver),
      // `openLibrary` landed after v1 shipped; older files won't have
      // it. pickString fills in the current default ("" = unbound).
      openLibrary: pickString(hotkeys.openLibrary, defaults.hotkeys.openLibrary)
    },
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
    // `editor.*` landed in the v2-editor refresh (docs/plans/2026-05-23-
    // 001). Older files won't have it; parseEditorSettings falls through
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

// Translate the desktop-side discovery candidate shape into the shared
// shape exposed to the renderer.
function toSharedCandidate(input: {
  command: string;
  source: SharedCodexCandidateSource;
  executable: boolean;
  version?: string | undefined;
}): SharedCodexCandidate {
  return {
    path: input.command,
    source: input.source,
    version: input.version ?? null,
    available: input.executable
  };
}

const CODEX_DISCOVERY_CACHE_TTL_MS = 30_000;

export class DesktopSettingsService {
  private readonly filePath: string;
  private readonly log: Logger;
  private readonly resolveAppVersion: () => string;

  /**
   * Serializes all writes. Read isn't gated through this chain — the
   * file system itself provides crash consistency via the tmp+rename
   * dance, and reads always observe either the prior committed state
   * or the next one, never a torn write.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private codexSnapshotCache:
    | { snapshot: SharedCodexSnapshot; computedAt: number }
    | null = null;

  /** In-flight snapshot computation. Concurrent non-forced readers (the
   *  Library, float-over, and Settings windows all refresh on the same
   *  settings broadcast) piggyback on it instead of each spawning their
   *  own discovery pass. */
  private codexSnapshotInflight: Promise<SharedCodexSnapshot> | null = null;

  /** Bumped whenever a `codex.*` write invalidates the cache. A
   *  computation started under an older epoch still returns its snapshot
   *  to its caller but must not populate the cache — otherwise a write
   *  landing mid-computation would be shadowed by stale results for up
   *  to the cache TTL. */
  private codexSnapshotEpoch = 0;

  constructor(config: DesktopSettingsServiceConfig) {
    this.filePath = config.filePath;
    this.log = config.logger ?? getMainLogger("pwrsnap:settings-service");
    this.resolveAppVersion =
      config.resolveAppVersion ??
      (() => config.appVersion ?? "");
  }

  private currentAppVersion(): string {
    return this.resolveAppVersion();
  }

  private withInferredUpdates(settings: Settings): Settings {
    return {
      ...settings,
      updates: inferUpdateSelection(this.currentAppVersion())
    };
  }

  getFilePath(): string {
    return this.filePath;
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
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") {
        return this.withInferredUpdates(defaultSettings());
      }
      this.log.warn("settings-service: read failed, using defaults", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return this.withInferredUpdates(defaultSettings());
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      await this.quarantine(`json_parse: ${cause instanceof Error ? cause.message : String(cause)}`);
      return this.withInferredUpdates(defaultSettings());
    }

    for (const entry of SHAPE_CATALOG) {
      const normalized = entry.parse(parsed, this.currentAppVersion());
      if (normalized !== null) return normalized;
    }

    await this.quarantine("no_shape_matched");
    return this.withInferredUpdates(defaultSettings());
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
   * `write` calls observe each other's results — the second write
   * reads the file the first wrote, not the file both started from.
   *
   * Returns the merged Settings the caller can echo to renderers.
   */
  async write(patch: SettingsPatch): Promise<Settings> {
    const task = async (): Promise<Settings> => {
      const current = await this.read();
      const merged = mergeSettings(current, patch);
      await this.atomicWriteJson(merged);
      // Invalidate the Codex discovery cache whenever a write touches
      // `codex.*`. Otherwise the snapshot's `resolvedPath` (computed
      // from `settings.codex.{mode, pinnedPath}` at snapshot time)
      // can lag the just-written settings by up to 30s, so the AI
      // Providers "Using" badge sticks to the prior choice after a
      // pin. Only invalidate on success so a rejected write doesn't
      // force an extra (uncached) discovery on the next read.
      if (patch.codex !== undefined) this.invalidateCodexSnapshotCache();
      return merged;
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
    const next = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Returns the current Codex CLI discovery snapshot in the shared
   * shape the renderer consumes. Cached for 30s by default — Codex
   * discovery shells out to `/usr/bin/which` + executes each candidate
   * with `--version`, and the renderer's page-mount call shouldn't
   * pay that on every navigation. The Refresh button passes
   * `force: true` to bypass the cache.
   */
  async getCodexDiscoverySnapshot(opts?: { force?: boolean }): Promise<SharedCodexSnapshot> {
    const force = opts?.force === true;
    if (!force && this.codexSnapshotCache !== null) {
      const age = Date.now() - this.codexSnapshotCache.computedAt;
      if (age < CODEX_DISCOVERY_CACHE_TTL_MS) {
        return this.codexSnapshotCache.snapshot;
      }
    }
    // Coalesce concurrent readers onto the in-flight computation —
    // every open window refreshes on the same settings broadcast, and
    // without this each one would spawn its own discovery pass the
    // moment the cache lapses. A forced refresh always starts fresh
    // (and becomes the in-flight pass others piggyback on).
    if (!force && this.codexSnapshotInflight !== null) {
      return this.codexSnapshotInflight;
    }

    const compute = this.computeCodexDiscoverySnapshot(this.codexSnapshotEpoch);
    this.codexSnapshotInflight = compute;
    try {
      return await compute;
    } finally {
      if (this.codexSnapshotInflight === compute) {
        this.codexSnapshotInflight = null;
      }
    }
  }

  private async computeCodexDiscoverySnapshot(epoch: number): Promise<SharedCodexSnapshot> {
    const settings = await this.read();
    const pinnedCommand =
      settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
        ? settings.codex.pinnedPath
        : undefined;
    const discovery = await discoverCodexCommands({
      configuredCommand: pinnedCommand,
      env: process.env
    });
    // The shared shape exposes only path/source/version/available — no
    // "selected" flag. The renderer compares each candidate's path to
    // `resolvedPath` to draw the "Using" badge.
    const candidates: SharedCodexCandidate[] = discovery.candidates.map((c) =>
      toSharedCandidate(c)
    );

    // Resolution selects from the discovery pass we just ran. This used
    // to call `resolveCodexCommand`, which internally re-runs a FULL
    // second discovery — doubling the candidate `--version` spawns on
    // every uncached snapshot.
    const resolved = selectResolvedCodexCommand(discovery, pinnedCommand ?? "codex");
    let resolvedPath: string | null = null;
    let auth: SharedCodexAuthProbe | null = null;
    const resolvedCandidate = candidates.find(
      (candidate) => candidate.available && candidate.path === resolved.command
    );
    if (resolvedCandidate !== undefined) {
      resolvedPath = resolved.command;
      auth = await probeCodexAuth(resolved.command, process.env);
    }

    const snapshot: SharedCodexSnapshot = {
      candidates,
      resolvedPath,
      auth,
      refreshedAt: new Date().toISOString()
    };
    if (epoch === this.codexSnapshotEpoch) {
      this.codexSnapshotCache = { snapshot, computedAt: Date.now() };
    }
    return snapshot;
  }

  private invalidateCodexSnapshotCache(): void {
    this.codexSnapshotEpoch += 1;
    this.codexSnapshotCache = null;
    this.codexSnapshotInflight = null;
  }

  /**
   * Spawn the currently-resolved Codex binary with `--version`, parse
   * the banner, and version-check against `MINIMUM_CODEX_CLI_VERSION`.
   * Mirrors PwrAgnt's `CredentialTester.testCodex` shape so a future
   * lift of the tester arrives at the same protocol.
   */
  async testCodex(): Promise<CodexTestResult> {
    const startedAt = Date.now();
    const settings = await this.read();
    let resolvedCommand: string | null = null;
    try {
      const resolved = await resolveCodexCommand({
        command:
          settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
            ? settings.codex.pinnedPath
            : "codex",
        env: process.env
      });
      resolvedCommand = resolved.command;
    } catch {
      resolvedCommand = null;
    }

    if (resolvedCommand === null) {
      return {
        status: "unset",
        testedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        account: null
      };
    }

    const probeStart = Date.now();
    try {
      const { stdout, stderr } = await execAgentCommand(resolvedCommand, ["--version"], {
        env: process.env,
        timeoutMs: CODEX_TEST_TIMEOUT_MS
      });
      const durationMs = Date.now() - probeStart;
      const testedAt = new Date().toISOString();
      const output = `${stdout?.toString() ?? ""}\n${stderr?.toString() ?? ""}`;
      const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
      if (match) {
        const version = match[1] as string;
        if (compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0) {
          return {
            status: "failed",
            testedAt,
            durationMs,
            account: resolvedCommand,
            errorMessage: `Codex CLI ${version} is older than the minimum supported version ${MINIMUM_CODEX_CLI_VERSION}`
          };
        }
        return {
          status: "ok",
          testedAt,
          durationMs,
          account: resolvedCommand,
          detail: version
        };
      }
      return {
        status: "failed",
        testedAt,
        durationMs,
        account: resolvedCommand,
        errorMessage: "version banner not recognized in stdout/stderr"
      };
    } catch (cause) {
      return {
        status: "failed",
        testedAt: new Date().toISOString(),
        durationMs: Date.now() - probeStart,
        account: resolvedCommand,
        errorMessage: clipError(cause)
      };
    }
  }

  // ---- internals ----

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

  private async atomicWriteJson(value: Settings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const json = `${JSON.stringify(value, null, 2)}\n`;
    try {
      await writeFile(tmpPath, json, "utf8");
      await rename(tmpPath, this.filePath);
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
    updates: mergeSection(current.updates, patch.updates),
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

function clipError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.name === "AbortError"
        ? "request timed out"
        : error.message
      : String(error);
  return message.length <= ERROR_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, ERROR_MESSAGE_LIMIT - 1)}…`;
}
