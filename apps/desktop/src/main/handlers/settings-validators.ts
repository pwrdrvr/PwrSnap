// IPC input validators for the `settings:*` namespace.
//
// The command bus passes `req` straight through with a TypeScript cast —
// but TS types don't survive the IPC transport, and Phase 7 (HTTP RPC) +
// Phase 8 (MCP) will accept arbitrary JSON. Each validator below
// hand-checks the shape of one verb's payload and returns either a
// narrowed value or a structured error envelope the handler can
// short-circuit with.
//
// We deliberately do NOT pull in zod for this — the existing codebase
// doesn't depend on a runtime-validation library in the main bundle,
// and the validators here are surgical (one verb each, no nesting
// deeper than two levels). When a third or fourth verb needs the same
// treatment, revisit.

import {
  AI_REASONING_EFFORTS,
  AI_SURFACE_IDS,
  BUILT_IN_ACP_AGENT_IDS,
  isAiReasoningEffort,
  isBuiltInAcpAgentId,
  isAppearanceTheme,
  isCodexCaptionModel,
  isColorToken,
  isEditorSidebarPanel,
  isLibrarySidebarTab,
  isRedactionStyle,
  isSettingsPage,
  GRID_ZOOM_MAX,
  GRID_ZOOM_MIN,
  isHotCpuProfileStartDelayMs,
  isHotCpuProfileTriggerMode,
  LIBRARY_SIDEBAR_TABS,
  MAX_HIGHLIGHT_OPACITY,
  REDACTION_STYLES
} from "@pwrsnap/shared";
import type {
  DesktopSettingsSecretName,
  PwrSnapError,
  SettingsPage,
  SettingsPatch
} from "@pwrsnap/shared";
import { isValidProfileName, normalizeProfileName } from "@pwrdrvr/codex-discovery";
import { KNOWN_SECRET_NAMES } from "../settings/desktop-secret-store";

/** Inline builder so call sites read fluently. `kind: "validation"` is
 *  the canonical envelope for "request didn't pass the gate at the
 *  edge of the trust boundary" — see PwrSnapErrorKind in shared/result. */
function validationError(code: string, message: string): PwrSnapError {
  return { kind: "validation", code, message };
}

/** Discriminated result from each validator. `ok: true` carries the
 *  same shape as the input (narrowed); `ok: false` carries the
 *  structured error the handler returns via `err(...)`. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PwrSnapError };

// ---- settings:open ----

export function validateSettingsOpen(
  req: { page?: SettingsPage | undefined }
): ValidationResult<{ page: SettingsPage | undefined }> {
  if (req.page === undefined) return { ok: true, value: { page: undefined } };
  if (!isSettingsPage(req.page)) {
    return {
      ok: false,
      error: validationError(
        "invalid_page",
        `settings:open: unknown page id (got ${JSON.stringify(req.page)})`
      )
    };
  }
  return { ok: true, value: { page: req.page } };
}

// ---- settings:write ----

function isUndefined(value: unknown): boolean {
  return value === undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Rough shape-check for Electron accelerator strings. One-or-more
 *  modifier tokens followed by exactly one key token, all joined by
 *  `+`. We accept the modifier aliases Electron itself accepts
 *  (CommandOrControl/Cmd/Ctrl/Alt/Option/Shift/Super/Meta/Control) and
 *  let Electron's globalShortcut.register reject anything stricter at
 *  bind time — the goal here is to catch obvious garbage (`"asdf"`,
 *  `"+P"`, `"Shift"` alone) before it lands on disk. The key alphabet
 *  is intentionally permissive: every alphanumeric, ASCII punctuation
 *  Electron recognizes, plus named keys (Enter/Space/Tab/etc.) and
 *  function keys (F1–F24). */
