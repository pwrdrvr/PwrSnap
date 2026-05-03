/* eslint-disable */
// PwrSnap Tray Menu — keyboard-driven mode picker dropdown from menubar.

const { useState: useStateTM } = React;
const { PsAppIcon } = window.PS;

function TrayKbd({ children, accent = false }) {
  return <span className={"ps-kbd" + (accent ? " is-accent" : "")}>{children}</span>;
}

const MODES = [
  { id: "region",  name: "Region",        sub: "Drag selection",         hk: ["⌘","⇧","P"], icon: "region",  primary: true },
  { id: "window",  name: "Window",        sub: "Click target",            hk: ["⌘","⇧","W"], icon: "window" },
  { id: "full",    name: "Full Screen",   sub: "Active display",          hk: ["⌘","⇧","F"], icon: "full"   },
  { id: "all",     name: "All Screens",   sub: "Stitch displays",         hk: ["⌘","⇧","A"], icon: "all"    },
  { id: "scroll",  name: "Scrolling",     sub: "Capture full page",       hk: ["⌘","⇧","S"], icon: "scroll" },
  { id: "timed",   name: "Timed (5s)",    sub: "Auto trigger",            hk: ["⌘","⇧","T"], icon: "timed"  },
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
        <div className="ps-tray__status">
          <span className="ps-tray__status-dot" />
          IDLE · LOCAL
        </div>
      </div>

      <div className="ps-tray__hotkey">
        <div className="ps-tray__hotkey-l">
          <span className="ps-tray__hotkey-eyebrow">Quick Capture</span>
          <span style={{ font: "500 11px/1 var(--font-sans)", color: "var(--text-secondary)" }}>
            Press a shortcut from anywhere
          </span>
        </div>
        <div className="ps-tray__hotkey-row">
          <TrayKbd accent>⌘</TrayKbd>
          <TrayKbd accent>⇧</TrayKbd>
          <TrayKbd accent>P</TrayKbd>
        </div>
      </div>

      <div className="ps-tray__modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={"ps-mode" + (m.id === activeMode ? " is-primary" : "")}
            type="button"
          >
            <div className="ps-mode__row1">
              <span className="ps-mode__icon"><ModeIcon kind={m.icon} /></span>
              <span className="ps-mode__name">{m.name}</span>
              <span className="ps-mode__hk">
                {m.hk.map((k, i) => <span key={i} className="ps-kbd">{k}</span>)}
              </span>
            </div>
            <div className="ps-mode__sub">{m.sub}</div>
          </button>
        ))}
      </div>

      <div className="ps-tray__divider" />

      <div className="ps-tray__activity">
        <div className="ps-tray__activity-thumb">
          <img src="assets/sample-1.png" alt="Last snap" />
        </div>
        <div className="ps-tray__activity-text">
          <b>Last snap · 12s ago</b>
          <small>1840×1180 · 412 KB · region</small>
        </div>
        <div className="ps-tray__activity-meta">
          <span className="ps-kbd is-accent">⌘V</span>
        </div>
      </div>

      <button className="ps-tray__row" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>
        <span className="ps-tray__row-label">Open Library</span>
        <span className="ps-tray__row-kbd"><TrayKbd>⌘</TrayKbd><TrayKbd>L</TrayKbd></span>
      </button>
      <button className="ps-tray__row" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 1 0-7 7"/><path d="m21 21-3-3"/></svg>
        <span className="ps-tray__row-label">Search captures…</span>
        <span className="ps-tray__row-kbd"><TrayKbd>⌘</TrayKbd><TrayKbd>K</TrayKbd></span>
      </button>
      <button className="ps-tray__row" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3"/><circle cx="12" cy="12" r="3"/></svg>
        <span className="ps-tray__row-label">Preferences…</span>
        <span className="ps-tray__row-kbd"><TrayKbd>⌘</TrayKbd><TrayKbd>,</TrayKbd></span>
      </button>
      <div style={{ height: 8 }} />
    </div>
  );
}

window.PS = window.PS || {};
Object.assign(window.PS, { TrayMenu, TrayMenubar, MODES });
