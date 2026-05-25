/* eslint-disable */
// PwrSnap Library — Grid (default) · Reel · Focus overlay
// Three view-states share the same data + selection model.

const { useState: useStateLib, useMemo: useMemoLib, useEffect: useEffectLib, useRef: useRefLib } = React;
const { PsAppIcon, PsBundleIcon, PsAppTag, APP_INFO } = window.PS;

// ============================================================
// Data — 334 captures across several days. Source-app keyed to
// the bundle-icon catalog (1password, appstore, chrome, claude,
// clipboard, codex, electron, finder, gitkraken, lark, line,
// pwragent, safari, systemsettings, telegram, terminal,
// unknown, xcode).
// ============================================================
const CAPTURES = (() => {
  // Per-day distribution (matches the topbar count + day headers).
  // The 334-capture total is a fixture string in the UI;
  // we don't materialize every row — only enough to populate the
  // first ~3 days at full density.
  const days = [
    { day: "Today",     date: "May 21", count: 14 },
    { day: "Yesterday", date: "May 20", count: 6  },
    { day: "Mon",       date: "May 19", count: 8  },
    { day: "Last Fri",  date: "May 16", count: 6  },
  ];

  // App distribution — Electron-heavy (226 of 334) to match the sidebar count;
  // a sprinkle of every other source to exercise the bundle icons.
  const todayApps = [
    "clipboard", "electron", "electron", "electron",   // row 1: 4 cells
    "electron",  "electron", "electron", "electron",   // row 2
    "electron",  "electron", "electron", "electron",   // row 3
    "electron",  "electron",                            // row 4
  ];
  const yesterdayApps = ["electron","electron","claude","electron","electron","claude"];
  const mondayApps    = ["electron","electron","chrome","electron","claude","electron","electron","electron"];
  const fridayApps    = ["pwragent","electron","terminal","electron","safari","electron"];

  const stems = {
    clipboard: ["clipboard-paste-onboarding"],
    electron:  ["pwragent-resume-menu-bug","pwragent-msg-debounce","pwragent-stream-tokens","pwragent-thread-tabs",
                "pwragent-context-rail","pwragent-codex-tag","pwragent-empty-state","pwragent-thinking-scanner",
                "pwragent-worktree-chip","pwragent-composer-chips","pwragent-tray-modes","pwragent-sidebar-resize",
                "pwragent-prefs-pane","pwragent-message-thread","pwragent-thread-actions","pwragent-status-bar",
                "pwragent-search-results","pwragent-inbox-row","pwragent-mention-toast","pwragent-attach-popover",
                "pwragent-history-scroll","pwragent-typing-indicator","pwragent-pin-action","pwragent-thread-reorder",
                "pwragent-folder-tree"],
    claude:    ["claude-thread-export","claude-prompt-tools","claude-context-tray"],
    chrome:    ["stripe-mrr-dash","mdn-backdrop-filter"],
    pwragent:  ["pwragent-launch-deck"],
    terminal:  ["kubectl-api-crash","pnpm-install-fail"],
    safari:    ["safari-perf-flame"],
  };
  const stemPick = (app, i) => {
    const list = stems[app] || ["capture"];
    return list[i % list.length];
  };

  const out = [];
  let counter = 0;

  function spawn(dayInfo, apps) {
    apps.forEach((app, slot) => {
      counter++;
      // pretend timestamps walk back through the afternoon
      const hour = 12 - Math.floor(slot / 4);
      const min  = (slot * 13 + 6) % 60;
      const ampm = hour <= 12 ? "PM" : "AM";
      const hh   = hour > 12 ? hour - 12 : hour;
      const time = `${hh}:${String(min).padStart(2,"0")} ${ampm}`;
      out.push({
        id: counter,
        app,
        day: dayInfo.day, date: dayInfo.date, time,
        stem: stemPick(app, slot + (dayInfo.day === "Yesterday" ? 4 : dayInfo.day === "Mon" ? 8 : 0)),
        n: stemPick(app, slot).replace(/-/g," "),
        tags: ["bug","ui","chat","spec","prod","ref","fix"].filter((_,k) => (slot+k)%3===0),
        size: 220 + Math.round(Math.sin(counter*1.7) * 100 + 280),
        w: [2880, 1920, 1440, 2560][counter % 4],
        h: [1800, 1200,  900, 1600][counter % 4],
      });
    });
  }
  spawn(days[0], todayApps);
  spawn(days[1], yesterdayApps);
  spawn(days[2], mondayApps);
  spawn(days[3], fridayApps);
  return out;
})();

const TOTAL_CAPTURES = 334;

// Per-source counts shown in the left rail. Hand-tuned to match the
// "Electron 226 of 334" reality in the design ref.
const RAIL_COUNTS = {
  "1password":    1,
  appstore:       1,
  chrome:         1,
  claude:         23,
  clipboard:      3,
  codex:          3,
  electron:       226,
  finder:         2,
  gitkraken:      2,
  lark:           4,
  line:           5,
  pwragent:       3,
  safari:         25,
  systemsettings: 1,
  telegram:       13,
  terminal:       11,
  unknown:        9,
  xcode:          1,
};

