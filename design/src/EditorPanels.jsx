/* eslint-disable */
// PwrSnap v2 Editor — right-sidebar panels
// Four panels exposed by the activity bar: Info / Chat / Layers / Style.
// Each is self-contained; only the parent picks which is mounted.

const { useState: usePsePState } = React;
const { LAYER_ICONS, LAYER_TREE, CHAT_HISTORY, CAPTURE_META } = window.PSE;
const { PsAppTag, PsAppIcon, APP_INFO } = window.PS;

// ============================================================
// Panel header — shared chrome
// ============================================================
function PanelHeader({ title, icon, pinned, onPin, onClose }) {
  return (
    <div className="pse__panel-hdr">
      <span className="pse__panel-hdr-title">
        {icon}
        {title}
      </span>
      <span className="pse__panel-hdr-actions">
        <button className={"pse__panel-hdr-btn" + (pinned ? " is-pinned" : "")}
                title={pinned ? "Unpin (auto-hide on mouse-out)" : "Pin (keep open)"}
                onClick={onPin}>
          {pinned
            ? <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M14 3 11 6l-1 1H6l3 3-5 5v2h2l5-5 3 3v-4l1-1 3-3-4-4Z"/></svg>
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M14 3 11 6l-1 1H6l3 3-5 5v2h2l5-5 3 3v-4l1-1 3-3-4-4Z"/></svg>
          }
        </button>
        <button className="pse__panel-hdr-btn" title="Close (Esc)" onClick={onClose}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>
        </button>
      </span>
    </div>
  );
}

