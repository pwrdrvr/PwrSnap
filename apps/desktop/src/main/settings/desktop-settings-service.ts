// Atomic write via tmp+rename. Reads route through an ordered legacy-
// shape catalog (see SHAPE_CATALOG below) so schema growth doesn't
// force eager migrations on read — we rewrite on the next `write`.
// Concurrent writes serialize through a single promise chain.

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
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
  LibrarySidebarTab,
  HighlightBlendMode,
  HighlightToolStyle,
  ShapeKind,
  ShapeToolStyle,
  SensitiveDataPattern,
  Settings,
  SettingsPatch,
  TextFontWeight,
  TextToolStyle,
  ToolColor,
  ToolSizePreset
} from "@pwrsnap/shared";
import {
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_CODEX_CAPTION_MODEL,
  MAX_HIGHLIGHT_OPACITY,
  DEFAULT_PARALLELOGRAM_SKEW_DEG,
  DEFAULT_SHAPE_KIND,
  isAppearanceTheme,
  isCodexCaptionModel,
  isColorToken,
  isEditorSidebarPanel,
  isLibrarySidebarTab,
  isRedactionStyle
} from "@pwrsnap/shared";
import {
  compareCodexCliVersions,
  discoverCodexCommands,
  MINIMUM_CODEX_CLI_VERSION,
  probeCodexAuth,
  resolveCodexCommand
} from "./codex-discovery";
import { getMainLogger } from "../log";

const execFile = promisify(execFileCallback);

/** Per-probe timeout for Codex `--version` in `testCodex`. Mirrors
 *  PwrAgnt's `DEFAULT_PROBE_TIMEOUT_MS`. */
const CODEX_TEST_TIMEOUT_MS = 7500;
const ERROR_MESSAGE_LIMIT = 240;

type Logger = ReturnType<typeof getMainLogger>;

export type DesktopSettingsServiceConfig = {
  filePath: string;
  logger?: Logger;
};

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
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
      chat: { ...DEFAULT_CHAT_SETTINGS, sensitiveDataPatterns: [] }
    },
    hotkeys: {
      // Quick Capture default moved off ⌘⇧P (collides with Print in
      // browsers + iWork) to ⌘⇧C. Region + Window default to UNBOUND
      // since Quick Capture's auto mode covers both — power users can
      // bind them explicitly from Settings → Hotkeys if they want a
      // dedicated chord.
      //
      // Video Capture is ⌘⌥C, not ⌘⇧V. ⌘⇧V is "Paste and Match
      // Style" in browsers / Slack / Mail / Pages / Notes / Discord
      // — globalShortcut.register wins system-wide, so claiming
      // ⌘⇧V would steal that shortcut from every app on the box
      // while PwrSnap runs. ⌘⌥C is bound by default only to
      // Finder's "Copy as Pathname" (much rarer power-user
      // feature) and ties nicely to the existing ⌘⇧C Quick Capture
      // mnemonic — option + Capture = "alternative capture mode
      // (video)".
      quickCapture: "CommandOrControl+Shift+C",
      region: "",
      window: "",
      // Full Screen / All Screens / Timed exist as capture verbs and are
      // reachable from the tray; the hotkeys are unbound by default so we
      // don't claim three more global chords out of the box. Users bind
      // them from Settings → Hotkeys if they want a dedicated chord.
      fullScreen: "",
      allScreens: "",
      timed: "",
      videoCapture: "CommandOrControl+Alt+C",
      // Re-show last Float-Over. ⌘⌥⇧F (mnemonic: Float-over). The three-
      // modifier chord keeps it clear of app/OS shortcuts — a 2-modifier
      // default like ⌘⇧F would shadow Find-in-Files system-wide while
      // PwrSnap runs. Rebindable/unbindable from Settings → Hotkeys.
      reshowFloatOver: "CommandOrControl+Alt+Shift+F"
    },
    general: {
      developerMode: false
    },
    appearance: {
      // "system" tracks the OS appearance via the renderer's
      // matchMedia listener. Explicit "dark" / "light" override.
      theme: "system"
    },
    updates: {
      // Default to stable. Power users + beta testers flip to
      // "prerelease" in Settings; auto-updater picks it up on the next
      // check (hourly, or immediately via Help → Check for Updates).
      channel: "latest"
    },
    storage: {
      // Local timestamps match what single users remember seeing on
      // screen/Finder. UTC is still available for shared-drive teams.
      filenameTimestampZone: "local"
    },
    recording: {
      // Audio defaults OFF — recording either source is privacy-
      // relevant; we'd rather have the user explicitly toggle ON
      // for their first MP4 export than silently default to "yes
      // include everything". Once they pick, the choice persists.
      includeSystemAudio: false,
      includeMicrophone: false,
      lastRoutedPermissionFingerprint: ""
    },
    editor: defaultEditorSettings(),
    library: defaultLibrarySettings()
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
    }
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
  parse(raw: unknown): Settings | null;
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

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

