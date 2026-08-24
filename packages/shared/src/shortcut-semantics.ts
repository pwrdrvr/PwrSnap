/**
 * The desktop platforms whose shortcut conventions PwrSnap presents.
 *
 * Keep this narrower than `NodeJS.Platform`: PwrSnap's renderer should never
 * silently fall back to macOS glyphs merely because a test double omitted the
 * preload platform or a future host reports an unfamiliar value.
 */
export type ShortcutPlatform = "darwin" | "win32" | "linux";

export type ShortcutModifier =
  | "CommandOrControl"
  | "Command"
  | "Control"
  | "Alt"
  | "AltGr"
  | "Shift"
  | "Super";

export type AcceleratorNormalizationErrorCode =
  | "empty_token"
  | "modifier_only"
  | "missing_modifier"
  | "unsupported_modifier"
  | "duplicate_modifier"
  | "conflicting_modifier"
  | "unexpected_key"
  | "unsupported_key";

export type AcceleratorNormalizationResult =
  | {
      ok: true;
      input: string;
      normalized: string;
      modifiers: ShortcutModifier[];
      key: string | null;
      unbound: boolean;
    }
  | {
      ok: false;
      input: string;
      code: AcceleratorNormalizationErrorCode;
      message: string;
    };

export type AcceleratorDisplay = {
  keys: string[];
  text: string;
  accessibleText: string;
};

/**
 * Coerce the preload/main platform value into the supported presentation set.
 * Unknown or absent platforms deliberately use non-Mac conventions so they
 * cannot leak Command glyphs into Windows-like/test environments.
 */
export function shortcutPlatformFromString(value: unknown): ShortcutPlatform {
  if (value === "darwin" || value === "win32" || value === "linux") return value;
  return "linux";
}

export function shortcutPlatformDisplayName(platform: ShortcutPlatform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
  }
}

/**
 * Parse and canonicalize an Electron accelerator used as a global shortcut.
 * Empty input is the explicit unbound value. Non-empty accelerators require a
 * modifier plus one supported key.
 */
export function normalizeAccelerator(
  input: string,
  platform: ShortcutPlatform
): AcceleratorNormalizationResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return {
      ok: true,
      input,
      normalized: "",
      modifiers: [],
      key: null,
      unbound: true
    };
  }

  const rawParts = trimmed.split("+").map((part) => part.trim());
  if (rawParts.some((part) => part === "")) {
    return normalizationError(
      input,
      "empty_token",
      "Use the named Plus key instead of an empty accelerator segment."
    );
  }

  const modifierParts = rawParts.slice(0, -1);
  const rawKey = rawParts.at(-1)!;
  if (modifierForToken(rawKey) !== null) {
    return normalizationError(input, "modifier_only", "Add a non-modifier key to the shortcut.");
  }
  if (modifierParts.length === 0) {
    return normalizationError(
      input,
      "missing_modifier",
      "Global shortcuts must include at least one modifier."
    );
  }

  const modifiers: ShortcutModifier[] = [];
  for (const rawModifier of modifierParts) {
    const modifier = modifierForToken(rawModifier);
    if (modifier === null) {
      return normalizationError(
        input,
        "unexpected_key",
        `Only the final accelerator segment may be a key: ${rawModifier}.`
      );
    }
    if (!modifierSupportedOnPlatform(rawModifier, modifier, platform)) {
      return normalizationError(
        input,
        "unsupported_modifier",
        `${rawModifier} is not a supported ${shortcutPlatformDisplayName(platform)} shortcut modifier.`
      );
    }
    if (modifiers.includes(modifier)) {
      return normalizationError(
        input,
        "duplicate_modifier",
        `${rawModifier} repeats a shortcut modifier.`
      );
    }
    modifiers.push(modifier);
  }

  const conflict = conflictingModifierMessage(modifiers, platform);
  if (conflict !== null) {
    return normalizationError(input, "conflicting_modifier", conflict);
  }

  const key = normalizeAcceleratorKey(rawKey);
  if (key === null) {
    return normalizationError(input, "unsupported_key", `${rawKey} is not a supported shortcut key.`);
  }

  const orderedModifiers = orderModifiers(modifiers, platform);
  return {
    ok: true,
    input,
    normalized: [...orderedModifiers, key].join("+"),
    modifiers: orderedModifiers,
    key,
    unbound: false
  };
}

/** Alias for callers that prefer parse terminology. */
export function parseAccelerator(
  input: string,
  platform: ShortcutPlatform
): AcceleratorNormalizationResult {
  return normalizeAccelerator(input, platform);
}

/** Canonicalize portable aliases to the concrete modifier Electron owns on
 * one host. AltGr remains explicit for recording/persistence even though the
 * physical-equivalence helper below treats it as Ctrl+Alt. */
