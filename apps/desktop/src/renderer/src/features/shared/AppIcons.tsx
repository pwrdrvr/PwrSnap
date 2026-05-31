import { useState, type ReactElement } from "react";

// AppId is the renderer's app key. For known apps it's a curated
// short id (`"slack"`, `"vscode"`, …); for unknown apps it's the
// lowercased CFBundleIdentifier as captured by macOS
// (`"com.spotify.client"`, `"com.hnc.discord"`). The set is open —
// any new bundle id captured at runtime gets a procedural initials
// icon and shows up in the Library sidebar with its real app name.
export type AppId = string;

/**
 * Generic reverse-DNS prefixes and tail words that appear in bundle
 * ids but carry no app-distinctive information. Filtered out before
 * picking the "longest meaningful segment" for procedural initials.
 */
const GENERIC_BUNDLE_SEGMENTS = new Set<string>([
  "com",
  "org",
  "net",
  "io",
  "co",
  "app",
  "ai",
  "us",
  "ru",
  "client",
  "desktop",
  "mac",
  "macos"
]);

/**
 * Take up-to-2-letter initials from a free-form string.
 *
 * Splits on EXPLICIT separators (whitespace, dots, dashes,
 * underscores, slashes) first. Only when the input is a single
 * mashed-together token without separators does it fall back to a
 * camelCase split — otherwise `"GitHub Desktop"` would over-split
 * into `["Git", "Hub", "Desktop"]` and yield `"GH"` instead of the
 * `"GD"` a reader expects.
 *
 * Examples: `"Microsoft Edge"` → `"ME"`, `"GitHub Desktop"` → `"GD"`,
 * `"Activity Monitor"` → `"AM"`, `"Spotify"` → `"SP"`,
 * `"iCloudDrive"` → `"IC"` (single mashed token, camelCase split).
 */
export function tokenInitials(s: string): string {
  const explicit = s.split(/[\s._\-/]+/).filter((t) => t.length > 0);
  if (explicit.length === 0) return s.slice(0, 2).toUpperCase();
  if (explicit.length > 1) {
    return (explicit[0]![0]! + explicit[1]![0]!).toUpperCase();
  }
  // Single token — try a camelCase split for cases like "iCloudDrive".
  const camel = explicit[0]!.split(/(?=[A-Z])/).filter((t) => t.length > 0);
  if (camel.length > 1) {
    return (camel[0]![0]! + camel[1]![0]!).toUpperCase();
  }
  return explicit[0]!.slice(0, 2).toUpperCase();
}

/**
 * Compute the up-to-2-letter label for the procedural fallback icon.
 *
 * - When a captured user-facing `name` is available, take initials
 *   from it directly: `"Microsoft Edge"` → `"ME"`, `"Spotify"` →
 *   `"SP"`, `"Activity Monitor"` → `"AM"`.
 * - Otherwise, treat `fallback` as a reverse-DNS bundle id and pick
 *   the longest non-generic dotted segment to derive initials from:
 *   `"com.spotify.client"` → segment `"spotify"` → `"SP"`,
 *   `"com.hnc.discord"` → segment `"discord"` → `"DI"`,
 *   `"com.apple.activitymonitor"` → segment `"activitymonitor"` →
 *   `"AC"` (the lossy case — without an `appName`, we can't recover
 *   the camelCase split).
 *
 * Always returns at least one uppercase letter; never empty.
 */
export function initialsFor(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return tokenInitials(trimmed);
  }
  const segments = fallback
    .split(".")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !GENERIC_BUNDLE_SEGMENTS.has(s.toLowerCase()));
  if (segments.length === 0) {
    return fallback.length > 0 ? fallback.slice(0, 2).toUpperCase() : "?";
  }
  segments.sort((a, b) => b.length - a.length);
  return tokenInitials(segments[0]!);
}

function ProceduralIcon({ size, label }: { size: number; label: string }): ReactElement {
  // Glyph rendered in `currentColor` so it inherits the copper accent
  // from `.ps-app-tag__tile` (and the dot color in `.psl__app-dot`).
  // viewBox is 0 0 24 24 to match the extracted-icon render box;
  // intrinsic size comes from `width`/`height` attrs, not font-size
  // units.
  const fontSize = label.length >= 2 ? 11 : 14;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontWeight={700}
        fontSize={fontSize}
        letterSpacing="-0.02em"
        fill="currentColor"
      >
        {label}
      </text>
    </svg>
  );
}

/** Bundle ids appear in the wild as `com.apple.Terminal`,
 *  `com.tinyspeck.slackmacgap`, `com.openai.codex`. We allow letters,
 *  digits, dot, underscore, dash — the same alphabet the Swift helper
 *  and protocol parser accept. Anything else can't possibly resolve
 *  to a real bundle, so we skip the network round-trip entirely. */
function isResolvableBundleId(bundleId: string | undefined): bundleId is string {
  if (bundleId === undefined) return false;
  if (bundleId.length === 0 || bundleId.length > 256) return false;
  return /^[A-Za-z0-9._-]+$/.test(bundleId);
}