function parseV1(raw: unknown): Settings | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== 1) return null;
  const defaults = defaultSettings();
  const codex = isRecord(raw.codex) ? raw.codex : {};
  const ai = isRecord(raw.ai) ? raw.ai : {};
  const hotkeys = isRecord(raw.hotkeys) ? raw.hotkeys : {};
  const general = isRecord(raw.general) ? raw.general : {};
  const appearance = isRecord(raw.appearance) ? raw.appearance : {};
  const updates = isRecord(raw.updates) ? raw.updates : {};
  const storage = isRecord(raw.storage) ? raw.storage : {};
  const recording = isRecord(raw.recording) ? raw.recording : {};
  return {
    schemaVersion: 1,
    codex: {
      mode: pickMode(codex.mode ?? defaults.codex.mode),
      pinnedPath: pickString(codex.pinnedPath, defaults.codex.pinnedPath),
      profile: pickString(codex.profile, defaults.codex.profile),
      // `captionModel` landed after v1 shipped; older files won't have
      // it. Codex model availability is account/build dependent, so keep
      // valid model-id strings instead of pinning this parser to a stale
      // hardcoded allowlist.
      captionModel: isCodexCaptionModel(codex.captionModel)
        ? codex.captionModel
        : defaults.codex.captionModel
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
      chat: parseChatSettings(ai.chat, defaults.ai.chat)
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
      // it. pickString fills in the current default (⌘⇧F) so the field
      // is always present in-memory.
      reshowFloatOver: pickString(hotkeys.reshowFloatOver, defaults.hotkeys.reshowFloatOver)
    },
    general: {
      // `general.developerMode` landed after v1 shipped; older files
      // won't have it. pickBoolean fills in the default (false) so the
      // field is always present in-memory.
      developerMode: pickBoolean(general.developerMode, defaults.general.developerMode)
    },
    appearance: {
      // `appearance` landed after v1 shipped; older files won't have
      // it. pickAppearanceTheme returns the default ("system") for
      // missing or invalid input so the field is always present
      // in-memory and the next write rewrites the file with the full
      // shape.
      theme: pickAppearanceTheme(appearance.theme, defaults.appearance.theme)
    },
    updates: {
      // `updates.channel` landed after v1 shipped; older files won't
      // have it. Fall back to the current default ("latest") so the
      // field is always present in-memory.
      channel: updates.channel === "prerelease" ? "prerelease" : defaults.updates.channel
    },
    storage: {
      // `storage.filenameTimestampZone` landed after v1 shipped;
      // older files default to local time so filenames match what
      // users remember from their wall clock.
      filenameTimestampZone: pickFilenameTimestampZone(
        storage.filenameTimestampZone,
        defaults.storage.filenameTimestampZone
      )
    },
    recording: {
      // `recording.*` landed after v1 shipped; older files won't have
      // it. Defaults to audio OFF + an empty fingerprint so the
      // startup permission routing fires once after the first launch
      // on the new build.
      includeSystemAudio: pickBoolean(recording.includeSystemAudio, defaults.recording.includeSystemAudio),
      includeMicrophone: pickBoolean(recording.includeMicrophone, defaults.recording.includeMicrophone),
      lastRoutedPermissionFingerprint: pickString(
        recording.lastRoutedPermissionFingerprint,
        defaults.recording.lastRoutedPermissionFingerprint
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
    library: parseLibrarySettings(raw.library, defaults.library)
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

function parseLibrarySettings(
  raw: unknown,
  defaults: Settings["library"]
): Settings["library"] {
  if (!isRecord(raw)) return defaults;
  const detailRaw = raw.detailRail;
  if (!isRecord(detailRaw)) return defaults;
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
    }
  };
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

  constructor(config: DesktopSettingsServiceConfig) {
    this.filePath = config.filePath;
    this.log = config.logger ?? getMainLogger("pwrsnap:settings-service");
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
        return defaultSettings();
      }
      this.log.warn("settings-service: read failed, using defaults", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return defaultSettings();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      await this.quarantine(`json_parse: ${cause instanceof Error ? cause.message : String(cause)}`);
      return defaultSettings();
    }

    for (const entry of SHAPE_CATALOG) {
      const normalized = entry.parse(parsed);
      if (normalized !== null) return normalized;
    }

    await this.quarantine("no_shape_matched");
    return defaultSettings();
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
      if (patch.codex !== undefined) this.codexSnapshotCache = null;
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

    const settings = await this.read();
    const configuredCommand =
      settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
        ? settings.codex.pinnedPath
        : undefined;
    const discovery = await discoverCodexCommands({
      configuredCommand,
      env: process.env
    });
    // The shared shape exposes only path/source/version/available — no
    // "selected" flag. The renderer compares each candidate's path to
    // `resolvedPath` to draw the "Using" badge.
    const candidates: SharedCodexCandidate[] = discovery.candidates.map((c) =>
      toSharedCandidate(c)
    );

    let resolvedPath: string | null = null;
    let auth: SharedCodexAuthProbe | null = null;
    try {
      const resolved = await resolveCodexCommand({
        command:
          settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
            ? settings.codex.pinnedPath
            : "codex",
        env: process.env
      });
      const resolvedCandidate = candidates.find(
        (candidate) => candidate.available && candidate.path === resolved.command
      );
      if (resolvedCandidate !== undefined) {
        resolvedPath = resolved.command;
        auth = await probeCodexAuth(resolved.command, process.env);
      }
    } catch (cause) {
      this.log.warn("settings-service: resolveCodexCommand failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      resolvedPath = null;
    }

    const snapshot: SharedCodexSnapshot = {
      candidates,
      resolvedPath,
      auth,
      refreshedAt: new Date().toISOString()
    };
    this.codexSnapshotCache = { snapshot, computedAt: Date.now() };
    return snapshot;
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
      const { stdout, stderr } = await execFile(resolvedCommand, ["--version"], {
        timeout: CODEX_TEST_TIMEOUT_MS
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
    codex: mergeSection(current.codex, patch.codex),
    ai: mergeAi(current.ai, patch.ai),
    hotkeys: mergeSection(current.hotkeys, patch.hotkeys),
    general: mergeSection(current.general, patch.general),
    appearance: mergeSection(current.appearance, patch.appearance),
    updates: mergeSection(current.updates, patch.updates),
    storage: mergeSection(current.storage, patch.storage),
    recording: mergeSection(current.recording, patch.recording),
    editor: mergeEditor(current.editor, patch.editor),
    library: mergeLibrary(current.library, patch.library)
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
    chat: mergeChat(current.chat, patch.chat)
  };
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
    detailRail: mergeSection(current.detailRail, patch.detailRail)
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
