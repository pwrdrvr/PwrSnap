/* eslint-disable */
// PwrSnap v2 Layer Editor — shell + canvas + toolbar
// ----------------------------------------------------------
// Surface: macOS chrome · top toolbar · canvas · right activity bar · right panel.
// Reads like v1 on day one; the layer model + AI primitives live behind the
// activity bar. See ../CLAUDE.md for the brand mark + hotkey rules.

const { useState: usePseState, useMemo: usePseMemo, useEffect: usePseEffect } = React;
const { PsAppIcon, PsAppTag, PsBundleIcon, APP_INFO } = window.PS;

// ============================================================
// Layer tree — the v2 data model that backs the canvas
// ----------------------------------------------------------
// Order: index 0 = front-most, last = back-most (base capture).
// Each layer carries:
//   id     — stable handle (also used by `layers:*` IPC)
//   kind   — vector | effect | raster | text
//   sub    — arrow / rect / blur / highlight / text / image — what to render
//   source — you | codex (with ai_run_id for batch undo)
//   name   — surfaces in Layers panel; "Blur" not "effect_layer"
//   visible
//   geom   — absolute canvas px (R3 of bundle plan: no normalization math)
//   style  — kind-specific stroke / fill / radius / mode / etc
// ============================================================

const CANVAS_W = 2246;
const CANVAS_H = 1496;

const LAYER_TREE = [
  {
    id: "lyr_text_clickhere", kind: "text",
    source: "codex", aiRun: "run_a8c2",
    name: 'Text — "click here"',
    visible: true,
    geom: { x: 1700, y: 1290, w: 130, h: 28 },
    style: { text: "click here" },
  },
  {
    id: "lyr_arrow_send", kind: "vector", sub: "arrow",
    source: "codex", aiRun: "run_a8c2",
    name: "Arrow — Send button",
    visible: true,
    geom: { from: { x: 1810, y: 1330 }, to: { x: 2010, y: 1395 } },
    style: { stroke: "#ff8a1f", width: 6, head: "triangle" },
    label: null,
  },
  {
    id: "lyr_blur_branch_a", kind: "effect", sub: "blur",
    source: "codex", aiRun: "run_a8c2",
    name: "Blur — branch fix/telegram-…",
    visible: true,
    geom: { x: 130, y: 935, w: 460, h: 36 },
    style: { mode: "soft", radius: 6 },
  },
  {
    id: "lyr_blur_branch_b", kind: "effect", sub: "blur",
    source: "codex", aiRun: "run_a8c2",
    name: "Blur — branch fix/messaging-…",
    visible: true,
    geom: { x: 130, y: 1115, w: 510, h: 36 },
    style: { mode: "soft", radius: 6 },
  },
  {
    id: "lyr_blur_branch_c", kind: "effect", sub: "blur",
    source: "codex", aiRun: "run_a8c2",
    name: "Blur — branch feat/messaging-…",
    visible: true,
    geom: { x: 130, y: 1295, w: 480, h: 36 },
    style: { mode: "soft", radius: 6 },
  },
  {
    id: "lyr_highlight_thread", kind: "effect", sub: "highlight",
    source: "you",
    name: "Highlight — selected thread",
    visible: true,
    geom: { x: 56, y: 800, w: 540, h: 165 },
    style: {},
  },
  {
    id: "lyr_raster_terminal", kind: "raster", sub: "image",
    source: "you",
    name: "terminal-error.png  (pasted)",
    visible: true,
    geom: { x: 1500, y: 80, w: 680, h: 270 },
    style: {},
  },
  {
    id: "lyr_base", kind: "raster", sub: "image",
    source: "capture",
    name: "PwrAgnt-thread-2026-05-21.png",
    visible: true, locked: true,
    geom: { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H },
    style: {},
  },
];

