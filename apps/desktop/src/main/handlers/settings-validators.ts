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
  CODEX_CAPTION_MODELS,
  isAppearanceTheme,
  isCodexCaptionModel,
  isColorToken,
  isEditorSidebarPanel,
  isSettingsPage
} from "@pwrsnap/shared";
import type {
  DesktopSettingsSecretName,
  PwrSnapError,
  SettingsPage,
  SettingsPatch
} from "@pwrsnap/shared";
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
    // captionModel: literal union (CODEX_CAPTION_MODELS). Reject
    // unknown IDs so a buggy renderer can't pin a model name the
    // spawn-Codex path doesn't accept.
    if (!isUndefined(codex.captionModel) && !isCodexCaptionModel(codex.captionModel)) {
      return {
        ok: false,
        error: validationError(
          "invalid_codex_captionModel",
          `settings:write: codex.captionModel must be one of ${JSON.stringify(CODEX_CAPTION_MODELS)}`
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
  }

  if (p.hotkeys !== undefined) {
    if (typeof p.hotkeys !== "object" || p.hotkeys === null || Array.isArray(p.hotkeys)) {
      return {
        ok: false,
        error: validationError("invalid_hotkeys", "settings:write: hotkeys must be an object")
      };
    }
    const hotkeys = p.hotkeys as Record<string, unknown>;
    for (const key of ["quickCapture", "region", "window", "videoCapture"] as const) {
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

  if (p.experimental !== undefined) {
    if (
      typeof p.experimental !== "object" ||
      p.experimental === null ||
      Array.isArray(p.experimental)
    ) {
      return {
        ok: false,
        error: validationError(
          "invalid_experimental",
          "settings:write: experimental must be an object"
        )
      };
    }
    const exp = p.experimental as Record<string, unknown>;
    if (!isUndefined(exp.v2FileFormat) && !isBoolean(exp.v2FileFormat)) {
      return {
        ok: false,
        error: validationError(
          "invalid_experimental_v2FileFormat",
          "settings:write: experimental.v2FileFormat must be a boolean"
        )
      };
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
    for (const key of ["includeSystemAudio", "includeMicrophone"] as const) {
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

  return { ok: true, value: patch as SettingsPatch };
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
    isFiniteNumber(value)
  );
}

function validateArrowStyle(raw: Record<string, unknown>): PwrSnapError | null {
  if (!isUndefined(raw.color) && !isToolColor(raw.color)) {
    return validationError("invalid_editor_arrow_color", "settings:write: editor.toolStyles.arrow.color must be a color token or string");
  }
  if (!isUndefined(raw.thickness) && !isToolSizePreset(raw.thickness)) {
    return validationError("invalid_editor_arrow_thickness", "settings:write: editor.toolStyles.arrow.thickness must be auto/small/medium/large or a finite number");
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
    return validationError("invalid_editor_text_fontSize", "settings:write: editor.toolStyles.text.fontSize must be auto/small/medium/large or a finite number");
  }
  if (!isUndefined(raw.weight)) {
    const v = raw.weight;
    if (v !== "regular" && v !== "bold") {
      return validationError("invalid_editor_text_weight", "settings:write: editor.toolStyles.text.weight must be regular or bold");
    }
  }
  return null;
}

function validateRectStyle(raw: Record<string, unknown>): PwrSnapError | null {
  if (!isUndefined(raw.color) && !isToolColor(raw.color)) {
    return validationError("invalid_editor_rect_color", "settings:write: editor.toolStyles.rect.color must be a color token or string");
  }
  if (!isUndefined(raw.thickness) && !isToolSizePreset(raw.thickness)) {
    return validationError("invalid_editor_rect_thickness", "settings:write: editor.toolStyles.rect.thickness must be auto/small/medium/large or a finite number");
  }
  if (!isUndefined(raw.filled) && !isBoolean(raw.filled)) {
    return validationError("invalid_editor_rect_filled", "settings:write: editor.toolStyles.rect.filled must be a boolean");
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
    if (!isFiniteNumber(raw.opacity) || raw.opacity < 0 || raw.opacity > 1) {
      return validationError("invalid_editor_highlight_opacity", "settings:write: editor.toolStyles.highlight.opacity must be a finite number in [0,1]");
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
      ["rect", validateRectStyle],
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