export function canonicalAcceleratorForPlatform(
  input: string,
  platform: ShortcutPlatform
): AcceleratorNormalizationResult {
  const parsed = normalizeAccelerator(input, platform);
  if (!parsed.ok || parsed.unbound) return parsed;
  const modifiers = parsed.modifiers.map((modifier): ShortcutModifier => {
    if (platform === "darwin") {
      return modifier === "CommandOrControl" || modifier === "Super"
        ? "Command"
        : modifier;
    }
    return modifier === "CommandOrControl" ? "Control" : modifier;
  });
  return {
    ...parsed,
    modifiers,
    normalized: [...modifiers, parsed.key!].join("+")
  };
}

/**
 * Compare accelerators by the physical chord they resolve to on one host.
 * This deliberately collapses portable aliases (CommandOrControl), Meta/Super
 * on macOS, and Windows/Linux AltGr's physical Ctrl+Alt representation. It is
 * intended for default/migration/customization decisions, not presentation.
 */
export function acceleratorsAreEquivalent(
  left: string,
  right: string,
  platform: ShortcutPlatform
): boolean {
  const leftIdentity = physicalAcceleratorIdentity(left, platform);
  const rightIdentity = physicalAcceleratorIdentity(right, platform);
  return leftIdentity !== null && leftIdentity === rightIdentity;
}

function physicalAcceleratorIdentity(
  accelerator: string,
  platform: ShortcutPlatform
): string | null {
  const parsed = normalizeAccelerator(accelerator, platform);
  if (!parsed.ok) return null;
  if (parsed.unbound) return "";

  const modifiers = new Set<ShortcutModifier>();
  for (const modifier of parsed.modifiers) {
    if (platform === "darwin") {
      modifiers.add(
        modifier === "CommandOrControl" || modifier === "Super"
          ? "Command"
          : modifier
      );
      continue;
    }
    if (modifier === "CommandOrControl") {
      modifiers.add("Control");
    } else if (modifier === "AltGr") {
      modifiers.add("Control");
      modifiers.add("Alt");
    } else {
      modifiers.add(modifier);
    }
  }
  return [...orderModifiers([...modifiers], platform), parsed.key!].join("+");
}

export function acceleratorToDisplay(
  accelerator: string,
  platform: ShortcutPlatform
): AcceleratorDisplay {
  const tokens = displayTokens(accelerator);
  const keys = tokens.map((token) => displayToken(token, platform));
  const accessibleKeys = tokens.map((token) => accessibleToken(token, platform));
  return {
    keys,
    text: keys.join(platform === "darwin" ? "" : "+"),
    accessibleText: accessibleKeys.join(" plus ")
  };
}

export function acceleratorToDisplayKeys(
  accelerator: string,
  platform: ShortcutPlatform
): string[] {
  return acceleratorToDisplay(accelerator, platform).keys;
}

export function acceleratorToDisplayText(
  accelerator: string,
  platform: ShortcutPlatform
): string {
  return acceleratorToDisplay(accelerator, platform).text;
}

export function acceleratorToAccessibleText(
  accelerator: string,
  platform: ShortcutPlatform
): string {
  return acceleratorToDisplay(accelerator, platform).accessibleText;
}

function normalizationError(
  input: string,
  code: AcceleratorNormalizationErrorCode,
  message: string
): AcceleratorNormalizationResult {
  return { ok: false, input, code, message };
}

function modifierForToken(token: string): ShortcutModifier | null {
  switch (token.toLowerCase()) {
    case "commandorcontrol":
    case "cmdorctrl":
      return "CommandOrControl";
    case "command":
    case "cmd":
      return "Command";
    case "control":
    case "ctrl":
      return "Control";
    case "alt":
    case "option":
      return "Alt";
    case "altgr":
      return "AltGr";
    case "shift":
      return "Shift";
    case "super":
    case "meta":
      return "Super";
    default:
      return null;
  }
}

function modifierSupportedOnPlatform(
  raw: string,
  modifier: ShortcutModifier,
  platform: ShortcutPlatform
): boolean {
  const lower = raw.toLowerCase();
  if (modifier === "Command") return platform === "darwin";
  if (lower === "option") return platform === "darwin";
  if (modifier === "AltGr") return platform !== "darwin";
  return true;
}

function conflictingModifierMessage(
  modifiers: readonly ShortcutModifier[],
  platform: ShortcutPlatform
): string | null {
  const has = (modifier: ShortcutModifier): boolean => modifiers.includes(modifier);
  if (has("AltGr") && (has("Alt") || has("Control") || has("CommandOrControl"))) {
    return "AltGr cannot be combined with Ctrl or Alt in a global shortcut.";
  }
  if (platform === "darwin") {
    const commandCount = ["CommandOrControl", "Command", "Super"].filter((modifier) =>
      has(modifier as ShortcutModifier)
    ).length;
    if (commandCount > 1) return "The shortcut repeats the Command modifier.";
  } else if (has("CommandOrControl") && has("Control")) {
    return "The shortcut repeats the Ctrl modifier.";
  }
  return null;
}