// ============================================================
// INFO PANEL
// ============================================================
function InfoPanel(props) {
  const m = CAPTURE_META;
  return (
    <>
      <PanelHeader title="Info" icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8v.5"/></svg>} {...props} />
      <div className="pse__panel-body">

        <div className="pse__info-hero">
          <div className="pse__info-tag-row">
            <PsAppTag app={m.app} name={m.appName} size="sm" />
            <span className="ps-tag is-accent">{m.bundle.fmt}</span>
          </div>
          <div className="pse__info-title">{m.title}</div>
          <div className="pse__info-stem">{m.filename}.png</div>
        </div>

        <div className="pse__field">
          <label className="pse__field-label">Title</label>
          <input className="pse__field-input" defaultValue={m.title} />
        </div>

        <div className="pse__field">
          <label className="pse__field-label">Description</label>
          <textarea className="pse__field-textarea" defaultValue={m.description} />
        </div>

        <div className="pse__field">
          <label className="pse__field-label">Tags</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {m.tags.map((t) => (
              <span key={t} className="ps-tag">{t}</span>
            ))}
            <button className="ps-tag is-suggest">+ tag</button>
          </div>
        </div>

        <div className="pse__field">
          <label className="pse__field-label">Capture</label>
          <div className="pse__meta-row">
            <span className="pse__meta-k">Captured</span>
            <span className="pse__meta-v">{m.captured_at}</span>
          </div>
          <div className="pse__meta-row">
            <span className="pse__meta-k">Source</span>
            <span className="pse__meta-v"><b>{m.appName}</b></span>
          </div>
          <div className="pse__meta-row">
            <span className="pse__meta-k">Dimensions</span>
            <span className="pse__meta-v">{m.dimensions}</span>
          </div>
          <div className="pse__meta-row">
            <span className="pse__meta-k">Device</span>
            <span className="pse__meta-v">{m.device}</span>
          </div>
          <div className="pse__meta-row">
            <span className="pse__meta-k">SHA</span>
            <span className="pse__meta-v">{m.sha}</span>
          </div>
          <div className="pse__meta-row">
            <span className="pse__meta-k">Size</span>
            <span className="pse__meta-v">{m.size}</span>
          </div>
        </div>

        <div className="pse__field">
          <label className="pse__field-label">Bundle</label>
          <div className="pse__meta-row">
            <span className="pse__meta-k">Format</span>
            <span className="pse__meta-v is-accent"><b>{m.bundle.fmt}</b> · layer tree</span>
          </div>
          <div className="pse__meta-row">
            <span className="pse__meta-k">Layers</span>
            <span className="pse__meta-v"><b>{m.bundle.layers}</b></span>
          </div>
          <div className="pse__meta-row">
            <span className="pse__meta-k">edits_v</span>
            <span className="pse__meta-v">{m.bundle.edits_v}</span>
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================
// LAYERS PANEL
// ============================================================
function LayersPanel({ layers, selectedId, setSelectedId, onToggleVis, ...props }) {
  return (
    <>
      <PanelHeader title="Layers" icon={LAYER_ICONS.image ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 18 9 5 9-5"/></svg> : null} {...props} />
      <div className="pse__panel-body">
        <div className="pse__layers-list">
          {layers.map((L) => {
            const cls = "pse__lrow"
              + (selectedId === L.id ? " is-selected" : "")
              + (!L.visible ? " is-hidden" : "");
            const typeKey =
              L.kind === "vector" ? L.sub :
              L.kind === "effect" ? L.sub :
              L.kind === "text" ? "text" : "image";
            const typeCls =
              L.locked ? "is-base"
              : L.kind === "raster" ? "is-raster"
              : "";
            return (
              <div key={L.id} className={cls} onClick={() => setSelectedId(L.id)}>
                <button className={"pse__lrow-eye" + (L.visible ? " is-on" : " is-off")}
                        title={L.visible ? "Hide" : "Show"}
                        onClick={(e) => { e.stopPropagation(); onToggleVis && onToggleVis(L.id); }}>
                  {L.visible ? LAYER_ICONS.eye_on(13) : LAYER_ICONS.eye_off(13)}
                </button>
                <span className={"pse__lrow-type " + typeCls}>
                  {L.locked ? LAYER_ICONS.lock(11) : LAYER_ICONS[typeKey] ? LAYER_ICONS[typeKey](11) : null}
                </span>
                <span className="pse__lrow-name">{L.name}</span>
                <span className={"pse__lrow-source " + (L.source === "codex" ? "is-codex" : L.source === "capture" ? "is-base" : "")}>
                  {L.source}
                </span>
                <button className="pse__lrow-more" title="More…">{LAYER_ICONS.more(13)}</button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="pse__layers-foot">
        <span><b>{layers.length}</b> layers · <b>{layers.filter((L) => L.source === "codex").length}</b> from codex</span>
        <span>top = front</span>
      </div>
    </>
  );
}

// ============================================================
// STYLE PANEL
// ============================================================
function StylePanel({ selectedLayer, ...props }) {
  return (
    <>
      <PanelHeader title="Style" icon={
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
          <path d="M12 3a9 9 0 1 0 0 18c1.7 0 3-1.3 3-3 0-.8.4-1.5 1-2h1a4 4 0 0 0 4-4 9 9 0 0 0-9-9Z"/>
          <circle cx="7.5" cy="11.5" r="1.2" fill="currentColor"/>
          <circle cx="11" cy="7.5" r="1.2" fill="currentColor"/>
          <circle cx="16" cy="9" r="1.2" fill="currentColor"/>
        </svg>
      } {...props} />
      <div className="pse__panel-body">
        {!selectedLayer ? (
          <div className="pse__style-empty">
            <b>No layer selected</b>
            Click a layer in the canvas or the Layers panel to edit its properties here.
          </div>
        ) : (
          <StyleForLayer L={selectedLayer} />
        )}
      </div>
    </>
  );
}

function StyleForLayer({ L }) {
  // pick a header icon
  const headerIco =
    L.kind === "vector" && L.sub === "arrow"     ? LAYER_ICONS.arrow(13) :
    L.kind === "vector" && L.sub === "rect"      ? LAYER_ICONS.rect(13) :
    L.kind === "effect" && L.sub === "blur"      ? LAYER_ICONS.blur(13) :
    L.kind === "effect" && L.sub === "highlight" ? LAYER_ICONS.highlight(13) :
    L.kind === "text"                            ? LAYER_ICONS.text(13) :
    L.kind === "raster"                          ? LAYER_ICONS.image(13) : null;

  // Compute display geometry
  let x = L.geom.x ?? L.geom.from?.x ?? 0;
  let y = L.geom.y ?? L.geom.from?.y ?? 0;
  let w = L.geom.w ?? Math.abs((L.geom.to?.x ?? 0) - (L.geom.from?.x ?? 0));
  let h = L.geom.h ?? Math.abs((L.geom.to?.y ?? 0) - (L.geom.from?.y ?? 0));

  return (
    <>
      <div className="pse__style-hdr">
        <span className="pse__style-hdr-icon">{headerIco}</span>
        <span className="pse__style-hdr-name">
          {L.name}
          <small>id: {L.id} · source: {L.source}{L.aiRun ? ` · ${L.aiRun}` : ""}</small>
        </span>
      </div>

      <div className="pse__style-grp">
        <div className="pse__style-grp-label">Position · canvas px</div>
        <div className="pse__num-grid">
          <div className="pse__num-cell"><span className="pse__num-cell-label">X</span><input className="pse__num-cell-input" defaultValue={Math.round(x)} /></div>
          <div className="pse__num-cell"><span className="pse__num-cell-label">Y</span><input className="pse__num-cell-input" defaultValue={Math.round(y)} /></div>
          <div className="pse__num-cell"><span className="pse__num-cell-label">W</span><input className="pse__num-cell-input" defaultValue={Math.round(w)} /></div>
          <div className="pse__num-cell"><span className="pse__num-cell-label">H</span><input className="pse__num-cell-input" defaultValue={Math.round(h)} /></div>
        </div>
      </div>

      {L.kind === "effect" && L.sub === "blur" && (
        <>
          <div className="pse__style-grp">
            <div className="pse__style-grp-label">Mode</div>
            <div className="pse__seg">
              <button className={L.style.mode === "soft" ? "is-on" : ""}>Soft</button>
              <button className={L.style.mode === "pixelate" ? "is-on" : ""}>Pixel</button>
              <button className={L.style.mode === "redact" ? "is-on" : ""}>Redact</button>
            </div>
          </div>
          <div className="pse__style-grp">
            <div className="pse__style-grp-label">Radius</div>
            <div className="pse__slider-row">
              <input type="range" min="2" max="24" defaultValue={L.style.radius ?? 6} />
              <span className="pse__slider-val">{L.style.radius ?? 6}px</span>
            </div>
            <div className="pse__field-help">Sample-below — re-renders as layers underneath move</div>
          </div>
        </>
      )}

      {L.kind === "vector" && L.sub === "arrow" && (
        <>
          <div className="pse__style-grp">
            <div className="pse__style-grp-label">Color</div>
            <div className="pse__color-row">
              <span className="pse__sw is-on" style={{ background: "#ff8a1f" }}/>
              <span className="pse__sw" style={{ background: "#ff5f57" }}/>
              <span className="pse__sw" style={{ background: "#28c840" }}/>
              <span className="pse__sw" style={{ background: "#1f7cff" }}/>
              <span className="pse__sw" style={{ background: "#f5efe3" }}/>
              <span className="pse__sw" style={{ background: "#0a0a0a", borderColor: "var(--border-strong)" }}/>
            </div>
          </div>
          <div className="pse__style-grp">
            <div className="pse__style-grp-label">Thickness</div>
            <div className="pse__slider-row">
              <input type="range" min="1" max="12" defaultValue={L.style.width ?? 6} />
              <span className="pse__slider-val">{L.style.width ?? 6}px</span>
            </div>
          </div>
          <div className="pse__style-grp">
            <div className="pse__style-grp-label">Arrowhead</div>
            <div className="pse__seg">
              <button>None</button>
              <button className="is-on">Solid</button>
              <button>Open</button>
            </div>
          </div>
        </>
      )}

      {L.kind === "effect" && L.sub === "highlight" && (
        <>
          <div className="pse__style-grp">
            <div className="pse__style-grp-label">Tint</div>
            <div className="pse__color-row">
              <span className="pse__sw is-on" style={{ background: "rgba(255,138,31,0.5)" }}/>
              <span className="pse__sw" style={{ background: "rgba(255,237,46,0.5)" }}/>
              <span className="pse__sw" style={{ background: "rgba(81,255,113,0.5)" }}/>
              <span className="pse__sw" style={{ background: "rgba(31,124,255,0.5)" }}/>
            </div>
          </div>
          <div className="pse__style-grp">
            <div className="pse__style-grp-label">Blend</div>
            <div className="pse__seg">
              <button>Normal</button>
              <button className="is-on">Screen</button>
              <button>Multiply</button>
            </div>
          </div>
        </>
      )}

      <div className="pse__style-grp">
        <div className="pse__style-grp-label">Opacity</div>
        <div className="pse__slider-row">
          <input type="range" min="0" max="100" defaultValue="100" />
          <span className="pse__slider-val">100%</span>
        </div>
      </div>
    </>
  );
}

// ============================================================
// CHAT PANEL
// ============================================================
function ChatPanel({ onUndoRun, ...props }) {
  return (
    <>
      <PanelHeader title="Chat with Codex" icon={
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>
      } {...props} />
      <div className="pse__chat">

        <div className="pse__chat-list">
          {/* per-capture context line */}
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 10px",
            background: "var(--bg-panel-elevated)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            font: "500 10.5px/1.3 var(--font-mono)",
            color: "var(--text-muted)",
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4"/></svg>
            <span><b style={{ color: "var(--text-secondary)" }}>context</b> · 1 capture · 8 layers · 2246×1496</span>
          </div>

          {CHAT_HISTORY.map((m, i) => (
            <ChatMessage key={i} m={m} onUndo={() => onUndoRun && onUndoRun(m.aiRun)} />
          ))}
        </div>

        {/* Composer */}
        <div className="pse__composer">
          <div className="pse__composer-area">
            <textarea placeholder="reply to codex — describe what to annotate, blur, or label…" />
            <div className="pse__composer-foot">
              <div className="pse__composer-chips">
                <span className="pse__composer-chip is-context">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 17 5-5 6 6 4-3 2 2"/></svg>
                  capture
                </span>
                <span className="pse__composer-chip is-context">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 18 9 5 9-5"/></svg>
                  8 layers
                </span>
                <span className="pse__composer-chip">haiku-4.5</span>
              </div>
              <button className="pse__composer-send">
                <span>Send</span>
                <span className="pse__hk-kbd" style={{ background: "rgba(0,0,0,0.18)", borderColor: "rgba(0,0,0,0.22)", color: "var(--button-text-on-accent)" }}>⏎</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ChatMessage({ m, onUndo }) {
  const isUser = m.role === "user";
  const cls = "pse__msg " + (isUser ? "is-user" : "is-ai");
  return (
    <div className={cls}>
      <div className="pse__msg-hdr">
        <span className="pse__msg-author">{isUser ? "you" : "codex"}</span>
        <span className="pse__msg-meta">{m.model || ""} · {m.t}</span>
      </div>
      <div className="pse__msg-body">{m.body}</div>

      {m.placedLayers && (
        <div className="pse__ai-result">
          <div className="pse__ai-result-hdr">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.2 5.4 5.8.4-4.4 3.8 1.4 5.6L12 14.6 6.9 17.2l1.4-5.6L4 7.8l5.8-.4L12 2Z"/></svg>
              Codex added {m.placedLayers.length} layers
            </span>
            <small>{m.aiRun}</small>
          </div>
          <div className="pse__ai-result-items">
            {m.placedLayers.map((p, i) => (
              <div key={i} className="pse__ai-result-row">
                {LAYER_ICONS[p.ico] ? LAYER_ICONS[p.ico](12) : null}
                <span>{p.name}</span>
                <small>{p.layerId}</small>
              </div>
            ))}
          </div>
          <div className="pse__ai-result-foot">
            <button onClick={onUndo} title="Remove all five layers as one step">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/></svg>
              Undo this suggestion
            </button>
            <button className="is-ghost">Tweak…</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Panel orchestrator
// ============================================================
function PanelHost({ active, ...props }) {
  let inner = null;
  if (active === "info")   inner = <InfoPanel {...props} />;
  if (active === "chat")   inner = <ChatPanel {...props} />;
  if (active === "layers") inner = <LayersPanel {...props} />;
  if (active === "style")  inner = <StylePanel {...props} />;
  if (!inner) return null;
  return <div className="pse__panel">{inner}</div>;
}

Object.assign(window.PSE, {
  InfoPanel, ChatPanel, LayersPanel, StylePanel, PanelHost, ChatMessage,
});