// ============================================================
// Synthetic thumbnails — sized to match the "PwrAgent-on-dark"
// vibe of the design ref. Most snaps are amber-tinted dark UI;
// the clipboard onboarding pops bright orange.
// ============================================================
function thumbStyle(c) {
  const palettes = {
    "1password": ["#0a1a2a", "#0a6cff", "#9fc4ff"],
    appstore:    ["#0a1a2a", "#1eb5ff", "#cfe7ff"],
    chrome:      ["#171717", "#fbbc04", "#fff"],
    claude:      ["#1a0e08", "#d97757", "#f3b894"],
    clipboard:   ["#0a0806", "#1a1612", "#3a3022"],
    codex:       ["#080808", "#1f1f1f", "#3a3a3a"],
    electron:    ["#070605", "#15110b", "#241a0e"],
    finder:      ["#0a1a2a", "#0c63b8", "#3da6f1"],
    gitkraken:   ["#08201d", "#179287", "#7be8b8"],
    lark:        ["#03251f", "#00d6b9", "#7ff0dc"],
    line:        ["#082015", "#06c755", "#7ee6a8"],
    pwragent:    ["#050505", "#1a1a22", "#1f7cff"],
    safari:      ["#0a1a2a", "#3aa6ff", "#d2eaff"],
    systemsettings: ["#1a1a1c", "#3a3a40", "#6e6e75"],
    telegram:    ["#0a1f2a", "#1c8adb", "#7fc1ed"],
    terminal:    ["#050505", "#1a1a1a", "#5fb47e"],
    unknown:     ["#1a1a1a", "#2a2a2a", "#4a4a4a"],
    xcode:       ["#0a1a2a", "#0f6cd4", "#7fc1ed"],
  };
  const [bg, mid, hi] = palettes[c.app] || palettes.unknown;
  const angle = (c.id * 47) % 360;
  return { background: `linear-gradient(${angle}deg, ${bg} 0%, ${mid} 60%, ${hi} 100%)` };
}

function ThumbContent({ c }) {
  // Most captures are dark-amber PwrAgent-style UI screenshots.
  // Render a generic dense terminal-y UI: chrome bar, sidebar, code blocks.
  const dark   = "rgba(8,7,6,0.92)";
  const tint   = c.app === "clipboard" ? "#d97757" : "#ff8a1f";
  const text   = "rgba(245,239,227,0.55)";
  const muted  = "rgba(245,239,227,0.22)";

  if (c.app === "clipboard") {
    // bright onboarding card — looks like a setup pane on dark
    return (
      <svg viewBox="0 0 100 62" preserveAspectRatio="none" style={{ width:"100%", height:"100%", display:"block" }}>
        <rect x="0" y="0" width="100" height="62" fill={dark}/>
        <rect x="14" y="8"  width="72" height="46" rx="2.5" fill="#15110b" stroke="rgba(255,138,31,0.35)"/>
        <rect x="20" y="13" width="22" height="2.4" fill="#fff" opacity="0.85"/>
        <rect x="20" y="18" width="50" height="1.6" fill={text}/>
        <rect x="20" y="21" width="46" height="1.6" fill={text}/>
        <rect x="20" y="24" width="42" height="1.6" fill={text}/>
        <rect x="20" y="33" width="56" height="9"  rx="1.5" fill="rgba(255,138,31,0.10)" stroke="rgba(255,138,31,0.45)"/>
        <rect x="22" y="36" width="20" height="2"  fill="#ff8a1f"/>
        <rect x="58" y="47" width="14" height="4"  rx="1.2" fill="#ff8a1f"/>
        <rect x="22" y="47" width="10" height="2"  fill={muted}/>
      </svg>
    );
  }
  // generic dark UI screenshot
  return (
    <svg viewBox="0 0 100 62" preserveAspectRatio="none" style={{ width:"100%", height:"100%", display:"block" }}>
      <rect x="0" y="0" width="100" height="62" fill={dark}/>
      <rect x="0" y="0" width="100" height="5" fill="rgba(20,17,13,0.95)"/>
      <circle cx="3" cy="2.5" r="0.8" fill="#ff5f57"/>
      <circle cx="6" cy="2.5" r="0.8" fill="#febc2e"/>
      <circle cx="9" cy="2.5" r="0.8" fill="#28c840"/>
      <rect x="0" y="5" width="22" height="57" fill="rgba(20,17,13,0.92)"/>
      <rect x="2" y="9"  width="18" height="1.6" fill={tint} opacity="0.85"/>
      {[0,1,2,3,4,5].map(i => (
        <rect key={i} x="3" y={14+i*4} width={12 + (i*7+c.id)%6} height="1.4" fill={text} opacity={0.32 + (i%3)*0.1}/>
      ))}
      {/* messages */}
      <rect x="26" y="8" width="68" height="1.8" fill={tint} opacity="0.6"/>
      <rect x="26" y="11" width="50" height="1.2" fill={muted}/>
      <rect x="26" y="17" width="68" height="12" rx="1" fill="rgba(255,138,31,0.05)" stroke="rgba(255,138,31,0.18)"/>
      <rect x="28" y="20" width="50" height="1.4" fill={text}/>
      <rect x="28" y="23" width="56" height="1.2" fill={text} opacity="0.7"/>
      <rect x="28" y="26" width="42" height="1.2" fill={text} opacity="0.7"/>
      <rect x="26" y="32" width="68" height="10" rx="1" fill="rgba(20,17,13,0.7)" stroke={muted}/>
      <rect x="28" y="35" width="40" height="1.2" fill={text} opacity="0.7"/>
      <rect x="28" y="38" width="54" height="1.2" fill={text} opacity="0.6"/>
      <rect x="26" y="45" width="68" height="10" rx="1" fill="rgba(255,138,31,0.04)" stroke="rgba(255,138,31,0.14)"/>
      <rect x="28" y="48" width="38" height="1.2" fill={text} opacity="0.7"/>
      <rect x="28" y="51" width="48" height="1.2" fill={text} opacity="0.6"/>
      <circle cx="86" cy="51" r="0.9" fill={tint}/>
    </svg>
  );
}

