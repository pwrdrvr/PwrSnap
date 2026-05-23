/* eslint-disable */
// PwrSnap App Icons & PsAppTag
//
// Two icon sets:
//   APP_ICONS         — original monochrome glyphs (amber, currentColor)
//                       Used by the PwrSnap brand mark, the in-content chrome
//                       slot on focus/reel stage, and anywhere a tinted glyph
//                       belongs inside the dark amber UI vocabulary.
//
//   APP_BUNDLE_ICONS  — recognizable colored facsimiles of macOS .app bundle
//                       icons. Used in the Library sidebar (Source App rail)
//                       and inside source-app chips on capture tiles — the
//                       provenance signal where a real-app feel reads better
//                       than a tinted glyph.
//
// Brand-mark exception: pwrsnap stays in APP_ICONS only — see CLAUDE.md, the
// stacked-rounded-squares mark is the canonical PwrSnap glyph everywhere.

// ============================================================
// Monochrome glyph set (tinted, currentColor)
// ============================================================
const APP_ICONS = {
  pwrsnap: (s) => (
    // Brand mark: stack of three offset rounded squares. CANONICAL — see CLAUDE.md.
    // Front is BOTTOM-LEFT (bright), back is TOP-RIGHT (deep). Do not reverse.
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" strokeLinejoin="round" strokeLinecap="round" style={{ display: "block" }} aria-label="PwrSnap">
      <rect x="8"   y="3"   width="13" height="13" rx="2.5" style={{ stroke: "var(--accent-deep)" }} strokeWidth="1.5"/>
      <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" style={{ stroke: "color-mix(in oklch, var(--accent-deep), var(--accent))" }} strokeWidth="1.5"/>
      <rect x="3"   y="8"   width="13" height="13" rx="2.5" style={{ stroke: "var(--accent)" }} strokeWidth="1.6"/>
    </svg>
  ),
  any: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="4" y="4" width="16" height="16" rx="3"/>
      <path d="M9 9h6v6H9z" fill="currentColor"/>
    </svg>
  ),
};

// ============================================================
// Colored bundle icons — facsimile of the real .app bundle artwork
// Each is a 24×24 viewBox stylized version with real brand colors.
// These are SUBSTITUTIONS for design specs; in shipping product these
// would be loaded from each .app's actual Resources/AppIcon.icns.
// ============================================================

// Helper: rounded-square app icon container
const SQ = ({ fill, stroke, children }) => (
  <>
    <rect x="2" y="2" width="20" height="20" rx="4.6" fill={fill} stroke={stroke || "none"} strokeWidth="0.5"/>
    {children}
  </>
);