// ============================================================
// Chat history — per-capture, carried in the bundle alongside
// tags + description (R6.1).
// ============================================================
const CHAT_HISTORY = [
  {
    role: "user", t: "10:31 AM",
    body: "open this — i need to share it with the team but those branch names are still internal",
  },
  {
    role: "ai", t: "10:31 AM", model: "codex · haiku-4.5",
    body: <>I see <b>three visible branch names</b> in the sidebar (<code>fix/telegram-topic-resume-picker</code>, <code>fix/messaging-turn-admission-debouncing</code>, <code>feat/messaging-streaming-responses-oai</code>) and a fourth that's cut off. I can blur them — what level: soft, pixelate, or full redact?</>,
  },
  {
    role: "user", t: "10:32 AM",
    body: "soft. and add an arrow to the send button so people know where to look",
  },
  {
    role: "ai", t: "10:32 AM", model: "codex · haiku-4.5",
    body: <>Done. Added <b>five layers</b> to the canvas. The blurs re-sample pixels underneath, so if any of them are slightly off you can drag them and they'll track. Want me to also blur the thread title at the top?</>,
    placedLayers: [
      { ico: "blur",  name: "Blur — branch fix/telegram-…",       layerId: "lyr_blur_branch_a" },
      { ico: "blur",  name: "Blur — branch fix/messaging-…",      layerId: "lyr_blur_branch_b" },
      { ico: "blur",  name: "Blur — branch feat/messaging-…",     layerId: "lyr_blur_branch_c" },
      { ico: "arrow", name: "Arrow — Send button",                 layerId: "lyr_arrow_send" },
      { ico: "text",  name: 'Text — "click here"',                 layerId: "lyr_text_clickhere" },
    ],
    aiRun: "run_a8c2",
  },
];

// Capture metadata — the Info panel reads from this
const CAPTURE_META = {
  title: "PwrAgnt — Telegram resume thread (review)",
  description: "Reviewing the resume-menu repro thread before posting in #eng. Branch names need to come out before sharing.",
  filename: "pwrsnap-2026-05-21-pwragent-telegram-resume",
  app: "electron", appName: "PwrAgnt",
  captured_at: "2026-05-21 10:24:18 PDT",
  dimensions: `${CANVAS_W} × ${CANVAS_H}`,
  device: "MacBook Pro 16″ · 2× retina",
  sha: "9c4f7e3a1bd8e2f0",
  size: "1.3 MB",
  tags: ["pwragent", "thread", "review"],
  bundle: { fmt: "v2", layers: LAYER_TREE.length, edits_v: 14 },
};

// ============================================================
// Layer-type icons — reused across canvas, layer panel, chat
// ============================================================
const LAYER_ICONS = {
  arrow: (sz=12) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 19 19 5M19 5h-7M19 5v7"/></svg>,
  rect: (sz=12) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16"/></svg>,
  blur: (sz=12) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>,
  highlight: (sz=12) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 14-5 5v2h2l5-5"/><path d="M14 9 19 4l3 3-5 5"/><path d="M9 14l5 5"/></svg>,
  text: (sz=12) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 6h14M12 6v14M9 20h6"/></svg>,
  image: (sz=12) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 17 5-5 6 6 4-3 2 2"/></svg>,
  eye_on: (sz=12) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>,
  eye_off: (sz=12) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 3l18 18M6.5 6.5C4 8 2 12 2 12s4 7 10 7c2 0 3.6-.5 5-1.2M9.9 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7-.6 1-1.4 2.1-2.4 3.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>,
  lock:   (sz=12) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>,
  more:   (sz=12) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>,
};

// ============================================================
// Canvas — image base + layer overlay
// ============================================================
function PseArrow({ from, to, color = "#ff8a1f", width = 6 }) {
  // Geom is in canvas px; canvas viewBox === canvas px so coords pass through
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const head = 36;
  const baseX = to.x - ux * head;
  const baseY = to.y - uy * head;
  const wing  = head * 0.55;
  const p1 = [to.x, to.y];
  const p2 = [baseX - uy * wing, baseY + ux * wing];
  const p3 = [baseX + uy * wing, baseY - ux * wing];
  return (
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
         viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} preserveAspectRatio="none"
         xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="pse-arrow-sh" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#000" floodOpacity="0.55" />
        </filter>
      </defs>
      <g filter="url(#pse-arrow-sh)">
        <line x1={from.x} y1={from.y} x2={baseX} y2={baseY}
              stroke={color} strokeWidth={width * 4}
              strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
        <polygon points={`${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`} fill={color}/>
      </g>
    </svg>
  );
}

