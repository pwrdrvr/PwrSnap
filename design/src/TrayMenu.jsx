/* eslint-disable */
// PwrSnap Tray Menu — keyboard-driven mode picker dropdown from menubar.

const { useState: useStateTM } = React;
const { PsAppIcon } = window.PS;

function TrayKbd({ children, accent = false }) {
  return <span className={"ps-kbd" + (accent ? " is-accent" : "")}>{children}</span>;
}

const MODES = [
  { id: "region",  name: "Region",        sub: "Drag selection",         hk: ["⌘","⇧","R"], icon: "region" },
  { id: "window",  name: "Window",        sub: "Click target",            hk: ["⌘","⇧","W"], icon: "window" },
  { id: "full",    name: "Full Screen",   sub: "Active display",          hk: ["⌘","⇧","F"], icon: "full"   },
  { id: "all",     name: "All Screens",   sub: "Stitch displays",         hk: ["⌘","⇧","A"], icon: "all"    },
  { id: "scroll",  name: "Scrolling",     sub: "Capture full page",       hk: ["⌘","⇧","S"], icon: "scroll" },
  { id: "timed",   name: "Timed (5s)",    sub: "Auto trigger",            hk: ["⌘","⇧","T"], icon: "timed"  },
];

const COPY_PRESETS = [
  { id: "low",  label: "Low",  dim: "736 × 472",   bytes: "164 KB", kbd: "1" },
  { id: "med",  label: "Med",  dim: "1288 × 826",  bytes: "412 KB", kbd: "2" },
  { id: "high", label: "High", dim: "1840 × 1180", bytes: "1.2 MB", kbd: "3" },
];

function ModeIcon({ kind }) {
  const c = "currentColor";
  switch (kind) {
    case "region":
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 4H4v3M4 17v3h3M17 20h3v-3M20 7V4h-3" strokeDasharray="0"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      );
    case "window":
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={c} strokeWidth="1.6">
          <rect x="3" y="5" width="18" height="14" rx="1.5"/>
          <path d="M3 9h18"/>
          <circle cx="6" cy="7" r=".7" fill={c}/>
          <circle cx="8.5" cy="7" r=".7" fill={c}/>
        </svg>
      );
    case "full":
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="14" rx="1.5"/>
          <path d="M9 21h6"/>
        </svg>
      );
    case "all":
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={c} strokeWidth="1.5">
          <rect x="2" y="5" width="11" height="9" rx="1"/>
          <rect x="11" y="9" width="11" height="9" rx="1"/>
        </svg>
      );
    case "scroll":
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6" y="3" width="12" height="18" rx="1.5"/>
          <path d="M9 8h6M9 12h6M9 16h6M3 9v6M21 9v6"/>
        </svg>
      );
    case "timed":
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="13" r="7"/>
          <path d="M12 13V9M9 3h6M19 6l-1.5 1.5"/>
        </svg>
      );
  }
}

// Faux menubar context for showing the tray dropping FROM it.
function TrayMenubar({ children }) {
  return (
    <div className="tray-menubar">
      <div className="tray-menubar__l">
        <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>Finder</span>
        <span>File</span><span>Edit</span><span>View</span><span>Go</span>
      </div>
      <div className="tray-menubar__r">
        <span>🔋 92%</span>
        <span>📶</span>
        <span className="tray-menubar__pwrsnap">
          <span className="tray-menubar__pwrsnap-mark"><PsAppIcon app="any" size={11} /></span>
          <span className="tray-menubar__pwrsnap-dot" />
        </span>
        <span style={{ color: "var(--text-primary)" }}>Tue 9:42</span>
      </div>
      {children}
    </div>
  );
}

function TrayMenu({ activeMode = "region" }) {
  return (
    <div className="ps-tray" data-screen-label="Tray Menu">
      <div className="ps-tray__hdr">
        <div className="ps-tray__brand">
          <PsAppIcon app="any" size={14} />
          <span className="ps-tray__brand-name">Pwr<span className="a">Snap</span></span>
        </div>
        <div className="ps-tray__hdr-actions">
          <button className="ps-tray__hdr-btn" type="button" title="Open Library  (⌘⇧L)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5a2 2 0 0 1 2-2h4l1.5 2H18a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/>
              <path d="M4 9h16"/>
            </svg>
          </button>
          <button className="ps-tray__hdr-btn" type="button" title="Settings  (⌘,)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>
            </svg>
          </button>
          <span className="ps-tray__hdr-sep" />
          <div className="ps-tray__status">
            <span className="ps-tray__status-dot" />
            IDLE
          </div>
        </div>
      </div>

      <button className="ps-tray__quick" type="button">
        <span className="ps-tray__quick-l">
          <span className="ps-tray__quick-eyebrow">Quick Capture</span>
          <span className="ps-tray__quick-sub">Smart auto-mode · picks region, window, or full screen</span>
        </span>
        <span className="ps-tray__quick-hk">
          <TrayKbd>⌘</TrayKbd>
          <TrayKbd>⇧</TrayKbd>
          <TrayKbd>P</TrayKbd>
        </span>
      </button>

      <div className="ps-tray__modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={"ps-mode" + (m.id === activeMode ? " is-active" : "")}
            type="button"
          >
            <span className="ps-mode__icon"><ModeIcon kind={m.icon} /></span>
            <span className="ps-mode__name">{m.name}</span>
            <span className="ps-mode__hk">
              {m.hk.map((k, i) => <span key={i} className="ps-kbd">{k}</span>)}
            </span>
          </button>
        ))}
      </div>

      <div className="ps-tray__divider" />

      <div className="ps-tray__last">
        <div className="ps-tray__last-hdr">
          <span className="ps-tray__last-eyebrow">Last snap · 12s ago</span>
          <span className="ps-tray__last-meta">1840×1180 · region</span>
        </div>
        <div className="ps-tray__last-preview">
          <img src="assets/sample-1.png" alt="Last snap" />
        </div>
        <div className="ps-tray__last-copy">
          {COPY_PRESETS.map((p, i) => (
            <button
              key={p.id}
              className={"fo__copy-btn" + (i === 2 ? " is-primary" : "")}
              type="button"
            >
              <div className="fo__copy-btn-row1">
                <span className="fo__copy-label">{p.label}</span>
                <span className="fo__copy-kbd">⌘{p.kbd}</span>
              </div>
              <div className="fo__copy-meta">
                <span className="fo__copy-dim">{p.dim}</span>
                <span className="fo__copy-bytes">{p.bytes}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div style={{ height: 8 }} />
    </div>
  );
}

window.PS = window.PS || {};
Object.assign(window.PS, { TrayMenu, TrayMenubar, MODES });