const APP_BUNDLE_ICONS = {
  // 1Password — blue squircle, white keyhole
  "1password": (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#0a6cff"/>
      <circle cx="12" cy="12" r="4.6" fill="none" stroke="#fff" strokeWidth="1.5"/>
      <rect x="11.1" y="12.4" width="1.8" height="3" rx="0.6" fill="#fff"/>
    </svg>
  ),

  // App Store — blue gradient circle, white "A" of strokes
  appstore: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <defs>
        <linearGradient id="appstore-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1eb5ff"/>
          <stop offset="1" stopColor="#0a7ad4"/>
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="10" fill="url(#appstore-bg)"/>
      <path d="M8 16.2 12 8l4 8.2M9.3 14h5.4" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="8" cy="16.2" r="0.6" fill="#fff"/>
    </svg>
  ),

  // Chrome — multicolor wheel
  chrome: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <circle cx="12" cy="12" r="10" fill="#fff"/>
      <path d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0-4.33 2.5L3.34 7A10 10 0 0 1 12 2Z" fill="#ea4335"/>
      <path d="M3.34 7 7.67 9.5a5 5 0 0 0 0 5L3.34 17A10 10 0 0 1 3.34 7Z" fill="#fbbc04"/>
      <path d="M3.34 17 7.67 14.5A5 5 0 0 0 12 17h8.66A10 10 0 0 1 3.34 17Z" fill="#34a853"/>
      <circle cx="12" cy="12" r="4" fill="#4285f4"/>
      <circle cx="12" cy="12" r="2.4" fill="#fff"/>
    </svg>
  ),

  // Claude — coral/orange burst with cream surround
  claude: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#d97757"/>
      <path d="M9 8.5 11.4 14h-1.2L9.6 12.6H7.4L6.8 14H5.7L8 8.5h1Zm-1.4 3.2h1.6L8.4 9.9l-.8 1.8ZM13 8.5h1l2.3 5.5h-1.1l-.6-1.4h-2.2l-.6 1.4H10.7L13 8.5Zm-.2 3.2H14.4l-.8-1.8-.8 1.8Z" fill="#fff"/>
    </svg>
  ),

  // Clipboard — dark gray clipboard
  clipboard: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#3a3a3a"/>
      <rect x="7" y="6.5" width="10" height="12" rx="1.3" fill="#e8e4dd"/>
      <rect x="9.5" y="5" width="5" height="2.4" rx="0.7" fill="#888" stroke="#3a3a3a" strokeWidth="0.5"/>
      <path d="M9 11h6M9 13.5h6M9 16h3.5" stroke="#3a3a3a" strokeWidth="0.7" strokeLinecap="round"/>
    </svg>
  ),

  // Codex — dark with stylized brackets/sparkle
  codex: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#0a0a0a" stroke="#2a2a2a"/>
      <path d="M9 8 6 12l3 4M15 8l3 4-3 4" fill="none" stroke="#f5efe3" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="12" cy="12" r="1.1" fill="#f5efe3"/>
    </svg>
  ),

  // Electron — atom orbits
  electron: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#2b2e3a"/>
      <ellipse cx="12" cy="12" rx="6.5" ry="2.6" fill="none" stroke="#9feaf9" strokeWidth="0.9"/>
      <ellipse cx="12" cy="12" rx="6.5" ry="2.6" fill="none" stroke="#9feaf9" strokeWidth="0.9" transform="rotate(60 12 12)"/>
      <ellipse cx="12" cy="12" rx="6.5" ry="2.6" fill="none" stroke="#9feaf9" strokeWidth="0.9" transform="rotate(-60 12 12)"/>
      <circle cx="12" cy="12" r="1.7" fill="#9feaf9"/>
    </svg>
  ),

  // Finder — blue/dark split happy-face
  finder: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <defs>
        <linearGradient id="finder-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3da6f1"/>
          <stop offset="1" stopColor="#0c63b8"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="4.6" fill="url(#finder-bg)"/>
      <rect x="2" y="2" width="10" height="20" fill="rgba(255,255,255,0.18)"/>
      <ellipse cx="8.6" cy="10.5" rx="0.9" ry="1.6" fill="#0e1d33"/>
      <ellipse cx="15.4" cy="10.5" rx="0.9" ry="1.6" fill="#0e1d33"/>
      <path d="M9 15.5q3 1.6 6 0" fill="none" stroke="#0e1d33" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  ),

  // GitKraken — green kraken (stylized tentacles)
  gitkraken: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#179287"/>
      <circle cx="12" cy="11" r="4.6" fill="none" stroke="#7be8b8" strokeWidth="1.4"/>
      <circle cx="9.8" cy="10.4" r="0.9" fill="#0d2a26"/>
      <circle cx="14.2" cy="10.4" r="0.9" fill="#0d2a26"/>
      <path d="M7.5 17q.8-1 1.7-1.4M16.5 17q-.8-1-1.7-1.4M10 18.5v-2M14 18.5v-2M12 19v-2.5" stroke="#7be8b8" strokeWidth="1" strokeLinecap="round" fill="none"/>
    </svg>
  ),

  // Lark — teal squircle with white waveform/L
  lark: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#00d6b9"/>
      <path d="M7 9q3-3 7 0t-3 6q-3 1.5-5 0" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round"/>
      <circle cx="17" cy="8.5" r="1.6" fill="#fff"/>
    </svg>
  ),

  // LINE — green with white speech bubble
  line: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#06c755"/>
      <path d="M5.5 11.4c0-3 3-5.4 6.5-5.4s6.5 2.4 6.5 5.4c0 1.8-1 3.3-2.7 4.3-.4.3-1.7 1.2-2 1.4-.5.4-.4.1-.4-.2 0-.2.1-.7.1-1-2.6-.3-5.5-2-7-3.7-.6-.7-1-1.8-1-2.8Z" fill="#fff"/>
      <path d="M8.5 9.8v3.5M8.5 13.3h1.7M11.5 9.8v3.5M14 9.8v3.5h1.6M14 11.4h1.4M11.5 9.8l1.7 3.5V9.8" stroke="#06c755" strokeWidth="0.7" fill="none" strokeLinejoin="round"/>
    </svg>
  ),

  // PwrAgent — uses the PwrSnap stacked-square mark but in cool blue (sibling app)
  pwragent: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#0a0a0a" stroke="#1f7cff"/>
      <rect x="9"   y="4"   width="11" height="11" rx="2.2" fill="none" stroke="#0e1a2b" strokeWidth="1.2"/>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="none" stroke="#1f57b8" strokeWidth="1.2"/>
      <rect x="4"   y="9"   width="11" height="11" rx="2.2" fill="none" stroke="#1f7cff" strokeWidth="1.3"/>
    </svg>
  ),

  // Safari — blue compass
  safari: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <defs>
        <radialGradient id="safari-bg" cx="0.5" cy="0.4" r="0.7">
          <stop offset="0" stopColor="#d2eaff"/>
          <stop offset="0.5" stopColor="#3aa6ff"/>
          <stop offset="1" stopColor="#0a5fd1"/>
        </radialGradient>
      </defs>
      <circle cx="12" cy="12" r="10" fill="url(#safari-bg)"/>
      <circle cx="12" cy="12" r="8.2" fill="none" stroke="#fff" strokeWidth="0.5" opacity="0.8"/>
      <path d="M12 4.5 13.4 10.6 12 12 10.6 13.4 12 19.5l-1.4-6.1L12 12l1.4-1.4Z" fill="#fff"/>
      <path d="M12 4.5 10.6 10.6 12 12 13.4 13.4 12 19.5" fill="#e85a3a"/>
      <circle cx="12" cy="12" r="0.8" fill="#0a0a0a"/>
    </svg>
  ),

  // System Settings — gray gear
  systemsettings: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <defs>
        <linearGradient id="syssett-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6e6e75"/>
          <stop offset="1" stopColor="#2a2a30"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="4.6" fill="url(#syssett-bg)"/>
      <path d="M12 6.5v2M12 15.5v2M6.5 12h2M15.5 12h2M8 8l1.4 1.4M14.6 14.6 16 16M16 8l-1.4 1.4M9.4 14.6 8 16" stroke="#e8e8ec" strokeWidth="1" strokeLinecap="round"/>
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="#e8e8ec" strokeWidth="1.4"/>
      <circle cx="12" cy="12" r="1.2" fill="#e8e8ec"/>
    </svg>
  ),

  // Telegram — blue circle, paper plane
  telegram: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <defs>
        <linearGradient id="tg-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3aa6ff"/>
          <stop offset="1" stopColor="#1c8adb"/>
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="10" fill="url(#tg-bg)"/>
      <path d="M17.5 7.8 5.5 12.6c-.7.3-.7 1 0 1.2l3 .8 1.2 3.5c.2.4.7.5 1 .2l1.7-1.6 3 2.2c.5.4 1.2 0 1.3-.5l2.2-9.8c.2-.6-.4-1.2-1-1Zm-7.4 7.7-.3 2.2-.7-2.3 5.7-5L10 15.5Z" fill="#fff"/>
    </svg>
  ),

  // Terminal — black with prompt
  terminal: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#0a0a0a" stroke="#2a2a2a"/>
      <path d="m7 9 3 3-3 3M12 15h4" stroke="#f5efe3" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  ),

  // Unknown app — gray placeholder with ?
  unknown: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <SQ fill="#3a3a3a"/>
      <path d="M9.5 9.5q0-2.5 2.5-2.5t2.5 2.5q0 1.4-1.2 2-1 .6-1.3 1.5v0.5M12 16v.4" stroke="#c2bfb8" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
    </svg>
  ),

  // Xcode — blue with hammer
  xcode: (s) => (
    <svg viewBox="0 0 24 24" width={s} height={s}>
      <defs>
        <linearGradient id="xc-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3aa6ff"/>
          <stop offset="1" stopColor="#0f6cd4"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="4.6" fill="url(#xc-bg)"/>
      <path d="M5 6.5h3l8 8v3h-3l-8-8Z" fill="#fff"/>
      <circle cx="6.5" cy="8" r="0.7" fill="#0f6cd4"/>
      <path d="M15 6.5l3 3-1.5 1.5-3-3z" fill="#fff"/>
    </svg>
  ),
};