function CanvasLayer({ layer, selectedId, aiFresh, onSelect, capSrc }) {
  const isSelected = layer.id === selectedId;
  const isAiFresh = aiFresh && layer.aiRun === aiFresh;
  if (!layer.visible) return null;
  // Percent-based positioning so the layer survives canvas scale.
  const pctStyle = layer.geom.x !== undefined ? {
    left:   (layer.geom.x / CANVAS_W * 100) + "%",
    top:    (layer.geom.y / CANVAS_H * 100) + "%",
    width:  (layer.geom.w / CANVAS_W * 100) + "%",
    height: (layer.geom.h / CANVAS_H * 100) + "%",
  } : {};
  const cls = "pse__layer" + (isSelected ? " is-selected" : "") + (isAiFresh ? " is-ai-fresh" : "");

  if (layer.kind === "vector" && layer.sub === "arrow") {
    return (
      <div className={cls + " pse__layer-arrow"} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <PseArrow from={layer.geom.from} to={layer.geom.to} color={layer.style.stroke} width={layer.style.width / 6} />
      </div>
    );
  }
  if (layer.kind === "effect" && layer.sub === "blur") {
    return (
      <div className={cls + " pse__layer-blur" + (layer.style.mode === "pixelate" ? " is-pixelate" : "") + (layer.style.mode === "redact" ? " is-redact" : "")}
           style={pctStyle}
           onClick={(e) => { e.stopPropagation(); onSelect && onSelect(layer.id); }}>
        <span className="pse__layer-blur-tag">{LAYER_ICONS.blur(8)} blur · soft</span>
      </div>
    );
  }
  if (layer.kind === "effect" && layer.sub === "highlight") {
    return <div className={cls + " pse__layer-highlight"} style={pctStyle}
                onClick={(e) => { e.stopPropagation(); onSelect && onSelect(layer.id); }} />;
  }
  if (layer.kind === "vector" && layer.sub === "rect") {
    return <div className={cls + " pse__layer-rect"} style={pctStyle}
                onClick={(e) => { e.stopPropagation(); onSelect && onSelect(layer.id); }} />;
  }
  if (layer.kind === "text") {
    return (
      <div className={cls} style={{ ...pctStyle, width: "auto", height: "auto" }}
           onClick={(e) => { e.stopPropagation(); onSelect && onSelect(layer.id); }}>
        <span className="pse__layer-text">{layer.style.text}</span>
      </div>
    );
  }
  if (layer.kind === "raster" && layer.sub === "image") {
    if (layer.locked) return null; // base image rendered separately
    // Pasted raster — fake terminal screenshot
    return (
      <div className={cls + " pse__layer-raster"} style={pctStyle}
           onClick={(e) => { e.stopPropagation(); onSelect && onSelect(layer.id); }}>
        <PseTerminalScreenshot />
      </div>
    );
  }
  return null;
}

