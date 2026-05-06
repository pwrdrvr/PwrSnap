import type { ReactElement } from "react";

// AppId is the renderer's app key. For known apps it's a curated
// short id (`"slack"`, `"vscode"`, …); for unknown apps it's the
// lowercased CFBundleIdentifier as captured by macOS
// (`"com.spotify.client"`, `"com.hnc.discord"`). The set is open —
// any new bundle id captured at runtime gets a procedural initials
// icon and shows up in the Library sidebar with its real app name.
export type AppId = string;

const KNOWN_APP_ICONS: Record<string, (s: number) => ReactElement> = {
  telegram: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor">
      <path d="M21.4 3.4 2.6 10.6c-1 .4-1 1.7 0 2l4.7 1.6 1.7 5.5c.2.7 1.1 1 1.6.4l2.5-2.4 4.6 3.4c.7.5 1.7.1 1.9-.7l3.3-15.2c.2-1-.7-1.8-1.5-1.4ZM10 14.7l-.4 3.6-1.2-3.9 9-7.8L10 14.7Z" />
    </svg>
  ),
  excel: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor">
      <path d="M3 4h13v3H3V4Zm0 4h13v3H3V8Zm0 4h13v3H3v-3Zm0 4h13v3H3v-3ZM17 4h4v16h-4l3-8-3-8Z" />
    </svg>
  ),
  vscode: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor">
      <path d="m17.5 2-9.7 9L3 7.5 1 9v6l2 1.5L7.8 13l9.7 9L23 19V5l-5.5-3ZM6 12l4-3.5L16 4v16l-6-4.5L6 12Z" />
    </svg>
  ),
  chrome: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 9h9M9.4 13.5 4.5 6M14.6 13.5 9.5 21" />
    </svg>
  ),
  figma: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor">
      <path d="M9 3h3v6H9a3 3 0 1 1 0-6Zm3 0h3a3 3 0 1 1 0 6h-3V3Zm0 6h3a3 3 0 1 1-3 3V9Zm-3 0h3v6H9a3 3 0 1 1 0-6Zm0 6h3v3a3 3 0 1 1-3-3Z" />
    </svg>
  ),
  slack: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor">
      <rect x="3" y="9.5" width="6" height="2.5" rx="1.25" />
      <rect x="3" y="13.5" width="2.5" height="6" rx="1.25" />
      <rect x="9.5" y="3" width="2.5" height="6" rx="1.25" />
      <rect x="13.5" y="3" width="6" height="2.5" rx="1.25" />
      <rect x="15" y="9.5" width="6" height="2.5" rx="1.25" />
      <rect x="18.5" y="13.5" width="2.5" height="6" rx="1.25" />
      <rect x="9.5" y="15" width="2.5" height="6" rx="1.25" />
      <rect x="13.5" y="18.5" width="6" height="2.5" rx="1.25" />
    </svg>
  ),
  terminal: (s) => (
    <svg
      viewBox="0 0 24 24"
      width={s}
      height={s}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="m6 9 4 3-4 3M12 15h6" />
    </svg>
  ),
  notion: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M8 7v10M8 7l8 10M16 7v10" strokeWidth="1.6" />
    </svg>
  ),
  safari: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5.5-5.5 2 2-5.5 5.5-2Z" fill="currentColor" />
    </svg>
  ),
  zoom: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor">
      <path d="M3 8h11a2 2 0 0 1 2 2v6H5a2 2 0 0 1-2-2V8Zm14 3 4-2.5v7L17 13v-2Z" />
    </svg>
  ),
  linear: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 14 14 3M3 18 18 3M3 22 22 3M9 22 22 9M15 22l7-7" />
    </svg>
  ),
  github: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor">
      <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 3 .8.1-.7.4-1.1.6-1.4-2.2-.2-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.8v2.6c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
    </svg>
  ),
  preview: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="4" y="3" width="13" height="18" rx="1.5" />
      <path d="M14 3v4h4M8 12l3 3 5-6" />
    </svg>
  ),
  finder: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4h18v16H3z" />
      <circle cx="9" cy="9.5" r=".8" fill="currentColor" />
      <circle cx="15" cy="9.5" r=".8" fill="currentColor" />
      <path d="M8 14c1.5 1.5 6.5 1.5 8 0M12 4v6" />
    </svg>
  ),
  any: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M9 9h6v6H9z" fill="currentColor" />
    </svg>
  )
};

/**
 * Compute up-to-2-letter initials for the procedural fallback icon.
 * Prefers a captured user-facing app name ("Microsoft Edge" → "ME",
 * "Discord" → "D"); falls back to the bundle-id-derived app key
 * with the leading reverse-DNS prefix stripped ("com.hnc.discord" →
 * "D"). Word boundaries are spaces, dots, dashes, underscores, and
 * camelCase transitions.
 */
function initialsFor(name: string | undefined, fallback: string): string {
  const raw = name !== undefined && name.trim().length > 0 ? name.trim() : fallback;
  // Strip leading reverse-DNS segments so "com.spotify.client" yields
  // "Spotify" before tokenization, not "Com".
  const stripped = raw.replace(/^[a-z][a-z0-9]*(\.[a-z0-9]+)+\.([A-Za-z0-9-]+)$/, "$2");
  const cleaned = stripped.length > 0 ? stripped : raw;
  const tokens = cleaned.split(/[\s._\-/]+|(?=[A-Z])/).filter((t) => t.length > 0);
  if (tokens.length === 0) return cleaned.slice(0, 2).toUpperCase();
  if (tokens.length === 1) return tokens[0]!.slice(0, 2).toUpperCase();
  return (tokens[0]![0]! + tokens[1]![0]!).toUpperCase();
}

function ProceduralIcon({ size, label }: { size: number; label: string }): ReactElement {
  // Glyph rendered in `currentColor` so it inherits the copper accent
  // from `.ps-app-tag__tile` (and the dot color in `.psl__app-dot`).
  // viewBox is 0 0 24 24 to match the hand-drawn icon set; intrinsic
  // size comes from `width`/`height` attrs, not font-size units.
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

export function AppIcon({
  app,
  size = 11,
  name
}: {
  app: AppId;
  size?: number;
  /** Captured user-facing app name. Used for procedural-icon initials
   *  when `app` doesn't have a hand-drawn glyph. */
  name?: string;
}): ReactElement {
  const known = KNOWN_APP_ICONS[app];
  if (known !== undefined) return known(size);
  return <ProceduralIcon size={size} label={initialsFor(name, app)} />;
}

type AppTagSize = "sm" | "md" | "lg";

export function AppTag({
  app,
  name,
  size = "md"
}: {
  app: AppId;
  name: string;
  size?: AppTagSize;
}) {
  const cls = "ps-app-tag" + (size === "sm" ? " is-sm" : size === "lg" ? " is-lg" : "");
  const iconSize = size === "sm" ? 10 : size === "lg" ? 13 : 11;
  return (
    <span className={cls} title={`Captured from ${name}`}>
      <span className="ps-app-tag__tile">
        <AppIcon app={app} size={iconSize} name={name} />
      </span>
      <span className="ps-app-tag__name">{name}</span>
    </span>
  );
}