function Thumb({ c, withAnnotation = false }) {
  return (
    <div style={{ position: "absolute", inset: 0, ...thumbStyle(c) }}>
      <ThumbContent c={c} />
      {withAnnotation && (
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} viewBox="0 0 100 62" preserveAspectRatio="none">
          <rect x="48" y="34" width="22" height="9" fill="none" stroke="#ff8a1f" strokeWidth="0.6"/>
          <path d="M48 34 L 30 22" stroke="#ff8a1f" strokeWidth="0.5"/>
          <circle cx="30" cy="22" r="1.6" fill="#ff8a1f"/>
        </svg>
      )}
    </div>
  );
}

function groupByDay(items) {
  const m = {};
  items.forEach((c) => {
    if (!m[c.day]) m[c.day] = { day: c.day, date: c.date, items: [] };
    m[c.day].items.push(c);
  });
  return Object.values(m);
}

// ============================================================
// Edit toolbar — labeled buttons w/ bracketed key hints.
// Picks up the affordance the user has been sketching: each tool
// reads as `LABEL [K]` with the key in a bracket-chip beside its name.
// Left edge is a drag handle (move the toolbar). Right edge is the
// Zoom dropdown (Fit / 100% / custom).
// ============================================================
const EDIT_TOOLS = [
  { id: "pointer",   name: "Pointer",   key: "V", icon: <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0.5"><path d="m6 3 12 8-5 1.4 3 7-2.6 1.1-3-7L6 17Z"/></svg> },
  { id: "arrow",     name: "Arrow",     key: "A", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M5 19 19 5M19 5h-7M19 5v7"/></svg> },
  { id: "rect",      name: "Rect",      key: "R", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16"/></svg> },
  { id: "highlight", name: "Highlight", key: "H", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m9 14-5 5v2h2l5-5"/><path d="M14 9 19 4l3 3-5 5"/><path d="M9 14l5 5"/></svg> },
  { id: "blur",      name: "Blur",      key: "B", icon: <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4.5"/></svg> },
  { id: "text",      name: "Text",      key: "T", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 6h14M12 6v14M9 20h6"/></svg> },
];

const BLUR_MODES = [
  { id: "soft",     name: "Soft blur", desc: "Gaussian smear — good for hiding text while keeping the shape",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg> },
  { id: "pixelate", name: "Pixelate",  desc: "Chunky mosaic — the classic censored look",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="3" height="3"/><rect x="10" y="6" width="3" height="3"/><rect x="14" y="6" width="3" height="3"/><rect x="6" y="10" width="3" height="3"/><rect x="14" y="10" width="3" height="3"/><rect x="6" y="14" width="3" height="3"/><rect x="10" y="14" width="3" height="3"/><rect x="14" y="14" width="3" height="3"/></svg> },
  { id: "redact",   name: "Redact",    desc: "Solid black bar — privacy with zero info leak",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="10" width="16" height="4" rx="0.5"/></svg> },
];

const ZOOM_PRESETS = [
  { id: "fit",   label: "Fit",   pct: 57,  kbd: "⌘0" },
  { id: "100",   label: "100%",  pct: 100, kbd: "⌘1" },
];

function ZoomMenu({ zoom, setZoom, onClose }) {
  const [val, setVal] = useStateLib(zoom.pct);
  return (
    <div className="psl__zoom-menu" onClick={(e) => e.stopPropagation()}>
      {ZOOM_PRESETS.map((p) => (
        <button key={p.id} className={"psl__zoom-row" + (zoom.id === p.id ? " is-active" : "")} onClick={() => { setZoom({ id: p.id, pct: p.pct }); onClose(); }}>
          <span className="psl__zoom-check">{zoom.id === p.id ? "✓" : ""}</span>
          <span className="psl__zoom-label">{p.label}</span>
          <span className="psl__zoom-pct">{p.pct}%</span>
          <span className="psl__zoom-kbd">{p.kbd}</span>
        </button>
      ))}
      <div className="psl__zoom-custom">
        <button className="psl__zoom-step" onClick={() => setVal(Math.max(10, val-5))}>−</button>
        <div className="psl__zoom-input-wrap">
          <input type="number" value={val} onChange={(e) => setVal(parseInt(e.target.value,10) || 0)} />
          <span>%</span>
        </div>
        <button className="psl__zoom-step" onClick={() => setVal(Math.min(400, val+5))}>+</button>
      </div>
      <div className="psl__zoom-hint">
        <span><kbd>⌘</kbd>+scroll cursor zoom</span>
        <span>· two-finger scroll pans</span>
      </div>
    </div>
  );
}

function BlurMenu({ mode, setMode, onClose }) {
  return (
    <div className="psl__blur-menu" onClick={(e) => e.stopPropagation()}>
      {BLUR_MODES.map((m) => (
        <button key={m.id} className={"psl__blur-row" + (mode === m.id ? " is-active" : "")} onClick={() => { setMode(m.id); onClose(); }}>
          <span className="psl__blur-check">{mode === m.id ? "✓" : ""}</span>
          <span className="psl__blur-icon">{m.icon}</span>
          <span className="psl__blur-body">
            <span className="psl__blur-name">{m.name}</span>
            <span className="psl__blur-desc">{m.desc}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function EditToolbar({ tool, setTool }) {
  const [zoom, setZoom] = useStateLib({ id: "fit", pct: 57 });
  const [blurMode, setBlurMode] = useStateLib("soft");
  const [showZoom, setShowZoom] = useStateLib(false);
  const [showBlurMenu, setShowBlurMenu] = useStateLib(false);

  return (
    <div className="psl__edit-toolbar" onClick={(e) => e.stopPropagation()}>
      {/* drag handle */}
      <span className="psl__et-drag" title="Drag toolbar">
        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="2.5" cy="3"  r="1.1"/><circle cx="7.5" cy="3"  r="1.1"/><circle cx="2.5" cy="7"  r="1.1"/><circle cx="7.5" cy="7"  r="1.1"/><circle cx="2.5" cy="11" r="1.1"/><circle cx="7.5" cy="11" r="1.1"/></svg>
      </span>

      {EDIT_TOOLS.map((t) => {
        const isActive = tool === t.id;
        const isBlur = t.id === "blur";
        return (
          <div key={t.id} className="psl__et-cell">
            <button
              className={"psl__et-btn" + (isActive ? " is-active" : "")}
              onClick={() => {
                setTool(t.id);
                if (isBlur && !showBlurMenu) setShowBlurMenu(true);
                else setShowBlurMenu(false);
              }}
              title={t.name}
            >
              <span className="psl__et-ico">{t.icon}</span>
              <span className="psl__et-label">{t.name}</span>
              <span className="psl__et-key">{t.key}</span>
            </button>
            {isBlur && showBlurMenu && (
              <BlurMenu mode={blurMode} setMode={setBlurMode} onClose={() => setShowBlurMenu(false)} />
            )}
          </div>
        );
      })}

      <button className="psl__et-btn psl__et-btn--bare" title="Reset annotations">
        <span className="psl__et-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 4v6h6"/><path d="M4 10a8 8 0 1 1 2 5"/></svg>
        </span>
        <span className="psl__et-label">Reset</span>
      </button>

      <div className="psl__et-cell">
        <button
          className={"psl__et-btn psl__et-zoom" + (showZoom ? " is-active" : "")}
          onClick={() => setShowZoom(!showZoom)}
        >
          <span className="psl__et-zoom-text">{zoom.id === "fit" ? "Fit" : "100%"}</span>
          <span className="psl__et-zoom-pct">({zoom.pct}%)</span>
          <svg width="9" height="6" viewBox="0 0 9 6" fill="currentColor"><path d="M0 0h9L4.5 6Z"/></svg>
        </button>
        {showZoom && <ZoomMenu zoom={zoom} setZoom={setZoom} onClose={() => setShowZoom(false)} />}
      </div>
    </div>
  );
}

// ============================================================
// L/M/H copy row — from FloatOver, slimmed for sidebar
// ============================================================
const COPY_PRESETS = [
  { id: "low",  label: "Low",  scale: 0.4, kbd: "⌘1", bytes: "182 KB" },
  { id: "med",  label: "Med",  scale: 0.7, kbd: "⌘2", bytes: "612 KB" },
  { id: "high", label: "High", scale: 1.0, kbd: "⌘3", bytes: "2.4 MB" },
];

function CopyRow({ srcW, srcH }) {
  const [copied, setCopied] = useStateLib(null);
  return (
    <div className="psl__copy-row">
      {COPY_PRESETS.map((p) => {
        const w = Math.round(srcW * p.scale);
        const h = Math.round(srcH * p.scale);
        const isPrimary = p.id === "high";
        const isCopied = copied === p.id;
        const cls = "psl__copy-btn" + (isPrimary ? " is-primary" : "") + (isCopied ? " is-copied" : "");
        return (
          <button
            key={p.id}
            className={cls}
            onClick={() => {
              setCopied(p.id);
              setTimeout(() => setCopied((c) => c === p.id ? null : c), 1100);
            }}
          >
            <div className="psl__copy-btn-row1">
              <span className="psl__copy-label">{p.label}</span>
              <span className="psl__copy-kbd">{p.kbd}</span>
            </div>
            <span className="psl__copy-dim">{w.toLocaleString()}×{h.toLocaleString()}</span>
            <span className="psl__copy-bytes">{isCopied ? "copied ✓" : p.bytes}</span>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// AI-suggestion row — one suggested field with ✓ / ✗ buttons.
// Pattern: dotted accent border (proposed, not committed), the
// agent-tinted text color, and inline accept/reject so the user
// can promote a suggestion into the real field in one click.
// ============================================================
function AiSuggestion({ label, value, onAccept, onReject, multiline = false }) {
  return (
    <div className="psl__ai-row">
      <div className="psl__ai-row-hdr">
        <span className="psl__ai-row-label">{label}</span>
        <div className="psl__ai-row-actions">
          <button className="psl__ai-acc" title="Accept (↵)" onClick={onAccept}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-11"/></svg>
          </button>
          <button className="psl__ai-rej" title="Reject (⌫)" onClick={onReject}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="m5 5 14 14M19 5 5 19"/></svg>
          </button>
        </div>
      </div>
      <div className={"psl__ai-row-value" + (multiline ? " is-multi" : "")}>{value}</div>
    </div>
  );
}

// ============================================================
// Detail rail — title / description / filename-stem / tags
// with a co-located AI-processing card showing accept/reject
// per suggestion.
// ============================================================
function DetailRail({ current }) {
  // Mock suggested values the agent has proposed for this capture.
  // In the live app these come from the Codex post-capture pipeline.
  const ai = {
    title: current.app === "clipboard"
      ? "Onboarding — name & log in to your tasteful profile"
      : "Resume menu doesn't clear after picking a thread",
    description: current.app === "clipboard"
      ? "Final step of clipboard's onboarding — tasteful-profile setup with a Continue CTA. Screenshot used to confirm copy alignment."
      : "The resume dropdown stays mounted after the user picks an option, so a second click is needed to dismiss it. Repro on macOS, PwrAgent 0.4.2.",
    tags: current.app === "clipboard"
      ? ["onboarding","copy","clipboard"]
      : ["bug","resume","ui","p1"],
  };

  const [title, setTitle] = useStateLib(`${current.stem.replace(/-/g, " ")}`);
  const [desc, setDesc] = useStateLib("");
  const [tags, setTags] = useStateLib(["screenshot"]);
  const [aiOpen, setAiOpen] = useStateLib({ title: true, description: true, tags: true });

  function accept(field) {
    if (field === "title") setTitle(ai.title);
    if (field === "description") setDesc(ai.description);
    if (field === "tags") setTags(Array.from(new Set([...tags, ...ai.tags])));
    setAiOpen({ ...aiOpen, [field]: false });
  }
  function reject(field) { setAiOpen({ ...aiOpen, [field]: false }); }
  function acceptAll() {
    setTitle(ai.title); setDesc(ai.description);
    setTags(Array.from(new Set([...tags, ...ai.tags])));
    setAiOpen({ title: false, description: false, tags: false });
  }

  const filename = `pwrsnap-${current.day === "Today" ? "2026-05-21" : "2026-05-20"}-${current.stem}`;
  const anyOpen = aiOpen.title || aiOpen.description || aiOpen.tags;

  return (
    <aside className="psl__focus-rail">
      <div className="psl__right-tabs">
        <button className="psl__right-tab is-active">Detail</button>
        <button className="psl__right-tab">History</button>
        <button className="psl__right-tab">OCR</button>
      </div>
      <div className="psl__right-body">

        {/* TITLE */}
        <div className="psl__df">
          <label className="psl__df-label">Title</label>
          <input
            className="psl__df-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled capture"
          />
        </div>

        {/* DESCRIPTION */}
        <div className="psl__df">
          <label className="psl__df-label">Description</label>
          <textarea
            className="psl__df-textarea"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Add a description…"
            rows={3}
          />
        </div>

        {/* FILENAME STEM */}
        <div className="psl__df">
          <div className="psl__df-label-row">
            <label className="psl__df-label">Filename stem</label>
            <span className="psl__df-suffix">.png · {current.size} KB</span>
          </div>
          <input
            className="psl__df-input is-mono"
            defaultValue={filename}
          />
          <div className="psl__df-help">Used for export & clipboard reference. Date prefix locked.</div>
        </div>

        {/* TAGS */}
        <div className="psl__df">
          <label className="psl__df-label">Tags</label>
          <div className="psl__df-tags">
            <PsAppTag app={current.app} name={APP_INFO[current.app].name} size="sm" />
            {tags.map((t) => (
              <span key={t} className="ps-tag is-removable">
                {t}
                <button onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`remove ${t}`}>
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="m1 1 6 6M7 1 1 7"/></svg>
                </button>
              </span>
            ))}
            <button className="ps-tag is-add">+ tag</button>
          </div>
        </div>

        {/* AI SUGGESTIONS */}
        {anyOpen && (
          <div className="psl__ai-card">
            <div className="psl__ai-card-hdr">
              <span className="psl__ai-card-hdr-l">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.2 5.4 5.8.4-4.4 3.8 1.4 5.6L12 14.6 6.9 17.2l1.4-5.6L4 7.8l5.8-.4L12 2Z"/></svg>
                Codex suggestions
              </span>
              <small>haiku-4.5 · 1.4s</small>
            </div>

            {aiOpen.title && (
              <AiSuggestion
                label="Title"
                value={ai.title}
                onAccept={() => accept("title")}
                onReject={() => reject("title")}
              />
            )}
            {aiOpen.description && (
              <AiSuggestion
                label="Description"
                value={ai.description}
                onAccept={() => accept("description")}
                onReject={() => reject("description")}
                multiline
              />
            )}
            {aiOpen.tags && (
              <AiSuggestion
                label="Tags"
                value={
                  <span className="psl__ai-tag-row">
                    {ai.tags.map((t) => <span key={t} className="ps-tag is-suggest">+ {t}</span>)}
                  </span>
                }
                onAccept={() => accept("tags")}
                onReject={() => reject("tags")}
              />
            )}

            <div className="psl__ai-card-foot">
              <button className="psl__ai-all" onClick={acceptAll}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-11"/></svg>
                Accept all
              </button>
              <button className="psl__chip-btn">Regenerate</button>
            </div>
          </div>
        )}

        {/* L/M/H copy buttons */}
        <div>
          <div className="psl__rail-section-hdr">
            Copy to clipboard
            <span className="psl__rail-section-line" />
            <span className="psl__rail-section-meta">scaled, not blind</span>
          </div>
          <CopyRow srcW={current.w} srcH={current.h} />
        </div>

        <div className="psl__action-row">
          <button>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4v12M6 10l6-6 6 6M4 20h16"/></svg>
            Share
          </button>
          <button title="Open in full editor">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>
            Editor
          </button>
          <button className="is-danger" title="Move to Trash">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14"/></svg>
          </button>
        </div>
      </div>
    </aside>
  );
}

// ============================================================
// Focus overlay — lifted above the grid, single image + edit toolbar
// ============================================================
function FocusStage({ current, onClose, onPrev, onNext, posLabel }) {
  const [tool, setTool] = useStateLib("rect");

  return (
    <div className="psl__focus" onClick={onClose}>
      <div className="psl__focus-stage" onClick={(e) => e.stopPropagation()}>
        <div className="psl__stage-meta">
          <PsAppTag app={current.app} name={APP_INFO[current.app].name} size="sm" />
          <b>{current.stem.replace(/-/g," ")}</b>
          <span>· {current.day} {current.time}</span>
          <span>· {current.w}×{current.h}</span>
        </div>
        <div className="psl__stage-pos">
          <b>{posLabel.idx}</b> / {posLabel.total}
        </div>

        <button className="psl__focus-close" title="Back to grid (Esc)" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>
        </button>
        <div className="psl__focus-close-hint">
          back to grid
          <span className="ps-kbd">esc</span>
        </div>

        <button className="psl__stage-nav is-prev" onClick={onPrev} title="Previous (←)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 6-6 6 6 6"/></svg>
        </button>
        <button className="psl__stage-nav is-next" onClick={onNext} title="Next (→)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9 6 6 6-6 6"/></svg>
        </button>

        <div className="psl__stage-img">
          <Thumb c={current} withAnnotation />
        </div>

        <EditToolbar tool={tool} setTool={setTool} />
      </div>
      <DetailRail current={current} />
    </div>
  );
}

// ============================================================
// Reel mode body — filmstrip + always-open stage
// ============================================================
function ReelBody({ visible, selected, setSelected, current, posLabel }) {
  const [tool, setTool] = useStateLib("rect");
  const grouped = groupByDay(visible);
  const reelRef = useRefLib(null);

  return (
    <div className="psl__reel-mode">
      <section className="psl__reel-wrap">
        <div className="psl__reel-hdr">
          <span className="psl__reel-title">Timeline · scrub or click to play</span>
          <span className="psl__reel-mode">scrub <b>⌘[ / ⌘]</b></span>
        </div>
        <div className="psl__reel" ref={reelRef}>
          <div className="psl__playhead" style={{ left: 318 }} />
          {grouped.map((g) => (
            <div key={g.day} className="psl__reel-day">
              <div className="psl__reel-day-label">{g.day} · {g.date}</div>
              <div className="psl__reel-day-frames">
                {g.items.map((c) => (
                  <button
                    key={c.id}
                    className={"psl__frame" + (c.id === selected ? " is-selected" : "")}
                    onClick={() => setSelected(c.id)}
                  >
                    <Thumb c={c} />
                    <span className="psl__frame-num">{c.time.replace(" PM","").replace(" AM","")}</span>
                    <span className="psl__frame-app"><PsBundleIcon app={c.app} size={10} /></span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="psl__stage">
        <div className="psl__stage-meta">
          <PsAppTag app={current.app} name={APP_INFO[current.app].name} size="sm" />
          <b>{current.stem.replace(/-/g," ")}</b>
        </div>
        <div className="psl__stage-pos"><b>{posLabel.idx}</b> / {posLabel.total}</div>

        <button
          className="psl__stage-nav is-prev"
          onClick={() => {
            const i = visible.findIndex(c => c.id === selected);
            const prev = visible[(i - 1 + visible.length) % visible.length];
            setSelected(prev.id);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 6-6 6 6 6"/></svg>
        </button>
        <button
          className="psl__stage-nav is-next"
          onClick={() => {
            const i = visible.findIndex(c => c.id === selected);
            const next = visible[(i + 1) % visible.length];
            setSelected(next.id);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9 6 6 6-6 6"/></svg>
        </button>

        <div className="psl__stage-img">
          <Thumb c={current} withAnnotation />
        </div>

        <EditToolbar tool={tool} setTool={setTool} />
      </div>
    </div>
  );
}

// ============================================================
// Main Library
// ============================================================
function Library({ initialView = "grid", initialSelected = 1, initialOpen = false, initialApp = "all" }) {
  const [view, setView] = useStateLib(initialView);
  const [selected, setSelected] = useStateLib(initialSelected);
  const [activeApp, setActiveApp] = useStateLib(initialApp);
  const [focusOpen, setFocusOpen] = useStateLib(initialOpen);

  const visible = activeApp === "all" ? CAPTURES : CAPTURES.filter(c => c.app === activeApp);
  const grouped = useMemoLib(() => groupByDay(visible), [activeApp]);
  const current = CAPTURES.find(c => c.id === selected) || visible[0] || CAPTURES[0];

  const idx = Math.max(0, visible.findIndex(c => c.id === selected));
  const posLabel = { idx: idx + 1, total: visible.length };

  // keyboard: Esc closes focus; ←/→ navigate
  useEffectLib(() => {
    function onKey(e) {
      if (e.key === "Escape" && focusOpen) { setFocusOpen(false); }
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && (focusOpen || view === "reel")) {
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        const next = visible[(idx + dir + visible.length) % visible.length];
        if (next) setSelected(next.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusOpen, view, idx, visible.length]);

  const openFocus = (id) => {
    setSelected(id);
    setFocusOpen(true);
  };
  const closeFocus = () => setFocusOpen(false);

  const navInFocus = (dir) => {
    const next = visible[(idx + dir + visible.length) % visible.length];
    if (next) setSelected(next.id);
  };

  // App order in the rail — alphabetical-ish to match the design ref
  const railApps = Object.keys(APP_INFO);

  return (
    <div className="psl" style={{ position: "relative" }}>
      <header className="psl__topbar">
        <div className="psl__topbar-l">
          <div className="psl__title">
            <span className="psl__title-mark">
              <PsAppIcon app="pwrsnap" size={14} />
            </span>
            <span className="psl__wordmark">Pwr<span className="a">Snap</span></span>
          </div>
          <span className="psl__count">{TOTAL_CAPTURES} captures</span>
        </div>
        <div className="psl__topbar-c">
          <div className="psl__view">
            <button className={"psl__view-btn" + (view==="reel"?" is-active":"")} onClick={() => { setView("reel"); setFocusOpen(false); }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="6" width="4" height="12"/><rect x="10" y="6" width="4" height="12"/><rect x="17" y="6" width="4" height="12"/></svg>
              Reel
            </button>
            <button className={"psl__view-btn" + (view==="grid"?" is-active":"")} onClick={() => { setView("grid"); setFocusOpen(false); }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              Grid
            </button>
          </div>
        </div>
        <div className="psl__topbar-r">
          <button className="psl__icon-btn" title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .4 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.8-.4 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.4l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .4-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.4-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.8.4H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.4l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.4 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>
          </button>
          <button className="psl__chip-btn psl__chip-btn--accent" style={{ height: 28 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M5 12h14M12 5v14"/></svg>
            Quick Capture · <span className="psl__hk">⌘⇧C</span>
          </button>
        </div>
      </header>

      <aside className="psl__left">
        <div className="psl__left-section-row">
          <span className="psl__left-section">Library</span>
          <button className="psl__rail-collapse" title="Collapse sidebar">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="m15 6-6 6 6 6"/></svg>
          </button>
        </div>
        <button className={"psl__nav" + (activeApp==="all"?" is-active":"")} onClick={()=>setActiveApp("all")}>
          <span className="psl__nav-icon psl__nav-icon--mono"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></span>
          <span className="psl__nav-label">All Captures</span>
          <span className="psl__nav-count">{TOTAL_CAPTURES}</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon psl__nav-icon--mono"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>
          <span className="psl__nav-label">Today</span>
          <span className="psl__nav-count">14</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon psl__nav-icon--mono"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4l1 16h12l1-16"/><path d="M9 4V2h6v2"/></svg></span>
          <span className="psl__nav-label">Trash</span>
          <span className="psl__nav-count">2</span>
        </button>

        <div className="psl__left-section">Source App</div>
        {railApps.map((app) => (
          <button
            key={app}
            className={"psl__nav" + (activeApp===app?" is-active":"")}
            onClick={()=>setActiveApp(app)}
          >
            <span className="psl__nav-icon psl__nav-icon--bundle"><PsBundleIcon app={app} size={18} /></span>
            <span className="psl__nav-label">{APP_INFO[app].name}</span>
            <span className="psl__nav-count">{RAIL_COUNTS[app] ?? 0}</span>
          </button>
        ))}

        <div className="psl__left-section">Smart Filters</div>
        <button className="psl__nav">
          <span className="psl__nav-icon psl__nav-icon--mono"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2 9 9l-7 1 5 5-1 7 6-3 6 3-1-7 5-5-7-1z"/></svg></span>
          <span className="psl__nav-label">Pinned</span>
          <span className="psl__nav-count">6</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon psl__nav-icon--mono"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0Z"/><path d="m9 12 2 2 4-4"/></svg></span>
          <span className="psl__nav-label">Bug repros</span>
          <span className="psl__nav-count">5</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon psl__nav-icon--mono"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h16v6H4zM4 14h16v6H4z"/></svg></span>
          <span className="psl__nav-label">Has annotations</span>
          <span className="psl__nav-count">11</span>
        </button>
      </aside>

      {/* Main area swaps based on view */}
      {view === "grid" ? (
        <main className="psl__main" style={{ gridColumn: "2 / -1" }}>
          <div className="psl__grid-only">
            {grouped.map((g) => (
              <div key={g.day}>
                <div className="psl__day-hdr">
                  <span className="psl__day-hdr-label">{g.day}</span>
                  <span className="psl__day-hdr-meta">{g.date} · {g.items.length} captures</span>
                </div>
                <div className="psl__grid">
                  {g.items.map((c) => (
                    <div
                      key={c.id}
                      className={"psl__cell" + (c.id === selected && focusOpen ? " is-was-open" : "") + (c.id === selected ? " is-selected" : "")}
                      onClick={() => openFocus(c.id)}
                    >
                      <div className="psl__cell-thumb">
                        <Thumb c={c} />
                        <span className="psl__cell-time">{c.time}</span>
                        <span className="psl__cell-app">
                          <PsAppTag app={c.app} name={APP_INFO[c.app].name} size="sm" />
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </main>
      ) : (
        <main className="psl__main" style={{ gridColumn: "2 / 3" }}>
          <ReelBody visible={visible} selected={selected} setSelected={setSelected} current={current} posLabel={posLabel} />
        </main>
      )}

      {/* In Reel mode the right rail is always visible */}
      {view === "reel" && <DetailRail current={current} />}

      {/* Focus overlay sits above the grid when triggered */}
      {focusOpen && view === "grid" && (
        <FocusStage
          current={current}
          onClose={closeFocus}
          onPrev={() => navInFocus(-1)}
          onNext={() => navInFocus(+1)}
          posLabel={posLabel}
        />
      )}

      <footer className="psl__status">
        <div className="psl__status-l">
          <span><span className="a">●</span> 145 MB snaps</span>
          <span>Codex auto-tag <b>on</b></span>
        </div>
        <div className="psl__status-r">
          <span>⌘⇧C new · ⌘L library</span>
          <span><b>v0.0.1</b></span>
        </div>
      </footer>
    </div>
  );
}

window.PS = window.PS || {};
Object.assign(window.PS, { Library, CAPTURES });