// A faked-up terminal mini-screenshot used as the pasted second image
function PseTerminalScreenshot() {
  return (
    <svg viewBox="0 0 680 270" preserveAspectRatio="none"
         xmlns="http://www.w3.org/2000/svg"
         style={{ width: "100%", height: "100%", display: "block" }}>
      <rect x="0" y="0" width="680" height="270" fill="#0a0a0a"/>
      <rect x="0" y="0" width="680" height="28" fill="#15110b"/>
      <circle cx="16" cy="14" r="5" fill="#ff5f57"/>
      <circle cx="34" cy="14" r="5" fill="#febc2e"/>
      <circle cx="52" cy="14" r="5" fill="#28c840"/>
      <text x="340" y="18" textAnchor="middle" fill="#f5efe3" opacity="0.45"
            fontFamily="Geist Mono, monospace" fontSize="11">~/PwrAgnt — pnpm test</text>
      <g fontFamily="Geist Mono, monospace" fontSize="12">
        <text x="14" y="58"  fill="#ff8a1f">$</text>
        <text x="32" y="58"  fill="#f5efe3">pnpm test apps/desktop/src/main/__tests__/telegram-adapter</text>
        <text x="14" y="86"  fill="#fda984">FAIL</text>
        <text x="62" y="86"  fill="#f5efe3" opacity="0.75">apps/desktop/src/main/__tests__/telegram-adapter.test.ts</text>
        <text x="14" y="110" fill="#f5efe3" opacity="0.55">  ● resume-menu › clears after pick</text>
        <text x="34" y="132" fill="#f5efe3" opacity="0.7">expect(menu.isOpen).toBe(false)</text>
        <text x="14" y="156" fill="#ff5f57">  Expected:</text>
        <text x="110" y="156" fill="#f5efe3">false</text>
        <text x="14" y="178" fill="#28c840">  Received:</text>
        <text x="110" y="178" fill="#f5efe3">true</text>
        <text x="14" y="208" fill="#f5efe3" opacity="0.55">  at Object.{`<anonymous>`} (telegram-adapter.test.ts:104:21)</text>
        <text x="14" y="236" fill="#ff8a1f">$</text>
        <rect x="32" y="226" width="9" height="14" fill="#f5efe3" opacity="0.7"/>
      </g>
    </svg>
  );
}