// ============================================================
// Components
// ============================================================
function PsAppIcon({ app, size = 11 }) {
  const fn = APP_ICONS[app] || APP_ICONS.any;
  return fn(size);
}

function PsBundleIcon({ app, size = 18 }) {
  const fn = APP_BUNDLE_ICONS[app] || APP_BUNDLE_ICONS.unknown;
  return fn(size);
}

// App-source chip — uses the colored bundle icon, no dark tile around it.
// Reads like a real provenance signal pulled from the .app's metadata.
function PsAppTag({ app, name, size = "md" }) {
  const cls = "ps-app-tag is-bundle" + (size === "sm" ? " is-sm" : size === "lg" ? " is-lg" : "");
  const iconSize = size === "sm" ? 14 : size === "lg" ? 20 : 16;
  return (
    <span className={cls} title={`Captured from ${name}`}>
      <span className="ps-app-tag__bundle">
        <PsBundleIcon app={app} size={iconSize} />
      </span>
      <span className="ps-app-tag__name">{name}</span>
    </span>
  );
}

// ============================================================
// Catalog — name + canonical icon family
// ============================================================
const APP_INFO = {
  "1password":     { name: "1Password" },
  appstore:        { name: "App Store" },
  chrome:          { name: "Chrome" },
  claude:          { name: "Claude" },
  clipboard:       { name: "Clipboard" },
  codex:           { name: "Codex" },
  electron:        { name: "Electron" },
  finder:          { name: "Finder" },
  gitkraken:       { name: "GitKraken" },
  lark:            { name: "Lark" },
  line:            { name: "LINE" },
  pwragent:        { name: "PwrAgent" },
  safari:          { name: "Safari" },
  systemsettings:  { name: "System Settings" },
  telegram:        { name: "Telegram" },
  terminal:        { name: "Terminal" },
  unknown:         { name: "Unknown app" },
  xcode:           { name: "Xcode" },
};

window.PS = window.PS || {};
Object.assign(window.PS, { PsAppIcon, PsBundleIcon, PsAppTag, APP_ICONS, APP_BUNDLE_ICONS, APP_INFO });