const ACCELERATOR_SHAPE =
  /^(CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta)(\+(CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta))*\+([A-Za-z0-9`~!@#$%^&*()\-_=+[\]{}\\|;:'",.<>/?]|F([1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause|PrintScreen)$/;

/** Per-section validator. Each section's nested object is `Partial<T>` —
 *  every key is optional, but if present its value must match the
 *  declared type. `undefined` is always fine (means "untouched"); the
 *  service-level merge skips undefined keys. */
export function validateSettingsWrite(
  patch: unknown
): ValidationResult<SettingsPatch> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return {
      ok: false,
      error: validationError("invalid_patch", "settings:write: patch must be an object")
    };
  }
  const p = patch as Record<string, unknown>;

  if (p.codex !== undefined) {
    if (typeof p.codex !== "object" || p.codex === null || Array.isArray(p.codex)) {
      return {
        ok: false,
        error: validationError("invalid_codex", "settings:write: codex must be an object")
      };
    }
    const codex = p.codex as Record<string, unknown>;
    // pinnedPath: non-nullable string. `null` is rejected; "" is a valid clear.
    if (!isUndefined(codex.pinnedPath) && !isString(codex.pinnedPath)) {
      return {
        ok: false,
        error: validationError(
          "invalid_codex_pinnedPath",
          "settings:write: codex.pinnedPath must be a string"
        )
      };
    }
    // profile: non-nullable string.
    if (!isUndefined(codex.profile) && !isString(codex.profile)) {
      return {
        ok: false,
        error: validationError(
          "invalid_codex_profile",
          "settings:write: codex.profile must be a string"
        )
      };
    }
    // mode: literal union.
    if (
      !isUndefined(codex.mode) &&
      codex.mode !== "auto" &&
      codex.mode !== "pinned"
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_codex_mode",
          "settings:write: codex.mode must be \"auto\" or \"pinned\""
        )
      };
    }
    // captionModel: Codex model id. The available model list is dynamic
    // per installed Codex build/account, so validate shape at the bus edge
    // and let Codex reject unavailable ids at runtime.
    if (!isUndefined(codex.captionModel) && !isCodexCaptionModel(codex.captionModel)) {
      return {
        ok: false,
        error: validationError(
          "invalid_codex_captionModel",
          "settings:write: codex.captionModel must be a non-empty Codex model id"
        )
      };
    }
  }

  if (p.ai !== undefined) {
    if (typeof p.ai !== "object" || p.ai === null || Array.isArray(p.ai)) {
      return {
        ok: false,
        error: validationError("invalid_ai", "settings:write: ai must be an object")
      };
    }
    const ai = p.ai as Record<string, unknown>;
    if (!isUndefined(ai.enabled) && !isBoolean(ai.enabled)) {
      return {
        ok: false,
        error: validationError(
          "invalid_ai_enabled",
          "settings:write: ai.enabled must be a boolean"
        )
      };
    }
    if (!isUndefined(ai.consentAcceptedAt) && !isStringOrNull(ai.consentAcceptedAt)) {
      return {
        ok: false,
        error: validationError(
          "invalid_ai_consentAcceptedAt",
          "settings:write: ai.consentAcceptedAt must be a string or null"
        )
      };
    }
    if (
      !isUndefined(ai.budgetSafetyDisabledAt) &&
      !isStringOrNull(ai.budgetSafetyDisabledAt)
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_ai_budgetSafetyDisabledAt",
          "settings:write: ai.budgetSafetyDisabledAt must be a string or null"
        )
      };
    }
    if (!isUndefined(ai.autoAcceptSuggestions) && !isBoolean(ai.autoAcceptSuggestions)) {
      return {
        ok: false,
        error: validationError(
          "invalid_ai_autoAcceptSuggestions",
          "settings:write: ai.autoAcceptSuggestions must be a boolean"
        )
      };
    }
    if (!isUndefined(ai.chat)) {
      const chatErr = validateChatPatch(ai.chat);
      if (chatErr) return { ok: false, error: chatErr };
    }
    if (!isUndefined(ai.defaults)) {
      const defaultsErr = validateAiDefaultsPatch(ai.defaults);
      if (defaultsErr) return { ok: false, error: defaultsErr };
    }
    if (!isUndefined(ai.acp)) {
      const acpErr = validateAcpPatch(ai.acp);
      if (acpErr) return { ok: false, error: acpErr };
    }
  }

  if (p.hotkeys !== undefined) {
    if (typeof p.hotkeys !== "object" || p.hotkeys === null || Array.isArray(p.hotkeys)) {
      return {
        ok: false,
        error: validationError("invalid_hotkeys", "settings:write: hotkeys must be an object")
      };
    }
    const hotkeys = p.hotkeys as Record<string, unknown>;
    for (const key of [
      "quickCapture",
      "region",
      "window",
      "fullScreen",
      "allScreens",
      "timed",
      "videoCapture",
      "reshowFloatOver"
    ] as const) {
      const v = hotkeys[key];
      if (isUndefined(v)) continue;
      if (!isString(v)) {
        return {
          ok: false,
          error: validationError(
            "invalid_hotkey",
            `settings:write: hotkeys.${key} must be a string`
          )
        };
      }
      // Empty string is the "unbound" sentinel — always allowed. Any
      // non-empty value MUST look like an Electron accelerator
      // (`<Modifier>(+<Modifier>)*+<Key>`). We don't enforce the full
      // Electron accelerator grammar here (Electron's own validator
      // owns that and the global-shortcut register call returns false
      // for malformed strings); the regex is a cheap "obvious garbage"
      // filter so we never persist `"asdf"` or `"+"` from a buggy
      // renderer.
      if (v.length > 0 && !ACCELERATOR_SHAPE.test(v)) {
        return {
          ok: false,
          error: validationError(
            "invalid_hotkey_shape",
            `settings:write: hotkeys.${key} is not a recognizable accelerator (got ${JSON.stringify(v)})`
          )
        };
      }
    }
  }

  if (p.general !== undefined) {
    if (
      typeof p.general !== "object" ||
      p.general === null ||
      Array.isArray(p.general)
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_general",
          "settings:write: general must be an object"
        )
      };
    }
    const general = p.general as Record<string, unknown>;
    if (!isUndefined(general.developerMode) && !isBoolean(general.developerMode)) {
      return {
        ok: false,
        error: validationError(
          "invalid_general_developerMode",
          "settings:write: general.developerMode must be a boolean"
        )
      };
    }
    if (
      !isUndefined(general.hotCpuProfilingEnabled) &&
      !isBoolean(general.hotCpuProfilingEnabled)
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_general_hotCpuProfilingEnabled",
          "settings:write: general.hotCpuProfilingEnabled must be a boolean"
        )
      };
    }
    if (
      !isUndefined(general.hotCpuProfilingStartDelayMs) &&
      !(
        typeof general.hotCpuProfilingStartDelayMs === "number" &&
        isHotCpuProfileStartDelayMs(general.hotCpuProfilingStartDelayMs)
      )
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_general_hotCpuProfilingStartDelayMs",
          "settings:write: general.hotCpuProfilingStartDelayMs must be 0, 5000, or 10000"
        )
      };
    }
    if (
      !isUndefined(general.hotCpuProfilingTriggerMode) &&
      !(
        typeof general.hotCpuProfilingTriggerMode === "string" &&
        isHotCpuProfileTriggerMode(general.hotCpuProfilingTriggerMode)
      )
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_general_hotCpuProfilingTriggerMode",
          "settings:write: general.hotCpuProfilingTriggerMode must be \"spike\", \"sustained\", or \"slowburn\""
        )
      };
    }
    if (
      !isUndefined(general.hotCpuProfilingSlowburnThresholdPercent) &&
      !(
        typeof general.hotCpuProfilingSlowburnThresholdPercent === "number" &&
        Number.isFinite(general.hotCpuProfilingSlowburnThresholdPercent) &&
        general.hotCpuProfilingSlowburnThresholdPercent >= 1 &&
        general.hotCpuProfilingSlowburnThresholdPercent <= 100
      )
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_general_hotCpuProfilingSlowburnThresholdPercent",
          "settings:write: general.hotCpuProfilingSlowburnThresholdPercent must be a number from 1 to 100"
        )
      };
    }
    if (
      !isUndefined(general.hotCpuProfilingCaptureHeapSnapshot) &&
      !isBoolean(general.hotCpuProfilingCaptureHeapSnapshot)
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_general_hotCpuProfilingCaptureHeapSnapshot",
          "settings:write: general.hotCpuProfilingCaptureHeapSnapshot must be a boolean"
        )
      };
    }
    if (
      !isUndefined(general.hotCpuProfilingHeapSnapshotLimit) &&
      !(
        typeof general.hotCpuProfilingHeapSnapshotLimit === "number" &&
        Number.isInteger(general.hotCpuProfilingHeapSnapshotLimit) &&
        general.hotCpuProfilingHeapSnapshotLimit >= 1 &&
        general.hotCpuProfilingHeapSnapshotLimit <= 3
      )
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_general_hotCpuProfilingHeapSnapshotLimit",
          "settings:write: general.hotCpuProfilingHeapSnapshotLimit must be an integer from 1 to 3"
        )
      };
    }
    if (!isUndefined(general.launchAtLogin) && !isBoolean(general.launchAtLogin)) {
      return {
        ok: false,
        error: validationError(
          "invalid_general_launchAtLogin",
          "settings:write: general.launchAtLogin must be a boolean"
        )
      };
    }
  }

  if (p.appearance !== undefined) {
    if (
      typeof p.appearance !== "object" ||
      p.appearance === null ||
      Array.isArray(p.appearance)
    ) {
      return {
        ok: false,
        error: validationError("invalid_appearance", "settings:write: appearance must be an object")
      };
    }
    const appearance = p.appearance as Record<string, unknown>;
    // theme: literal union enforced via the shared type guard so the
    // accepted values track APPEARANCE_THEMES exactly.
    if (!isUndefined(appearance.theme) && !isAppearanceTheme(appearance.theme)) {
      return {
        ok: false,
        error: validationError(
          "invalid_appearance_theme",
          "settings:write: appearance.theme must be \"system\", \"dark\", or \"light\""
        )
      };
    }
  }

  if (p.updates !== undefined) {
    if (
      typeof p.updates !== "object" ||
      p.updates === null ||
      Array.isArray(p.updates)
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_updates",
          "settings:write: updates must be an object"
        )
      };
    }
    const updates = p.updates as Record<string, unknown>;
    if (
      !isUndefined(updates.channel) &&
      updates.channel !== "latest" &&
      updates.channel !== "prerelease"
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_updates_channel",
          "settings:write: updates.channel must be \"latest\" or \"prerelease\""
        )
      };
    }
  }

  if (p.storage !== undefined) {
    if (
      typeof p.storage !== "object" ||
      p.storage === null ||
      Array.isArray(p.storage)
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_storage",
          "settings:write: storage must be an object"
        )
      };
    }
    const storage = p.storage as Record<string, unknown>;
    if (
      !isUndefined(storage.filenameTimestampZone) &&
      storage.filenameTimestampZone !== "local" &&
      storage.filenameTimestampZone !== "utc"
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_storage_filenameTimestampZone",
          "settings:write: storage.filenameTimestampZone must be \"local\" or \"utc\""
        )
      };
    }
  }

  if (p.recording !== undefined) {
    if (
      typeof p.recording !== "object" ||
      p.recording === null ||
      Array.isArray(p.recording)
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_recording",
          "settings:write: recording must be an object"
        )
      };
    }
    const recording = p.recording as Record<string, unknown>;
    for (const key of [
      "includeSystemAudio",
      "includeMicrophone",
      "screenCapturePrompted"
    ] as const) {
      const v = recording[key];
      if (isUndefined(v)) continue;
      if (!isBoolean(v)) {
        return {
          ok: false,
          error: validationError(
            `invalid_recording_${key}`,
            `settings:write: recording.${key} must be a boolean`
          )
        };
      }
    }
    if (
      !isUndefined(recording.lastRoutedPermissionFingerprint) &&
      !isString(recording.lastRoutedPermissionFingerprint)
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_recording_fingerprint",
          "settings:write: recording.lastRoutedPermissionFingerprint must be a string"
        )
      };
    }
  }

  if (p.editor !== undefined) {
    const editorErr = validateEditorPatch(p.editor);
    if (editorErr !== null) return { ok: false, error: editorErr };
  }

  if (p.library !== undefined) {
    const libraryErr = validateLibraryPatch(p.library);
    if (libraryErr !== null) return { ok: false, error: libraryErr };
  }

  if (p.experimental !== undefined) {
    const experimentalErr = validateExperimentalPatch(p.experimental);
    if (experimentalErr !== null) return { ok: false, error: experimentalErr };
  }

  return { ok: true, value: patch as SettingsPatch };
}

/** Validate the `experimental` section of a settings patch — the opt-in
 *  feature-gate booleans. Reject anything non-boolean so a forged file /
 *  HTTP-RPC payload can't smuggle a non-boolean into a flag. */
function validateExperimentalPatch(raw: unknown): PwrSnapError | null {
  if (!isObject(raw)) {
    return validationError(
      "invalid_experimental",
      "settings:write: experimental must be an object"
    );
  }
  for (const key of ["processSplit", "dpiAwareExport", "allowRetinaExport"] as const) {
    if (!isUndefined(raw[key]) && !isBoolean(raw[key])) {
      return validationError(
        `invalid_experimental_${key}`,
        `settings:write: experimental.${key} must be a boolean`
      );
    }
  }
  return null;
}

/** Validate the library section of a settings patch. Currently
 *  exposes a single nested object: `detailRail`. Symmetric with
 *  `validateEditorPatch`. */
function validateLibraryPatch(raw: unknown): PwrSnapError | null {
  if (!isObject(raw)) {
    return validationError(
      "invalid_library",
      "settings:write: library must be an object"
    );
  }
  if (raw.detailRail !== undefined) {
    if (!isObject(raw.detailRail)) {
      return validationError(
        "invalid_library_detailRail",
        "settings:write: library.detailRail must be an object"
      );
    }
    const dr = raw.detailRail;
    if (!isUndefined(dr.pinned) && !isBoolean(dr.pinned)) {
      return validationError(
        "invalid_library_detailRail_pinned",
        "settings:write: library.detailRail.pinned must be a boolean"
      );
    }
    if (!isUndefined(dr.lastSelectedTab) && !isLibrarySidebarTab(dr.lastSelectedTab)) {
      return validationError(
        "invalid_library_detailRail_lastSelectedTab",
        `settings:write: library.detailRail.lastSelectedTab must be one of ${LIBRARY_SIDEBAR_TABS.join(
          "/"
        )}`
      );
    }
  }
  if (!isUndefined(raw.gridZoom)) {
    if (
      typeof raw.gridZoom !== "number" ||
      !Number.isFinite(raw.gridZoom) ||
      raw.gridZoom < GRID_ZOOM_MIN ||
      raw.gridZoom > GRID_ZOOM_MAX
    ) {
      return validationError(
        "invalid_library_gridZoom",
        `settings:write: library.gridZoom must be a number in [${GRID_ZOOM_MIN}, ${GRID_ZOOM_MAX}]`
      );
    }
  }
  return null;
}

// ---- settings:write — ai.chat sub-validator ----------------------------
//
// Validates the `ai.chat` deep-partial patch shape. Enforces:
//   • userGuidance ≤ 8 KB (8192 chars) — bigger inputs balloon every
//     subsequent chat turn's L2 prompt + risk hitting Codex's input cap
//   • sensitiveDataPatterns array ≤ 32 rows; each name ≤ 64; each
//     pattern ≤ 512; names unique; pattern must `new RegExp(...)`
//     successfully (RE2 migration tracked separately — see plan §F4 H1)
//   • defaultRedactionStyle ∈ REDACTION_STYLES
//   • firstLaunchBannerDismissed is a boolean
//   • Secret-shape sniff on both `userGuidance` and each pattern's
//     `pattern` string: blocks save if input contains a substring that
//     looks like a real credential (sk-…, ghp_…, AKIA…, JWT, etc.)
//     (plan §F4 H3)
//
// Returns null on success or a structured error on first failure.

/** Tight, anchored shapes for the most common real-secret formats. The
 *  goal is to block obvious paste-mistakes (the user typing "my key is
 *  sk-AAAA...") at save time — NOT to catch every secret in the world.
 *  Patterns intentionally match SHAPE without claiming validity (no
 *  Luhn check, no JWT signature verify). Plan §F4 H3 lists the full
 *  shape catalog; if a row here over-matches, prefer false-positive
 *  (block save with a clear message) over silent leak. */
const SECRET_SHAPE_PROBES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "OpenAI key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub PAT (classic)", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "GitHub PAT (fine-grained)", re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  { name: "Stripe live key", re: /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{24,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ }
];

/** Run the sniff against a single string. Returns the first probe name
 *  that matches, or null if clean. */
function sniffSecretShape(input: string): string | null {
  for (const probe of SECRET_SHAPE_PROBES) {
    if (probe.re.test(input)) return probe.name;
  }
  return null;
}

function validateChatPatch(raw: unknown): PwrSnapError | null {
  if (!isObject(raw)) {
    return validationError(
      "invalid_ai_chat",
      "settings:write: ai.chat must be an object"
    );
  }
  if (!isUndefined(raw.userGuidance)) {
    if (!isString(raw.userGuidance)) {
      return validationError(
        "invalid_ai_chat_userGuidance",
        "settings:write: ai.chat.userGuidance must be a string"
      );
    }
    if (raw.userGuidance.length > 8192) {
      return validationError(
        "invalid_ai_chat_userGuidance",
        `settings:write: ai.chat.userGuidance is ${raw.userGuidance.length} chars (max 8192)`
      );
    }
    const hit = sniffSecretShape(raw.userGuidance);
    if (hit !== null) {
      return validationError(
        "secret_shape_in_userGuidance",
        `settings:write: ai.chat.userGuidance contains what looks like a real ${hit}. Don't paste real secrets here — see Settings → AI → Chat for guidance on the shape-only pattern format.`
      );
    }
  }
  if (!isUndefined(raw.defaultRedactionStyle)) {
    if (!isRedactionStyle(raw.defaultRedactionStyle)) {
      return validationError(
        "invalid_ai_chat_defaultRedactionStyle",
        `settings:write: ai.chat.defaultRedactionStyle must be one of ${REDACTION_STYLES.join("/")}`
      );
    }
  }
  if (!isUndefined(raw.firstLaunchBannerDismissed)) {
    if (!isBoolean(raw.firstLaunchBannerDismissed)) {
      return validationError(
        "invalid_ai_chat_firstLaunchBannerDismissed",
        "settings:write: ai.chat.firstLaunchBannerDismissed must be a boolean"
      );
    }
  }
  if (!isUndefined(raw.sensitiveDataPatterns)) {
    if (!Array.isArray(raw.sensitiveDataPatterns)) {
      return validationError(
        "invalid_ai_chat_sensitiveDataPatterns",
        "settings:write: ai.chat.sensitiveDataPatterns must be an array"
      );
    }
    if (raw.sensitiveDataPatterns.length > 32) {
      return validationError(
        "invalid_ai_chat_sensitiveDataPatterns",
        `settings:write: ai.chat.sensitiveDataPatterns has ${raw.sensitiveDataPatterns.length} rows (max 32)`
      );
    }
    const seenNames = new Set<string>();
    for (let i = 0; i < raw.sensitiveDataPatterns.length; i += 1) {
      const row = raw.sensitiveDataPatterns[i];
      if (!isObject(row)) {
        return validationError(
          "invalid_ai_chat_sensitiveDataPatterns_row",
          `settings:write: ai.chat.sensitiveDataPatterns[${i}] must be an object`
        );
      }
      const rawName = row.name;
      const rawPattern = row.pattern;
      if (!isString(rawName) || rawName.length === 0 || rawName.length > 64) {
        return validationError(
          "invalid_ai_chat_pattern_name",
          `settings:write: ai.chat.sensitiveDataPatterns[${i}].name must be a non-empty string ≤ 64 chars`
        );
      }
      if (!isString(rawPattern) || rawPattern.length === 0 || rawPattern.length > 512) {
        return validationError(
          "invalid_ai_chat_pattern_value",
          `settings:write: ai.chat.sensitiveDataPatterns[${i}].pattern must be a non-empty string ≤ 512 chars`
        );
      }
      if (seenNames.has(rawName)) {
        return validationError(
          "duplicate_ai_chat_pattern_name",
          `settings:write: ai.chat.sensitiveDataPatterns[${i}].name "${rawName}" is duplicated`
        );
      }
      seenNames.add(rawName);
      // Compile-check via JS RegExp. RE2 (linear-time, no
      // catastrophic backtracking) is the long-term backstop — see
      // plan §F4 H1 + §F12. JS RegExp lacks ReDoS protection, so the
      // accept-side here remains permissive; we narrow once `re2` is
      // wired into the workspace native bindings.
      try {
        new RegExp(rawPattern);
      } catch (err) {
        return validationError(
          "invalid_ai_chat_pattern_regex",
          `settings:write: ai.chat.sensitiveDataPatterns[${i}].pattern doesn't compile as a regex: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      const hit = sniffSecretShape(rawPattern);
      if (hit !== null) {
        return validationError(
          "secret_shape_in_pattern",
          `settings:write: ai.chat.sensitiveDataPatterns[${i}].pattern looks like a real ${hit}. Patterns describe SHAPE, not real values — use placeholders like "sk-XXXXXXXX" or "\\d{3}-\\d{2}-\\d{4}".`
        );
      }
    }
  }
  return null;
}

// ---- settings:write — ai.defaults sub-validator ------------------------
//
// Validates the per-surface default provider / model / reasoning patch.
// Each surface key (libraryChat / sizzleChat / enrichment) is optional;
// within a surface each leaf is optional too. Semantics:
//   • provider —
//       · CHAT surfaces (libraryChat / sizzleChat): a BACKEND selector.
//         Allowed values are "" (clear → Codex default), "codex", or
//         "acp:<known-id>" where <known-id> is a built-in ACP agent id.
//         An unknown `acp:` id (or any other non-codex token) is rejected.
//       · ENRICHMENT: a free-form Codex `modelProvider` token (shape-only;
//         Codex rejects unavailable providers at runtime). The enrichment
//         one-shot client is Codex-only, so ACP selectors don't apply.
//   • model — string. Empty string is the explicit "clear → use Codex
//     default" sentinel and is allowed; non-empty values must look like a
//     Codex id token. Cap 120 chars.
//   • reasoning — must be a member of AI_REASONING_EFFORTS.
// Unknown surface keys are rejected so a buggy/forged renderer can't
// stash arbitrary blobs under `ai.defaults`.

/** Shape check for a Codex provider/model token. Same alphabet as
 *  `isCodexCaptionModel` but tolerant of the empty-string clear
 *  sentinel (checked separately by the caller). */
function isAiTokenShape(value: string): boolean {
  return value.length > 0 && value.length <= 120 && /^[A-Za-z0-9._:/-]+$/.test(value);
}

/** Shape check for a per-surface `model` id. UNLIKE Codex tokens, an ACP
 *  agent's model id is an OPAQUE, agent-advertised string we persist verbatim
 *  and only feed back to its `session/set_model` — never a path/shell/Codex
 *  token. Qwen alone advertises ids like `coder-model(qwen-oauth)` and
 *  `qwen3.6-plus(openai)` (parentheses), so the Codex-narrow alphabet wrongly
 *  rejects them and the picker snaps back to Default. Accept any printable,
 *  reasonably-bounded string; reject only control characters and absurd
 *  lengths. */
function isAiModelTokenShape(value: string): boolean {
  // Codex's alphabet plus the bracket family ACP agents use in their ids
  // (Qwen: `coder-model(qwen-oauth)`). Still rejects whitespace and other
  // junk — a model id with spaces is almost always a pasted LABEL, not an id.
  return value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._:/()[\]-]+$/.test(value);
}

/** Validate a surface's `provider` backend selector (every surface now —
 *  Library / Sizzle chat AND enrichment). Accepts "" / "codex" /
 *  "acp:<known-id>"; rejects unknown `acp:` ids and any other free-text token
 *  (those used to map to a Codex modelProvider; surfaces no longer do). */
function validateChatSurfaceProvider(
  surface: string,
  value: string
): PwrSnapError | null {
  if (value === "" || value === "codex") return null;
  if (value.startsWith("acp:")) {
    const id = value.slice("acp:".length);
    if (isBuiltInAcpAgentId(id)) return null;
    return validationError(
      `invalid_ai_defaults_${surface}_provider`,
      `settings:write: ai.defaults.${surface}.provider has unknown ACP agent ${JSON.stringify(id)} (allowed: ${BUILT_IN_ACP_AGENT_IDS.join("/")})`
    );
  }
  return validationError(
    `invalid_ai_defaults_${surface}_provider`,
    `settings:write: ai.defaults.${surface}.provider must be "", "codex", or "acp:<${BUILT_IN_ACP_AGENT_IDS.join("|")}>" (got ${JSON.stringify(value)})`
  );
}

function validateAiSurfaceDefault(surface: string, raw: unknown): PwrSnapError | null {
  if (!isObject(raw)) {
    return validationError(
      `invalid_ai_defaults_${surface}`,
      `settings:write: ai.defaults.${surface} must be an object`
    );
  }
  // `provider` is a BACKEND selector for EVERY surface now — chat surfaces
  // (Library / Sizzle) and enrichment alike: "" / "codex" → Codex, "acp:<id>"
  // → an enabled ACP agent. (Enrichment used to be a free-text Codex
  // modelProvider token; the Settings → AI consolidation unified all three.)
  if (!isUndefined(raw.provider)) {
    if (!isString(raw.provider)) {
      return validationError(
        `invalid_ai_defaults_${surface}_provider`,
        `settings:write: ai.defaults.${surface}.provider must be a string`
      );
    }
    const provErr = validateChatSurfaceProvider(surface, raw.provider);
    if (provErr !== null) return provErr;
  }
  for (const key of ["model"] as const) {
    const v = raw[key];
    if (isUndefined(v)) continue;
    if (!isString(v)) {
      return validationError(
        `invalid_ai_defaults_${surface}_${key}`,
        `settings:write: ai.defaults.${surface}.${key} must be a string`
      );
    }
    // Empty string clears the field (→ Codex / agent default); always allowed.
    // The model id is an opaque, possibly-ACP token (e.g. Qwen's
    // `qwen3.6-plus(openai)`), so use the tolerant model-token shape — NOT the
    // Codex-narrow alphabet, which would reject valid agent model ids.
    if (v.length > 0 && !isAiModelTokenShape(v)) {
      return validationError(
        `invalid_ai_defaults_${surface}_${key}`,
        `settings:write: ai.defaults.${surface}.${key} must be a non-empty model id under 200 chars with no control characters (got ${JSON.stringify(v)})`
      );
    }
  }
  // reasoning: empty string is the clear sentinel (→ Codex default); any
  // non-empty value must be a recognized effort.
  if (
    !isUndefined(raw.reasoning) &&
    raw.reasoning !== "" &&
    !isAiReasoningEffort(raw.reasoning)
  ) {
    return validationError(
      `invalid_ai_defaults_${surface}_reasoning`,
      `settings:write: ai.defaults.${surface}.reasoning must be "" or one of ${AI_REASONING_EFFORTS.join("/")}`
    );
  }
  return null;
}

function validateAiDefaultsPatch(raw: unknown): PwrSnapError | null {
  if (!isObject(raw)) {
    return validationError(
      "invalid_ai_defaults",
      "settings:write: ai.defaults must be an object"
    );
  }
  for (const key of Object.keys(raw)) {
    if (!(AI_SURFACE_IDS as readonly string[]).includes(key)) {
      return validationError(
        "invalid_ai_defaults_surface",
        `settings:write: ai.defaults has unknown surface "${key}" (allowed: ${AI_SURFACE_IDS.join("/")})`
      );
    }
  }
  for (const surface of AI_SURFACE_IDS) {
    const block = raw[surface];
    if (isUndefined(block)) continue;
    const err = validateAiSurfaceDefault(surface, block);
    if (err !== null) return err;
  }
  return null;
}

// ---- settings:write — ai.acp sub-validator -----------------------------
//
// Validates the ACP-agent enablement patch. `enabledAgentIds` (when
// present) must be an array of recognized built-in ACP agent ids — a
// forged / buggy renderer can't enable an unknown agent or stash a
// non-string blob in the set. An empty array is allowed (clear all).
// The array is capped at the number of known agents (de-dup is handled
// at merge / parse time).

/** Max accepted length for an agent path (override / selected). Generous but
 *  bounded so a forged patch can't stash a huge blob. */
const ACP_AGENT_PATH_MAX = 4096;

function validateAcpPatch(raw: unknown): PwrSnapError | null {
  if (!isObject(raw)) {
    return validationError(
      "invalid_ai_acp",
      "settings:write: ai.acp must be an object"
    );
  }
  if (!isUndefined(raw.enabledAgentIds)) {
    if (!Array.isArray(raw.enabledAgentIds)) {
      return validationError(
        "invalid_ai_acp_enabledAgentIds",
        "settings:write: ai.acp.enabledAgentIds must be an array"
      );
    }
    if (raw.enabledAgentIds.length > BUILT_IN_ACP_AGENT_IDS.length) {
      return validationError(
        "invalid_ai_acp_enabledAgentIds",
        `settings:write: ai.acp.enabledAgentIds has ${raw.enabledAgentIds.length} ids (max ${BUILT_IN_ACP_AGENT_IDS.length})`
      );
    }
    for (const id of raw.enabledAgentIds) {
      if (!isBuiltInAcpAgentId(id)) {
        return validationError(
          "invalid_ai_acp_agent_id",
          `settings:write: ai.acp.enabledAgentIds has unknown agent ${JSON.stringify(id)} (allowed: ${BUILT_IN_ACP_AGENT_IDS.join("/")})`
        );
      }
    }
  }
  if (!isUndefined(raw.agents)) {
    const agentsErr = validateAcpAgentsPatch(raw.agents);
    if (agentsErr) return agentsErr;
  }
  return null;
}

/** Validate `ai.acp.agents` — a map of built-in agent id → `{ overridePath?,
 *  selectedPath? }`. Rejects unknown ids and non-string / oversize path leaves.
 *  `null` / `""` are allowed (they clear the leaf at merge time). */
function validateAcpAgentsPatch(raw: unknown): PwrSnapError | null {
  if (!isObject(raw)) {
    return validationError(
      "invalid_ai_acp_agents",
      "settings:write: ai.acp.agents must be an object"
    );
  }
  for (const [id, value] of Object.entries(raw)) {
    if (!isBuiltInAcpAgentId(id)) {
      return validationError(
        "invalid_ai_acp_agent_id",
        `settings:write: ai.acp.agents has unknown agent ${JSON.stringify(id)} (allowed: ${BUILT_IN_ACP_AGENT_IDS.join("/")})`
      );
    }
    if (!isObject(value)) {
      return validationError(
        "invalid_ai_acp_agent_pref",
        `settings:write: ai.acp.agents.${id} must be an object`
      );
    }
    for (const key of ["overridePath", "selectedPath"] as const) {
      const leaf = (value as Record<string, unknown>)[key];
      if (isUndefined(leaf) || leaf === null) continue;
      if (typeof leaf !== "string") {
        return validationError(
          "invalid_ai_acp_agent_pref",
          `settings:write: ai.acp.agents.${id}.${key} must be a string or null`
        );
      }
      if (leaf.length > ACP_AGENT_PATH_MAX) {
        return validationError(
          "invalid_ai_acp_agent_pref",
          `settings:write: ai.acp.agents.${id}.${key} exceeds ${ACP_AGENT_PATH_MAX} chars`
        );
      }
    }
  }
  return null;
}

// ---- settings:write — editor sub-validator -----------------------------
//
// Pulled into a separate function because the editor block is materially
// deeper than the other sections (toolStyles → per-kind → per-field).
// Returns null on success or a structured error on first failure.

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isToolColor(value: unknown): boolean {
  // Accept named tokens OR any string (the popover's "Custom…" affordance
  // writes free-form hex via the OS color picker; renderer maps tokens to
  // var(--swatch-*) at paint and passes strings through unchanged).
  return typeof value === "string" || isColorToken(value);
}

function isToolSizePreset(value: unknown): boolean {
  return (
    value === "auto" ||
    value === "small" ||
    value === "medium" ||
    value === "large" ||
    value === "x-large" ||
    isFiniteNumber(value)
  );
}

function validateArrowStyle(raw: Record<string, unknown>): PwrSnapError | null {
  if (!isUndefined(raw.color) && !isToolColor(raw.color)) {
    return validationError("invalid_editor_arrow_color", "settings:write: editor.toolStyles.arrow.color must be a color token or string");
  }
  if (!isUndefined(raw.thickness) && !isToolSizePreset(raw.thickness)) {
    return validationError("invalid_editor_arrow_thickness", "settings:write: editor.toolStyles.arrow.thickness must be auto/small/medium/large/x-large or a finite number");
  }
  if (!isUndefined(raw.endStyle)) {
    const v = raw.endStyle;
    if (v !== "filled-triangle" && v !== "open-triangle" && v !== "line" && v !== "dot") {
      return validationError("invalid_editor_arrow_endStyle", "settings:write: editor.toolStyles.arrow.endStyle must be one of filled-triangle/open-triangle/line/dot");
    }
  }
  if (!isUndefined(raw.stemStyle)) {
    const v = raw.stemStyle;
    if (v !== "solid" && v !== "dashed" && v !== "dotted") {
      return validationError("invalid_editor_arrow_stemStyle", "settings:write: editor.toolStyles.arrow.stemStyle must be solid/dashed/dotted");
    }
  }
  if (!isUndefined(raw.doubleEnded) && !isBoolean(raw.doubleEnded)) {
    return validationError("invalid_editor_arrow_doubleEnded", "settings:write: editor.toolStyles.arrow.doubleEnded must be a boolean");
  }
  return null;
}

function validateTextStyle(raw: Record<string, unknown>): PwrSnapError | null {
  if (!isUndefined(raw.color) && !isToolColor(raw.color)) {
    return validationError("invalid_editor_text_color", "settings:write: editor.toolStyles.text.color must be a color token or string");
  }
  if (!isUndefined(raw.fontSize) && !isToolSizePreset(raw.fontSize)) {
    return validationError("invalid_editor_text_fontSize", "settings:write: editor.toolStyles.text.fontSize must be auto/small/medium/large/x-large or a finite number");
  }
  if (!isUndefined(raw.weight)) {
    const v = raw.weight;
    if (v !== "regular" && v !== "bold") {
      return validationError("invalid_editor_text_weight", "settings:write: editor.toolStyles.text.weight must be regular or bold");
    }
  }
  return null;
}

function validateShapeStyle(raw: Record<string, unknown>): PwrSnapError | null {
  if (!isUndefined(raw.color) && !isToolColor(raw.color)) {
    return validationError("invalid_editor_shape_color", "settings:write: editor.toolStyles.shape.color must be a color token or string");
  }
  if (!isUndefined(raw.thickness) && !isToolSizePreset(raw.thickness)) {
    return validationError("invalid_editor_shape_thickness", "settings:write: editor.toolStyles.shape.thickness must be auto/small/medium/large/x-large or a finite number");
  }
  if (!isUndefined(raw.filled) && !isBoolean(raw.filled)) {
    return validationError("invalid_editor_shape_filled", "settings:write: editor.toolStyles.shape.filled must be a boolean");
  }
  if (!isUndefined(raw.shape)) {
    const v = raw.shape;
    if (
      v !== "rect" &&
      v !== "square" &&
      v !== "circle" &&
      v !== "oval" &&
      v !== "parallelogram"
    ) {
      return validationError("invalid_editor_shape_kind", "settings:write: editor.toolStyles.shape.shape must be rect/square/circle/oval/parallelogram");
    }
  }
  if (!isUndefined(raw.skewDeg) && !isFiniteNumber(raw.skewDeg)) {
    return validationError("invalid_editor_shape_skewDeg", "settings:write: editor.toolStyles.shape.skewDeg must be a finite number");
  }
  return null;
}

function validateBlurStyle(raw: Record<string, unknown>): PwrSnapError | null {
  if (!isUndefined(raw.mode)) {
    const v = raw.mode;
    if (v !== "gaussian" && v !== "pixelate" && v !== "redact") {
      return validationError("invalid_editor_blur_mode", "settings:write: editor.toolStyles.blur.mode must be gaussian/pixelate/redact");
    }
  }
  if (!isUndefined(raw.radius)) {
    if (!isObject(raw.radius)) {
      return validationError("invalid_editor_blur_radius", "settings:write: editor.toolStyles.blur.radius must be an object");
    }
    const r = raw.radius;
    if (r.mode === "auto") {
      // ok; no value field allowed but we ignore extras
    } else if (r.mode === "px") {
      if (!isFiniteNumber(r.value) || r.value <= 0) {
        return validationError("invalid_editor_blur_radius_value", "settings:write: editor.toolStyles.blur.radius.value must be a positive finite number when mode is \"px\"");
      }
    } else {
      return validationError("invalid_editor_blur_radius_mode", "settings:write: editor.toolStyles.blur.radius.mode must be \"auto\" or \"px\"");
    }
  }
  return null;
}

function validateHighlightStyle(raw: Record<string, unknown>): PwrSnapError | null {
  if (!isUndefined(raw.color) && !isToolColor(raw.color)) {
    return validationError("invalid_editor_highlight_color", "settings:write: editor.toolStyles.highlight.color must be a color token or string");
  }
  if (!isUndefined(raw.opacity)) {
    if (
      !isFiniteNumber(raw.opacity) ||
      raw.opacity < 0 ||
      raw.opacity > MAX_HIGHLIGHT_OPACITY
    ) {
      return validationError(
        "invalid_editor_highlight_opacity",
        `settings:write: editor.toolStyles.highlight.opacity must be a finite number in [0,${MAX_HIGHLIGHT_OPACITY}]`
      );
    }
  }
  if (!isUndefined(raw.blend)) {
    const v = raw.blend;
    if (v !== "multiply" && v !== "screen" && v !== "overlay") {
      return validationError("invalid_editor_highlight_blend", "settings:write: editor.toolStyles.highlight.blend must be multiply/screen/overlay");
    }
  }
  return null;
}

function validateEditorPatch(rawEditor: unknown): PwrSnapError | null {
  if (!isObject(rawEditor)) {
    return validationError("invalid_editor", "settings:write: editor must be an object");
  }
  const editor = rawEditor;

  if (editor.toolStyles !== undefined) {
    if (!isObject(editor.toolStyles)) {
      return validationError("invalid_editor_toolStyles", "settings:write: editor.toolStyles must be an object");
    }
    const ts = editor.toolStyles;
    const perKind = [
      ["arrow", validateArrowStyle],
      ["text", validateTextStyle],
      ["shape", validateShapeStyle],
      ["blur", validateBlurStyle],
      ["highlight", validateHighlightStyle]
    ] as const;
    for (const [key, validator] of perKind) {
      const block = ts[key];
      if (block === undefined) continue;
      if (!isObject(block)) {
        return validationError(`invalid_editor_${key}`, `settings:write: editor.toolStyles.${key} must be an object`);
      }
      const err = validator(block);
      if (err !== null) return err;
    }
  }

  if (editor.coachmarks !== undefined) {
    if (!isObject(editor.coachmarks)) {
      return validationError("invalid_editor_coachmarks", "settings:write: editor.coachmarks must be an object");
    }
    if (!isUndefined(editor.coachmarks.stoplightSeen) && !isBoolean(editor.coachmarks.stoplightSeen)) {
      return validationError("invalid_editor_stoplightSeen", "settings:write: editor.coachmarks.stoplightSeen must be a boolean");
    }
  }

  if (editor.matchingText !== undefined) {
    if (!isObject(editor.matchingText)) {
      return validationError("invalid_editor_matchingText", "settings:write: editor.matchingText must be an object");
    }
    if (!isUndefined(editor.matchingText.enabled) && !isBoolean(editor.matchingText.enabled)) {
      return validationError("invalid_editor_matchingText_enabled", "settings:write: editor.matchingText.enabled must be a boolean");
    }
  }

  if (editor.sidebar !== undefined) {
    if (!isObject(editor.sidebar)) {
      return validationError("invalid_editor_sidebar", "settings:write: editor.sidebar must be an object");
    }
    if (!isUndefined(editor.sidebar.pinned) && !isBoolean(editor.sidebar.pinned)) {
      return validationError("invalid_editor_sidebar_pinned", "settings:write: editor.sidebar.pinned must be a boolean");
    }
    if (
      !isUndefined(editor.sidebar.lastSelectedPanel) &&
      !isEditorSidebarPanel(editor.sidebar.lastSelectedPanel)
    ) {
      return validationError("invalid_editor_sidebar_panel", "settings:write: editor.sidebar.lastSelectedPanel must be info/chat/toolConfig/help");
    }
  }

  return null;
}

// ---- settings:refreshCodexDiscovery ----

export function validateRefreshCodexDiscovery(
  req: { force?: boolean | undefined }
): ValidationResult<{ force: boolean | undefined }> {
  if (req.force !== undefined && typeof req.force !== "boolean") {
    return {
      ok: false,
      error: validationError(
        "invalid_force",
        "settings:refreshCodexDiscovery: force must be a boolean"
      )
    };
  }
  return { ok: true, value: { force: req.force } };
}

// ---- settings:replaceSecret ----

const MAX_SECRET_BYTES = 65_536;

export function validateReplaceSecret(
  req: { name: DesktopSettingsSecretName; value: string }
): ValidationResult<{ name: DesktopSettingsSecretName; value: string }> {
  if (!isKnownSecretName(req.name)) {
    return {
      ok: false,
      error: validationError(
        "invalid_secret_name",
        `settings:replaceSecret: unknown secret name (got ${JSON.stringify(req.name)})`
      )
    };
  }
  if (typeof req.value !== "string") {
    return {
      ok: false,
      error: validationError(
        "invalid_secret_value",
        "settings:replaceSecret: value must be a string"
      )
    };
  }
  // Clearing routes through `settings:clearSecret`; an empty string
  // here is almost certainly a renderer bug. Reject explicitly.
  if (req.value.length === 0) {
    return {
      ok: false,
      error: validationError(
        "empty_secret",
        "settings:replaceSecret: empty value (use settings:clearSecret to clear)"
      )
    };
  }
  if (req.value.length > MAX_SECRET_BYTES) {
    return {
      ok: false,
      error: validationError(
        "secret_too_large",
        `settings:replaceSecret: value exceeds ${MAX_SECRET_BYTES} chars`
      )
    };
  }
  return { ok: true, value: { name: req.name, value: req.value } };
}

// ---- settings:clearSecret ----

export function validateClearSecret(
  req: { name: DesktopSettingsSecretName }
): ValidationResult<{ name: DesktopSettingsSecretName }> {
  if (!isKnownSecretName(req.name)) {
    return {
      ok: false,
      error: validationError(
        "invalid_secret_name",
        `settings:clearSecret: unknown secret name (got ${JSON.stringify(req.name)})`
      )
    };
  }
  return { ok: true, value: { name: req.name } };
}

function isKnownSecretName(value: unknown): value is DesktopSettingsSecretName {
  return (
    typeof value === "string" &&
    (KNOWN_SECRET_NAMES as readonly string[]).includes(value)
  );
}

// ---- codex:profiles:create / codex:profiles:login ----
//
// A Codex auth profile maps 1:1 to a `~/.codex/profiles/<name>` directory,
// so the name must be filesystem-safe. We reuse the kit's
// `normalizeProfileName` to canonicalize free-text input (lowercasing,
// stripping diacritics, collapsing illegal runs to `-`) and reject only when
// nothing usable survives. The validator returns the NORMALIZED name so the
// handler operates on the same canonical form the kit's discovery / create
// helpers expect. An empty input means "System default" only for `login`;
// `create` rejects empty (you can't create the default home from here).

const MAX_PROFILE_NAME_INPUT = 64;

/** Validate + normalize a profile-name input. `allowEmpty` permits the ""
 *  sentinel (System default) — used by `login`; `create` sets it false. */
function validateProfileNameInput(
  verb: string,
  raw: unknown,
  options: { allowEmpty: boolean }
): ValidationResult<{ name: string }> {
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: validationError(
        "invalid_profile_name",
        `${verb}: name must be a string`
      )
    };
  }
  if (raw.length > MAX_PROFILE_NAME_INPUT) {
    return {
      ok: false,
      error: validationError(
        "profile_name_too_long",
        `${verb}: name is ${raw.length} chars (max ${MAX_PROFILE_NAME_INPUT})`
      )
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    if (options.allowEmpty) return { ok: true, value: { name: "" } };
    return {
      ok: false,
      error: validationError(
        "empty_profile_name",
        `${verb}: name must contain at least one letter or number`
      )
    };
  }
  const normalized = normalizeProfileName(trimmed);
  if (normalized.length === 0 || !isValidProfileName(normalized)) {
    return {
      ok: false,
      error: validationError(
        "invalid_profile_name",
        `${verb}: "${trimmed}" is not a usable profile name — use letters, numbers, "-", or "_"`
      )
    };
  }
  return { ok: true, value: { name: normalized } };
}

export function validateCodexProfileCreate(
  req: { name: string }
): ValidationResult<{ name: string }> {
  return validateProfileNameInput("codex:profiles:create", req?.name, {
    allowEmpty: false
  });
}

export function validateCodexProfileLogin(
  req: { name: string }
): ValidationResult<{ name: string }> {
  return validateProfileNameInput("codex:profiles:login", req?.name, {
    allowEmpty: true
  });
}