// ============================================================
// EditorCanvas — wraps the image + overlays in a scaled card
// ============================================================
function EditorCanvas({
  capSrc, layers, selectedId, setSelectedId, aiFresh, showDropTarget = false, dropMessage = null,
  zoom = 0.52,
}) {
  const w = CANVAS_W * zoom;
  const h = CANVAS_H * zoom;
  const ordered = [...layers].reverse();
  return (
    <div className="pse__canvas" style={{
        width: w, height: h,
        backgroundImage: `url(${capSrc})`,
        backgroundSize: "cover",
        backgroundPosition: "top left",
        backgroundRepeat: "no-repeat",
      }} onClick={() => setSelectedId && setSelectedId(null)}>
      <div className="pse__overlay">
        {ordered.map((L) => (
          <CanvasLayer key={L.id} layer={L} selectedId={selectedId} aiFresh={aiFresh}
                       onSelect={setSelectedId} capSrc={capSrc} />
        ))}
        {showDropTarget && (
          <div className="pse__drop-target" style={{
            left: (showDropTarget.x / CANVAS_W * 100) + "%",
            top:  (showDropTarget.y / CANVAS_H * 100) + "%",
            width:  (showDropTarget.w / CANVAS_W * 100) + "%",
            height: (showDropTarget.h / CANVAS_H * 100) + "%",
          }}>
            {dropMessage}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Editor chrome — macOS title bar
// ============================================================
function EditorChrome({ filename, dirty, layerCount = 7 }) {
  return (
    <div className="pse__chrome">
      <div className="pse__chrome-lights">
        <span/><span/><span/>
      </div>
      <div className="pse__chrome-title">
        <PsAppIcon app="pwrsnap" size={12} />
        <span>Pwr<span style={{ color: "var(--accent)" }}>Snap</span></span>
        <span style={{ color: "var(--text-muted)" }}>·</span>
        <b>{filename}</b>
        <span className="pse__v2-badge">v2 · {layerCount} layers</span>
        {dirty && <span style={{ color: "var(--text-muted)", font: "500 11px/1 var(--font-mono)" }}>· edited</span>}
      </div>
      <div className="pse__chrome-actions">
        <button title="Copy composed PNG">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
          Copy
        </button>
        <button className="is-primary" title="Done — back to Library">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="m5 12 5 5 9-11"/></svg>
          Done
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Toolbar — tools + undo/redo + zoom readout
// ============================================================
const TOOLS = [
  { id: "pointer", name: "Pointer", key: "V",
    ico: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="m6 3 12 8-5 1.4 3 7-2.6 1.1-3-7L6 17Z"/></svg> },
  { id: "arrow", name: "Arrow", key: "A",
    ico: LAYER_ICONS.arrow(14) },
  { id: "rect", name: "Rect", key: "R",
    ico: LAYER_ICONS.rect(14) },
  { id: "blur", name: "Blur", key: "B",
    ico: LAYER_ICONS.blur(14) },
  { id: "highlight", name: "Highlight", key: "H",
    ico: LAYER_ICONS.highlight(14) },
  { id: "text", name: "Text", key: "T",
    ico: LAYER_ICONS.text(14) },
];

function EditorToolbar({ tool, setTool, undoLabel }) {
  return (
    <div className="pse__toolbar">
      {TOOLS.map((t) => (
        <button key={t.id}
                className={"pse__tool" + (tool === t.id ? " is-active" : "")}
                onClick={() => setTool(t.id)}
                title={`${t.name} (${t.key})`}>
          <span className="pse__tool-ico">{t.ico}</span>
          <span>{t.name}</span>
          <span className="pse__tool-key">{t.key}</span>
        </button>
      ))}

      <div className="pse__tool-sep" />

      <button className="pse__tool is-icon-only" title={undoLabel || "Undo (⌘Z)"}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/></svg>
      </button>
      <button className="pse__tool is-icon-only" title="Redo (⌘⇧Z)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/></svg>
      </button>

      {undoLabel && (
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          marginLeft: 6,
          height: 22, padding: "0 8px",
          background: "var(--accent-soft)",
          border: "1px solid var(--accent-border)",
          borderRadius: 4,
          font: "600 10px/1 var(--font-mono)",
          color: "var(--accent-bright)",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}>
          ↶ {undoLabel}
        </span>
      )}

      <div className="pse__toolbar-spacer" />

      <button className="pse__tool" title="Fit to window (⌘0)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
        Fit
      </button>
      <div className="pse__zoom-readout">
        <b>52%</b>
        <span style={{ color: "var(--text-muted)" }}>·</span>
        <span>1167 × 778</span>
      </div>
    </div>
  );
}

// ============================================================
// Activity bar — right-edge icon strip
// ============================================================
const ACT_ICONS = {
  info:   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8v.5"/></svg>,
  chat:   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>,
  layers: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 18 9 5 9-5"/></svg>,
  style:  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"><path d="M12 3a9 9 0 1 0 0 18c1.7 0 3-1.3 3-3 0-.8.4-1.5 1-2h1a4 4 0 0 0 4-4 9 9 0 0 0-9-9Z"/><circle cx="7.5" cy="11.5" r="1.2" fill="currentColor"/><circle cx="11" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16" cy="9" r="1.2" fill="currentColor"/></svg>,
  collapse: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 6-6 6 6 6"/></svg>,
  help: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5q0-2.5 2.5-2.5t2.5 2.5q0 1.4-1.2 2-1 .6-1.3 1.5v0.5M12 16v.4"/></svg>,
};

function ActivityBar({ active, setActive, layerCount }) {
  const items = [
    { id: "info",   ico: ACT_ICONS.info,   title: "Info" },
    { id: "chat",   ico: ACT_ICONS.chat,   title: "Chat with Codex", badge: "2" },
    { id: "layers", ico: ACT_ICONS.layers, title: "Layers", badge: layerCount },
    { id: "style",  ico: ACT_ICONS.style,  title: "Style" },
  ];
  return (
    <div className="pse__activity">
      {items.map((it) => (
        <button key={it.id}
                className={"pse__act-btn" + (active === it.id ? " is-active" : "")}
                onClick={() => setActive(active === it.id ? null : it.id)}
                title={it.title}>
          {it.ico}
          {it.badge ? <span className="pse__act-badge">{it.badge}</span> : null}
        </button>
      ))}
      <div className="pse__act-divider" />
      <div className="pse__act-spacer" />
      <button className="pse__act-btn" title="Help">{ACT_ICONS.help}</button>
    </div>
  );
}

window.PSE = window.PSE || {};
Object.assign(window.PSE, {
  LAYER_TREE, CHAT_HISTORY, CAPTURE_META, LAYER_ICONS,
  EditorChrome, EditorToolbar, EditorCanvas, ActivityBar,
  CANVAS_W, CANVAS_H,
});
