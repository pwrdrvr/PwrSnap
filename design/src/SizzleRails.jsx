/* eslint-disable */
// PwrSnap Sizzle Reels — right-rail panels + transitions popover
//
// Exposes window.SZL.{ RightRail, TransitionsPopover, ProjectAssetsPanel,
//                       ProjectChatPanel, DetailsPanel }.

const SZR_R = React;
const { useState: useStateSZR, useEffect: useEffectSZR, useRef: useRefSZR } = SZR_R;

const { PROJECTS, ASSET_BANK, TRANSITIONS, VOICES,
        transitionByKey, formatDur, totalDur,
        ProjectIcon, KindIcon, TransitionIcon, MiniThumb } = window.SZL;

// ============================================================
// VERTICAL ICON STRIP — left edge of right rail
// ============================================================
const RAIL_TABS = [
  { key: "assets", label: "Project Assets",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1"/></svg> },
  { key: "chat",   label: "AI Chat",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M4 5h16v11h-7l-5 4v-4H4z"/></svg> },
  { key: "detail", label: "Details",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v.01M11 12h1v5h1"/></svg> },
];

function RailStrip({ active, setActive, badges }) {
  return (
    <div className="szl-rail__strip">
      {RAIL_TABS.map((t) => (
        <button
          key={t.key}
          className={"szl-rail__tab" + (active === t.key ? " is-active" : "")}
          onClick={() => setActive(t.key)}
          title={t.label}
        >
          {t.icon}
          {badges && badges[t.key] != null && badges[t.key] > 0 && (
            <span className="szl-rail__tab-badge">{badges[t.key]}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ============================================================
// TRANSITIONS popover — picker, used inline anywhere
// ============================================================
function TransitionsPopover({ current, onPick, style }) {
  return (
    <div className="szl-trans-pop" style={style} onClick={(e) => e.stopPropagation()}>
      <div className="szl-trans-pop__hdr">
        <span>Transition</span>
        <small>between clips</small>
      </div>
      {TRANSITIONS.map((t) => (
        <button
          key={t.key}
          className={"szl-trans-pop__row" + (current === t.key ? " is-on" : "")}
          onClick={() => onPick(t.key)}
        >
          <span className="szl-trans-pop__row-icon">
            <TransitionIcon keyName={t.key} size={13} />
          </span>
          <span className="szl-trans-pop__row-l">
            <span className="szl-trans-pop__row-name">{t.name}</span>
          </span>
          <span className="szl-trans-pop__row-dur">{t.dur === 0 ? "—" : `${t.dur}s`}</span>
        </button>
      ))}
      <div className="szl-trans-pop__foot">
        <button>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.2 5.4 5.8.4-4.4 3.8 1.4 5.6L12 14.6 6.9 17.2l1.4-5.6L4 7.8l5.8-.4L12 2Z"/></svg>
          Ask AI to remix
        </button>
      </div>
    </div>
  );
}

// ============================================================
// PROJECT ASSETS — picker dropdown + ordered list of clips
// ============================================================
function ProjectAssetsPanel({ project, setProject, selectedClipIdx, setSelectedClipIdx, onOpenProject, allProjects }) {
  const [pickerOpen, setPickerOpen] = useStateSZR(false);

  if (!project) {
    return (
      <div className="szl-pa">
        <div className="szl-pa__hdr">
          <div className="szl-pa__hdr-row">
            <span className="szl-pa__title">Project Assets</span>
          </div>
        </div>
        <div className="szl-pa__empty">
          <div className="szl-pa__empty-h">No project open</div>
          <div className="szl-pa__empty-p">
            Pick a project below, or hit <b style={{color:"var(--accent-bright)"}}>+ New Project</b> in the titlebar to start a sizzle reel.
          </div>
          <button className="szl-pa__cta" onClick={() => setPickerOpen(true)}>
            Pick a project
          </button>
        </div>
      </div>
    );
  }

  const totalSecs = totalDur(project);
  const wordCount = project.clips.reduce((sum, c) => sum + (c.scriptOverride || "").split(/\s+/).filter(Boolean).length, 0);

  return (
    <div className="szl-pa">
      <div className="szl-pa__hdr">
        <div className="szl-pa__hdr-row">
          <span className="szl-pa__title">Project Assets · {project.clips.length}</span>
          <div className="szl-pa__hdr-actions">
            <button className="szl-pa__icon-btn" title="Sort">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 4v16M7 4l-3 4M7 4l3 4M17 20V4M17 20l-3-4M17 20l3-4"/></svg>
            </button>
            <button className="szl-pa__icon-btn" title="Ask AI to reorder">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.2 5.4 5.8.4-4.4 3.8 1.4 5.6L12 14.6 6.9 17.2l1.4-5.6L4 7.8l5.8-.4L12 2Z"/></svg>
            </button>
          </div>
        </div>

        <div className="szl-pa__select" onClick={() => setPickerOpen(!pickerOpen)}>
          <span className="szl-pa__select-icon"><ProjectIcon size={11}/></span>
          <span className="szl-pa__select-l">
            <span className="szl-pa__select-name">{project.name}</span>
            <span className="szl-pa__select-meta">sizzle-reel · {project.modified}</span>
          </span>
          <svg className="szl-pa__select-caret" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="m6 9 6 6 6-6z"/></svg>

          {pickerOpen && (
            <div className="szl-pa__popover">
              <div className="szl-pa__popover-hdr">
                <span>Projects · {allProjects.length}</span>
                <small>recent first</small>
              </div>
              {allProjects.map((p) => (
                <button
                  key={p.id}
                  className={"szl-pa__popover-row" + (p.id === project.id ? " is-active" : "")}
                  onClick={(e) => { e.stopPropagation(); setProject(p); setPickerOpen(false); }}
                >
                  <span className="szl-pa__popover-row__icon"><ProjectIcon size={11}/></span>
                  <span className="szl-pa__popover-row__l">
                    <span className="szl-pa__popover-row__name">{p.name}</span>
                    <span className="szl-pa__popover-row__meta">{p.clips.length} clips · {p.modified}</span>
                  </span>
                  <span className="szl-pa__popover-row__dur">{formatDur(totalDur(p))}</span>
                </button>
              ))}
              <div className="szl-pa__popover-foot">
                <button onClick={(e) => { e.stopPropagation(); setPickerOpen(false); }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14M12 5v14"/></svg>
                  New Sizzle Reel project
                </button>
                <button onClick={(e) => { e.stopPropagation(); setPickerOpen(false); }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
                  Browse all
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="szl-pa__counts">
          <span><b>{formatDur(totalSecs)}</b> total</span>
          <span>·</span>
          <span><b>{wordCount}</b> words</span>
          <span>·</span>
          <span><b>{Math.round(wordCount/(totalSecs||1)*60)}</b> wpm</span>
        </div>
      </div>

      <div className="szl-pa__list">
        {project.clips.map((c, i) => {
          const a = ASSET_BANK.find((x) => x.id === c.assetId);
          if (!a) return null;
          const dur = c.durOverride ?? a.dur;
          return (
            <div
              key={i}
              className={"szl-pa__item" + (selectedClipIdx === i ? " is-selected" : "")}
              onClick={() => setSelectedClipIdx(i)}
            >
              <span className="szl-pa__item-grip" title="Drag to reorder">
                <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor"><circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/><circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="2" cy="10" r="1"/><circle cx="6" cy="10" r="1"/></svg>
              </span>
              <div className="szl-pa__item-thumb">
                <MiniThumb assetId={a.id} />
                <span className="szl-pa__item-thumb-num">{String(i+1).padStart(2,"0")}</span>
                <span className="szl-pa__item-kind"><KindIcon kind={a.kind} size={8}/></span>
              </div>
              <div className="szl-pa__item-body">
                <span className="szl-pa__item-name">{a.title}</span>
                <span className="szl-pa__item-meta">
                  <b>{a.kind === "video" ? "VID" : "IMG"}</b>
                  <span>{a.stem}</span>
                </span>
              </div>
              <span className="szl-pa__item-dur">{dur.toFixed(1)}s</span>
            </div>
          );
        })}
        <div className="szl-pa__droptarget">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5v14"/></svg>
          Drop captures here · or pick from library
        </div>
      </div>

      <div className="szl-pa__total">
        <span><b>{formatDur(totalSecs)}</b> · {project.clips.length} clips · ~16:9</span>
        <button className="szl-pa__open" onClick={onOpenProject}>
          Open editor
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="m9 6 6 6-6 6"/></svg>
        </button>
      </div>
    </div>
  );
}

// ============================================================
// AI CHAT — project-scoped chat
// ============================================================
const SEED_TURNS = [
  { kind: "agent",
    body: <>I read the script and timed it against the assets. The reel runs <b>32 seconds</b> at <b>~110 WPM</b>. Want me to tighten any of the script lines, swap transitions, or generate a voiceover?</>,
    meta: "haiku-4.5 · 1.4s · saw 6 assets",
  },
  { kind: "user", body: <>Make the transitions cooler. Less fades, more amber wipes and slide-ups.</> },
  { kind: "agent",
    tool: {
      title: "Edited transitions",
      meta: "5 changes · 1.1s",
      diff: [
        { op: "del", text: "clip-02 → clip-03 : fade" },
        { op: "add", text: "clip-02 → clip-03 : amber-wipe (0.5s)" },
        { op: "del", text: "clip-04 → clip-05 : fade" },
        { op: "add", text: "clip-04 → clip-05 : slide-up (0.4s)" },
        { op: "add", text: "clip-01 → clip-02 : slide-left (0.4s)" },
      ],
    },
    body: <>Done. I kept one fade on the opener for breathing room — the rest are now slide-left, amber-wipe, and slide-up. Total duration drifts by <b>+0.6s</b>; do you want me to retime to keep the original 32s?</>,
    meta: "haiku-4.5 · 1.1s · 5 patches",
  },
];

function ProjectChatPanel({ project }) {
  if (!project) {
    return (
      <div className="szl-chat">
        <div className="szl-chat__hdr">
          <div className="szl-chat__hdr-l">
            <span className="szl-chat__hdr-title">AI Chat</span>
            <span className="szl-chat__hdr-meta">no project open</span>
          </div>
        </div>
        <div className="szl-chat__body">
          <div style={{ font: "500 12px/1.55 var(--font-sans)", color: "var(--text-muted)" }}>
            Pick a project to start a chat. The agent sees its assets, script, transitions, and voiceover timings.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="szl-chat">
      <div className="szl-chat__hdr">
        <div className="szl-chat__hdr-l">
          <span className="szl-chat__hdr-title">Chat <b>{project.name}</b></span>
          <span className="szl-chat__hdr-meta">{project.clips.length} clips · {formatDur(totalDur(project))} · voice: {project.voice}</span>
        </div>
        <div className="szl-chat__hdr-tools">
          <button className="szl-pa__icon-btn" title="Pin context">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v9M8 7l4-4 4 4M5 19h14"/></svg>
          </button>
          <button className="szl-pa__icon-btn" title="Clear chat">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 7h14M8 7V4h8v3M6 7l1 14h10l1-14"/></svg>
          </button>
        </div>
      </div>

      <div className="szl-chat__body">
        {SEED_TURNS.map((t, i) => (
          <div key={i} className="szl-chat__turn">
            <div className="szl-chat__turn-hdr">
              <span className={t.kind === "agent" ? "agent" : "user"}>
                {t.kind === "agent" ? "Codex" : "You"}
              </span>
              <small>{t.meta || (t.kind === "user" ? "just now" : "")}</small>
            </div>
            {t.tool && (
              <div className="szl-chat__tool">
                <div className="szl-chat__tool-hdr">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m14 7 3 3-9 9H5v-3z"/><path d="m12 9 3 3"/></svg>
                  {t.tool.title}
                  <small>{t.tool.meta}</small>
                </div>
                <div className="szl-chat__tool-diff">
                  {t.tool.diff.map((d, j) => (
                    <span key={j} className={d.op === "del" ? "del" : "add"}>
                      {d.op === "del" ? "− " : "+ "}{d.text}
                    </span>
                  ))}
                </div>
                <div className="szl-chat__tool-actions">
                  <button className="is-primary">
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-11"/></svg>
                    Keep
                  </button>
                  <button>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4v6h6"/><path d="M4 10a8 8 0 1 1 2 5"/></svg>
                    Undo
                  </button>
                </div>
              </div>
            )}
            <div className={"szl-chat__bubble szl-chat__bubble--" + t.kind}>
              {t.body}
            </div>
          </div>
        ))}

        <div className="szl-chat__suggestions">
          <button className="szl-chat__suggestion">Write the voiceover script</button>
          <button className="szl-chat__suggestion">Add a 3-word hook clip up front</button>
          <button className="szl-chat__suggestion">Cut to 22s for X</button>
        </div>
      </div>

      <div className="szl-chat__composer">
        <textarea placeholder="Ask the agent to remix the reel…  ⌘↵ to send" defaultValue="" />
        <div className="szl-chat__composer-row">
          <div className="szl-chat__composer-chips">
            <span className="szl-chat__composer-chip is-on">{project.name}</span>
            <span className="szl-chat__composer-chip">haiku-4.5</span>
            <span className="szl-chat__composer-chip">edits ON</span>
          </div>
          <button className="szl-chat__composer-send">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M3 11 21 3l-7 18-3-9-8-1z"/></svg>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// DETAILS — per-clip details (re-uses the existing detail vibe)
// ============================================================
function DetailsPanel({ project, selectedClipIdx, setSelectedClipIdx }) {
  if (!project) {
    return (
      <div className="szl-chat">
        <div className="szl-chat__hdr">
          <div className="szl-chat__hdr-l">
            <span className="szl-chat__hdr-title">Details</span>
            <span className="szl-chat__hdr-meta">no project open</span>
          </div>
        </div>
      </div>
    );
  }
  const clip = project.clips[selectedClipIdx];
  if (!clip) {
    return (
      <div className="szl-chat">
        <div className="szl-chat__hdr">
          <div className="szl-chat__hdr-l">
            <span className="szl-chat__hdr-title">Details</span>
            <span className="szl-chat__hdr-meta">{project.name}</span>
          </div>
        </div>
        <div className="szl-chat__body">
          <div style={{ font: "500 12px/1.55 var(--font-sans)", color: "var(--text-muted)" }}>
            Select a clip in the timeline or the Project Assets list to inspect its captured metadata (title, OCR, app, stem) and tune its script line + duration.
          </div>
        </div>
      </div>
    );
  }
  const a = ASSET_BANK.find((x) => x.id === clip.assetId);
  return (
    <div className="szl-chat">
      <div className="szl-chat__hdr">
        <div className="szl-chat__hdr-l">
          <span className="szl-chat__hdr-title">Clip {String(selectedClipIdx+1).padStart(2,"0")}</span>
          <span className="szl-chat__hdr-meta">{a.stem}</span>
        </div>
        <div className="szl-chat__hdr-tools">
          <button className="szl-pa__icon-btn" onClick={() => setSelectedClipIdx(Math.max(0, selectedClipIdx-1))} title="Prev">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 6-6 6 6 6"/></svg>
          </button>
          <button className="szl-pa__icon-btn" onClick={() => setSelectedClipIdx(Math.min(project.clips.length-1, selectedClipIdx+1))} title="Next">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9 6 6 6-6 6"/></svg>
          </button>
        </div>
      </div>

      <div style={{ padding: "14px 14px 18px", display:"flex", flexDirection:"column", gap: 12, overflowY:"auto" }}>
        <div style={{ position:"relative", aspectRatio:"16/10", borderRadius:7, overflow:"hidden", border:"1px solid var(--border-subtle)" }}>
          <MiniThumb assetId={a.id} withPlay={a.kind === "video"} />
        </div>

        <div className="psl__df">
          <label className="psl__df-label">Title (AI)</label>
          <input className="psl__df-input" defaultValue={a.title} />
        </div>
        <div className="psl__df">
          <label className="psl__df-label">Script line</label>
          <textarea className="psl__df-textarea" defaultValue={clip.scriptOverride} rows={3}/>
          <div className="psl__df-help">Read aloud during this clip. AI tightens to fit duration.</div>
        </div>
        <div className="psl__df">
          <div className="psl__df-label-row">
            <label className="psl__df-label">Duration</label>
            <span className="psl__df-suffix">{a.kind === "video" ? `source ${a.dur}s` : "static — any length"}</span>
          </div>
          <input className="psl__df-input is-mono" defaultValue={(clip.durOverride ?? a.dur) + "s"} />
        </div>
        <div className="psl__df">
          <label className="psl__df-label">OCR text (captured)</label>
          <div style={{
            padding:"8px 10px",
            background:"var(--bg-input)",
            border:"1px solid var(--border-subtle)",
            borderRadius:6,
            font:"500 11px/1.4 var(--font-mono)",
            color:"var(--text-secondary)",
          }}>{a.ocr}</div>
        </div>
        <div className="psl__df">
          <label className="psl__df-label">Source</label>
          <div style={{ display:"flex", gap:6, alignItems:"center" }}>
            <span style={{
              padding:"3px 7px",
              background:"var(--bg-panel-elevated)",
              border:"1px solid var(--accent-border)",
              borderRadius:4,
              font:"600 10px/1 var(--font-mono)",
              color:"var(--accent-bright)",
            }}>.{a.app}</span>
            <span style={{ font:"500 10px/1 var(--font-mono)", color:"var(--text-muted)" }}>captured · 2026-05-21</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// RIGHT RAIL — switches between the three panels
// ============================================================
function RightRail({ project, setProject, selectedClipIdx, setSelectedClipIdx, onOpenProject,
                    initialTab = "assets", allProjects }) {
  const [tab, setTab] = useStateSZR(initialTab);
  const badges = {
    assets: project ? project.clips.length : 0,
    chat:   project ? 2 : 0,
    detail: 0,
  };

  return (
    <div className="szl-rail">
      <RailStrip active={tab} setActive={setTab} badges={badges} />
      <div className="szl-rail__body">
        {tab === "assets" && (
          <ProjectAssetsPanel
            project={project}
            setProject={setProject}
            selectedClipIdx={selectedClipIdx}
            setSelectedClipIdx={setSelectedClipIdx}
            onOpenProject={onOpenProject}
            allProjects={allProjects}
          />
        )}
        {tab === "chat" && <ProjectChatPanel project={project} />}
        {tab === "detail" && <DetailsPanel project={project} selectedClipIdx={selectedClipIdx} setSelectedClipIdx={setSelectedClipIdx} />}
      </div>
    </div>
  );
}

window.SZL = window.SZL || {};
Object.assign(window.SZL, {
  RightRail, TransitionsPopover,
  ProjectAssetsPanel, ProjectChatPanel, DetailsPanel,
});