function orderModifiers(
  modifiers: readonly ShortcutModifier[],
  platform: ShortcutPlatform
): ShortcutModifier[] {
  const order: readonly ShortcutModifier[] =
    platform === "darwin"
      ? ["CommandOrControl", "Command", "Super", "Control", "Alt", "Shift"]
      : ["CommandOrControl", "Control", "Super", "AltGr", "Alt", "Shift"];
  return order.filter((modifier) => modifiers.includes(modifier));
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  plus: "Plus",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  return: "Return",
  enter: "Return",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  escape: "Escape",
  esc: "Escape",
  volumeup: "VolumeUp",
  volumedown: "VolumeDown",
  volumemute: "VolumeMute",
  medianexttrack: "MediaNextTrack",
  mediaprevioustrack: "MediaPreviousTrack",
  mediastop: "MediaStop",
  mediaplaypause: "MediaPlayPause",
  printscreen: "PrintScreen"
};

function normalizeAcceleratorKey(raw: string): string | null {
  if (/^num[0-9]$/i.test(raw)) return raw.toLowerCase();
  if (/^num(add|dec|div|mult|sub)$/i.test(raw)) return raw.toLowerCase();
  const named = NAMED_KEYS[raw.toLowerCase()];
  if (named !== undefined) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (raw.length !== 1 || raw === "+") return null;
  const code = raw.charCodeAt(0);
  if (code < 33 || code > 126) return null;
  return /[a-z]/i.test(raw) ? raw.toUpperCase() : raw;
}

function displayTokens(accelerator: string): string[] {
  const trimmed = accelerator.trim();
  if (trimmed === "") return [];
  return trimmed
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

function displayToken(token: string, platform: ShortcutPlatform): string {
  const lower = token.toLowerCase();
  switch (lower) {
    case "commandorcontrol":
    case "cmdorctrl":
      return platform === "darwin" ? "⌘" : "Ctrl";
    case "command":
    case "cmd":
      return platform === "darwin" ? "⌘" : "Unsupported";
    case "control":
    case "ctrl":
      return platform === "darwin" ? "⌃" : "Ctrl";
    case "alt":
    case "option":
      return platform === "darwin" ? "⌥" : "Alt";
    case "altgr":
      return "AltGr";
    case "shift":
      return platform === "darwin" ? "⇧" : "Shift";
    case "super":
    case "meta":
      return platform === "darwin" ? "⌘" : platform === "win32" ? "Win" : "Super";
    case "return":
    case "enter":
      return platform === "darwin" ? "⏎" : "Enter";
    case "esc":
    case "escape":
      return "Esc";
    case "tab":
      return "Tab";
    case "space":
      return "Space";
    case "backspace":
      return platform === "darwin" ? "⌫" : "Backspace";
    case "delete":
      return platform === "darwin" ? "⌦" : "Delete";
    case "plus":
      return platform === "darwin" ? "+" : "Plus";
    case "left":
    case "arrowleft":
      return "←";
    case "right":
    case "arrowright":
      return "→";
    case "up":
    case "arrowup":
      return "↑";
    case "down":
    case "arrowdown":
      return "↓";
    default:
      if (/^num[0-9]$/.test(lower)) return `Num ${lower.at(-1)!}`;
      if (lower === "numadd") return "Num +";
      if (lower === "numdec") return "Num .";
      if (lower === "numdiv") return "Num /";
      if (lower === "nummult") return "Num *";
      if (lower === "numsub") return "Num -";
      if (platform === "win32" && (token.includes("⌘") || /cmd/i.test(token))) {
        return "Unsupported";
      }
      return token.length === 1 ? token.toUpperCase() : token;
  }
}

function accessibleToken(token: string, platform: ShortcutPlatform): string {
  const lower = token.toLowerCase();
  switch (lower) {
    case "commandorcontrol":
    case "cmdorctrl":
      return platform === "darwin" ? "Command" : "Control";
    case "command":
    case "cmd":
      return platform === "darwin" ? "Command" : "Unsupported key";
    case "control":
    case "ctrl":
      return "Control";
    case "alt":
    case "option":
      return platform === "darwin" ? "Option" : "Alt";
    case "altgr":
      return "Alt Graph";
    case "shift":
      return "Shift";
    case "super":
    case "meta":
      return platform === "darwin" ? "Command" : platform === "win32" ? "Windows" : "Super";
    case "return":
    case "enter":
      return "Enter";
    case "esc":
    case "escape":
      return "Escape";
    case "plus":
      return "Plus";
    case "left":
    case "arrowleft":
      return "Left Arrow";
    case "right":
    case "arrowright":
      return "Right Arrow";
    case "up":
    case "arrowup":
      return "Up Arrow";
    case "down":
    case "arrowdown":
      return "Down Arrow";
    default:
      if (/^num[0-9]$/.test(lower)) return `Number Pad ${lower.at(-1)!}`;
      if (lower === "numadd") return "Number Pad Plus";
      if (lower === "numdec") return "Number Pad Decimal";
      if (lower === "numdiv") return "Number Pad Divide";
      if (lower === "nummult") return "Number Pad Multiply";
      if (lower === "numsub") return "Number Pad Minus";
      if (platform === "win32" && (token.includes("⌘") || /cmd/i.test(token))) {
        return "Unsupported key";
      }
      return token.length === 1 ? token.toUpperCase() : token;
  }
}