/** Clipboard glyph for paste-from-clipboard captures
 *  (`com.pwrsnap.clipboard` synthetic bundle id). Visually distinct
 *  from the procedural / extracted-app icons so the user immediately
 *  reads "this came from the clipboard, not from a running app." */
function ClipboardGlyph({ size }: { size: number }): ReactElement {
  // Pad slightly so the clipboard fits inside the same tile chrome
  // the extracted-icon path gets (~80% of tile, matching the
  // AppIcon's `renderSize = min(22, max(size + 5, 14))` ratio).
  const renderSize = Math.min(22, Math.max(size + 5, 14));
  return (
    <svg
      className="ps-app-icon-img"
      width={renderSize}
      height={renderSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block", color: "var(--text-secondary)" }}
    >
      {/* Clipboard body */}
      <rect x="6" y="4" width="12" height="17" rx="2" />
      {/* Clip / clasp at the top */}
      <rect x="9" y="2" width="6" height="4" rx="1" />
      {/* Two horizontal lines hinting at "pasted content" */}
      <line x1="9" y1="11" x2="15" y2="11" />
      <line x1="9" y1="15" x2="13" y2="15" />
    </svg>
  );
}

function FallbackGlyph({
  app,
  size,
  name
}: {
  app: AppId;
  size: number;
  name: string | undefined;
}): ReactElement {
  // No facsimile lookup — when the OS-extracted app icon isn't
  // available (no installed .app, helper error, null bundle id), we
  // render the two-letter procedural initials derived from the
  // captured app name (or, as a last resort, the bundle id segments).
  return <ProceduralIcon size={size} label={initialsFor(name, app)} />;
}

/** PwrSnap-synthetic bundle ids that don't correspond to a real
 *  installed macOS app. Renderer skips the `pwrsnap-app-icon://`
 *  fetch entirely for these and renders a domain-specific glyph.
 *  Keep this set in lockstep with `SYNTHETIC_BUNDLE_IDS` in
 *  `apps/desktop/src/main/app-icons/app-icon-cache.ts`. */
const CLIPBOARD_BUNDLE_ID = "com.pwrsnap.clipboard";

export function AppIcon({
  app,
  size = 11,
  name,
  bundleId
}: {
  app: AppId;
  size?: number;
  /** Captured user-facing app name. Used for procedural-icon initials
   *  when the OS-extracted icon isn't available. */
  name?: string | undefined;
  /** Real CFBundleIdentifier of the source app, when known. Triggers
   *  the full-color extract-from-installed-.app path via the
   *  `pwrsnap-app-icon://` protocol. Falls back to the procedural
   *  initials glyph below on miss (app not installed locally,
   *  helper error, etc.). */
  bundleId?: string | undefined;
}): ReactElement {
  const [imageFailed, setImageFailed] = useState(false);

  // PwrSnap-synthetic clipboard bundle id — there's no installed .app
  // to extract from, so render a clipboard glyph directly. Skipping
  // the `pwrsnap-app-icon://` fetch saves an IPC roundtrip + the
  // failed-image-handler render flicker.
  if (bundleId === CLIPBOARD_BUNDLE_ID) {
    return <ClipboardGlyph size={size} />;
  }

  if (isResolvableBundleId(bundleId) && !imageFailed) {
    // Real bundle icons get a small density bump over the procedural
    // initials glyph size — macOS app icons carry their own rounded
    // shape and bezel, so 11px in an 18px tile feels lost. The CSS rule below
    // (`.psl__nav-icon:has(> .ps-app-icon-img)`) also drops the
    // copper tile chrome so the icon stands on its own. Cap at 22 to
    // keep AppTag's tight 18×18 tile happy when this is invoked at
    // size=10.
    const renderSize = Math.min(22, Math.max(size + 5, 14));
    return (
      <img
        className="ps-app-icon-img"
        src={`pwrsnap-app-icon://r/${bundleId}`}
        width={renderSize}
        height={renderSize}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setImageFailed(true)}
        style={{ display: "block", objectFit: "contain" }}
      />
    );
  }

  return <FallbackGlyph app={app} size={size} name={name} />;
}

type AppTagSize = "sm" | "md" | "lg";

export function AppTag({
  app,
  name,
  size = "md",
  bundleId
}: {
  app: AppId;
  name: string;
  size?: AppTagSize;
  bundleId?: string | undefined;
}) {
  const cls = "ps-app-tag" + (size === "sm" ? " is-sm" : size === "lg" ? " is-lg" : "");
  const iconSize = size === "sm" ? 10 : size === "lg" ? 13 : 11;
  return (
    <span className={cls} title={`Captured from ${name}`}>
      <span className="ps-app-tag__tile">
        <AppIcon app={app} size={iconSize} name={name} bundleId={bundleId} />
      </span>
      <span className="ps-app-tag__name">{name}</span>
    </span>
  );
}
