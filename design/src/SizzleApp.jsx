/* eslint-disable */
// PwrSnap Sizzle Reels — main app shell
// Library mode (new Types + Projects sidebar + right rail tabs)
// → swaps to Editor mode when a project is opened.
//
// Exposes window.SZL.SizzleApp

const SZA_R = React;
const { useState: useStateSZA, useEffect: useEffectSZA, useMemo: useMemoSZA } = SZA_R;

const { PsAppIcon, PsBundleIcon, PsAppTag, APP_INFO } = window.PS;
const { Library, CAPTURES } = window.PS;
const { PROJECTS, ASSET_BANK, ProjectIcon, KindIcon, MiniThumb,
        totalDur, formatDur, RightRail, SizzleEditor } = window.SZL;

const TOTAL_CAPTURES = CAPTURES.length;
const RAIL_COUNTS_LOCAL = {
  electron: 226, claude: 23, safari: 25, telegram: 13, terminal: 11,
  clipboard: 3, pwragent: 3, chrome: 1,
};

// ============================================================
// LEFT SIDEBAR — Library + Types + Projects sections
// ============================================================
function LeftSidebar({ activeApp, setActiveApp, activeProject, setActiveProject, types, setTypes, onNewProject }) {
  return (
    <aside className="psl__left">
      <div className="psl__left-section-row">
        <span className="psl__left-section">Library</span>
        <button className="psl__rail-collapse" title="Collapse sidebar">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="m15 6-6 6 6 6"/></svg>
        </button>
      </div>
      <button
        className={"psl__nav" + (activeApp === "all" && !activeProject ? " is-active" : "")}
        onClick={() => { setActiveApp("all"); setActiveProject(null); }}
      >
        <span className="psl__nav-icon psl__nav-icon--mono">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        </span>
        <span className="psl__nav-label">All Captures</span>
        <span className="psl__nav-count">{TOTAL_CAPTURES}</span>
      </button>
      <button className="psl__nav">
        <span className="psl__nav-icon psl__nav-icon--mono">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        </span>
        <span className="psl__nav-label">Today</span>
        <span className="psl__nav-count">14</span>
      </button>
      <button className="psl__nav">
        <span className="psl__nav-icon psl__nav-icon--mono">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4l1 16h12l1-16"/><path d="M9 4V2h6v2"/></svg>
        </span>
        <span className="psl__nav-label">Trash</span>
        <span className="psl__nav-count">2</span>
      </button>

      {/* TYPES — multi-pick filter (Images / Video / Projects) */}
      <div className="psl__left-section" style={{ marginTop: 12 }}>Types</div>
      <div className="szl-types">
        <button
          className={"szl-types__row" + (types.images ? " is-on" : "")}
          onClick={() => setTypes({ ...types, images: !types.images })}
        >
          <span className="szl-types__check"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-11"/></svg></span>
          <span className="szl-types__icon">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="1.5" fill="currentColor"/><path d="m21 17-5-5-7 7"/></svg>
          </span>
          <span className="szl-types__label">Images</span>
          <span className="szl-types__count">307</span>
        </button>
        <button
          className={"szl-types__row" + (types.videos ? " is-on" : "")}
          onClick={() => setTypes({ ...types, videos: !types.videos })}
        >
          <span className="szl-types__check"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-11"/></svg></span>
          <span className="szl-types__icon">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="14" height="12" rx="1.5"/><path d="m17 10 4-2v8l-4-2z" fill="currentColor"/></svg>
          </span>
          <span className="szl-types__label">Video clips</span>
          <span className="szl-types__count">27</span>
        </button>
        <button
          className={"szl-types__row" + (types.projects ? " is-on" : "")}
          onClick={() => setTypes({ ...types, projects: !types.projects })}
        >
          <span className="szl-types__check"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-11"/></svg></span>
          <span className="szl-types__icon"><ProjectIcon size={13}/></span>
          <span className="szl-types__label">Projects</span>
          <span className="szl-types__count">{PROJECTS.length}</span>
        </button>
      </div>

      {/* PROJECTS — only visible when projects type is on */}
      {types.projects && (
        <>
          <div className="szl-proj-section">
            <span className="szl-proj-section__title">Sizzle reels · {PROJECTS.length}</span>
            <button className="szl-proj-section__new" title="New Sizzle Reel" onClick={onNewProject}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12h14M12 5v14"/></svg>
            </button>
          </div>
          {PROJECTS.map((p) => (
            <button
              key={p.id}
              className={"szl-proj-row" + (activeProject && activeProject.id === p.id ? " is-active" : "")}
              onClick={() => setActiveProject(p)}
            >
              <span className="szl-proj-row__icon"><ProjectIcon size={11}/></span>
              <span className="szl-proj-row__l">
                <span className="szl-proj-row__name">{p.name}</span>
                <span className="szl-proj-row__meta">{p.clips.length} clips · {formatDur(totalDur(p))} · {p.modified}</span>
              </span>
            </button>
          ))}
        </>
      )}

      {/* Source-app pill list — collapsed to a single "Apps" link when scrolling */}
      <div className="psl__left-section" style={{ marginTop: 12 }}>Source App</div>
      {["electron","claude","safari","telegram","terminal","clipboard","pwragent","chrome"].map((app) => (
        <button
          key={app}
          className={"psl__nav" + (activeApp === app ? " is-active" : "")}
          onClick={() => { setActiveApp(app); setActiveProject(null); }}
        >
          <span className="psl__nav-icon psl__nav-icon--bundle"><PsBundleIcon app={app} size={18}/></span>
          <span className="psl__nav-label">{APP_INFO[app].name}</span>
          <span className="psl__nav-count">{RAIL_COUNTS_LOCAL[app] ?? 0}</span>
        </button>
      ))}
    </aside>
  );
}

// ============================================================
// LIBRARY GRID — modified to show project-mode (chip + add-to-reel)
// ============================================================
function ThumbStyle(c) {
  const palettes = {
    "1password": ["#0a1a2a", "#0a6cff", "#9fc4ff"],
    appstore:    ["#0a1a2a", "#1eb5ff", "#cfe7ff"],
    chrome:      ["#171717", "#fbbc04", "#fff"],
    claude:      ["#1a0e08", "#d97757", "#f3b894"],
    clipboard:   ["#0a0806", "#1a1612", "#3a3022"],
    codex:       ["#080808", "#1f1f1f", "#3a3a3a"],
    electron:    ["#070605", "#15110b", "#241a0e"],
    pwragent:    ["#050505", "#1a1a22", "#1f7cff"],
    safari:      ["#0a1a2a", "#3aa6ff", "#d2eaff"],
    telegram:    ["#0a1f2a", "#1c8adb", "#7fc1ed"],
    terminal:    ["#050505", "#1a1a1a", "#5fb47e"],
  };
  const [bg, mid, hi] = palettes[c.app] || ["#1a1a1a","#2a2a2a","#4a4a4a"];
  const angle = (c.id * 47) % 360;
  return { background: `linear-gradient(${angle}deg, ${bg} 0%, ${mid} 60%, ${hi} 100%)` };
}

function LibraryGrid({ activeProject, types, addingToProject, projectClipIds, onToggleAdd, onOpenProjectDetail }) {
  // Build list: if project active, show project assets; else show captures filtered by types.
  if (activeProject) {
    return (
      <div className="psl__grid-only">
        <div style={{ display:"flex", alignItems:"center", gap: 14, marginBottom: 16 }}>
          <span className="psl__title-mark" style={{ width:32, height: 32 }}><ProjectIcon size={16}/></span>
          <div>
            <div style={{ font:"700 22px/1.05 var(--font-display)", letterSpacing:"-0.015em" }}>{activeProject.name}</div>
            <div style={{ font:"500 11px/1 var(--font-mono)", color:"var(--text-muted)", marginTop: 4 }}>
              {activeProject.clips.length} clips · {formatDur(totalDur(activeProject))} · sizzle reel · modified {activeProject.modified}
            </div>
          </div>
          <span style={{ flex: 1 }}/>
          {addingToProject ? (
            <button className="szl-ed__hdr-btn" onClick={onToggleAdd}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="m5 12 5 5 9-11"/></svg>
              Done adding
            </button>
          ) : (
            <button className="szl-ed__hdr-btn" onClick={onToggleAdd}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14M12 5v14"/></svg>
              Add captures
            </button>
          )}
          <button className="szl-ed__hdr-btn is-primary" onClick={onOpenProjectDetail}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 4h6v6M20 4l-7 7M3 14v6h6M3 20l7-7"/></svg>
            Open editor
          </button>
        </div>

        {addingToProject ? (
          <>
            <div style={{
              padding: "10px 12px",
              border: "1px dashed var(--accent-border)",
              background: "color-mix(in srgb, var(--accent) 5%, transparent)",
              borderRadius: 7,
              marginBottom: 16,
              font: "500 12px/1.4 var(--font-sans)",
              color: "var(--text-secondary)",
            }}>
              <b style={{ color:"var(--accent-bright)" }}>Adding to "{activeProject.name}"</b> · click captures to queue them.
              {projectClipIds.length > 0 && <span> · <b style={{ color:"var(--text-primary)" }}>{projectClipIds.length} added</b></span>}
            </div>
            <div className="psl__grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
              {CAPTURES.slice(0, 18).map((c) => {
                const added = projectClipIds.includes(c.id);
                return (
                  <div key={c.id} className={"psl__cell" + (added ? " is-selected" : "")} onClick={() => onToggleAdd(c.id)}>
                    <div className="psl__cell-thumb" style={ThumbStyle(c)}>
                      <svg viewBox="0 0 100 62" preserveAspectRatio="none" style={{ width:"100%", height:"100%", display:"block" }}>
                        <rect x="0" y="0" width="100" height="62" fill="#08070680"/>
                        <rect x="0" y="0" width="100" height="5" fill="#14110d"/>
                        <rect x="0" y="5" width="22" height="57" fill="#14110d"/>
                        <rect x="26" y="9" width="68" height="1.8" fill="#ff8a1f" opacity="0.55"/>
                        <rect x="26" y="20" width="68" height="14" rx="1" fill="#ff8a1f11" stroke="#ff8a1f55" strokeWidth="0.4"/>
                      </svg>
                      <span className="psl__cell-time">{c.time}</span>
                      <span className="psl__cell-app">
                        <PsAppTag app={c.app} name={APP_INFO[c.app].name} size="sm" />
                      </span>
                      <span style={{
                        position:"absolute", top: 8, left: 8,
                        width: 22, height: 22, borderRadius: "50%",
                        background: added ? "var(--accent)" : "rgba(0,0,0,0.6)",
                        border: "1.5px solid " + (added ? "var(--accent)" : "var(--border-default)"),
                        color: added ? "var(--button-text-on-accent)" : "white",
                        display:"inline-flex", alignItems:"center", justifyContent:"center",
                        font:"700 11px/1 var(--font-mono)",
                        backdropFilter: "blur(8px)",
                      }}>
                        {added ? "✓" : "+"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="psl__grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
            {activeProject.clips.map((c, i) => {
              const a = ASSET_BANK.find((x) => x.id === c.assetId);
              return (
                <div key={i} className="psl__cell">
                  <div className="psl__cell-thumb">
                    <MiniThumb assetId={a.id} withPlay={a.kind === "video"} />
                    <span className="psl__cell-time">{(c.durOverride ?? a.dur).toFixed(1)}s</span>
                    <span className="psl__cell-app">
                      <span style={{
                        display:"inline-flex", alignItems:"center", gap:5,
                        padding:"3px 8px",
                        background:"rgba(0,0,0,0.62)",
                        border:"1px solid var(--accent-border)",
                        borderRadius: 4,
                        color:"var(--accent-bright)",
                        font:"700 10px/1 var(--font-mono)",
                      }}>
                        <span style={{ width: 14, height:14, borderRadius: 3, background:"var(--accent)", color:"var(--button-text-on-accent)", display:"inline-flex", alignItems:"center", justifyContent:"center", font:"700 9px/1 var(--font-mono)" }}>
                          {String(i+1).padStart(2,"0")}
                        </span>
                        {a.kind === "video" ? "VID" : "IMG"}
                      </span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // No project — show captures, filtered by types
  let shown = CAPTURES.slice(0, 24);
  if (!types.images && !types.videos) shown = [];
  // (mock — we don't have a video flag on captures; just show all)

  // Group by day
  const groups = [];
  const dayMap = {};
  shown.forEach((c) => {
    if (!dayMap[c.day]) {
      dayMap[c.day] = { day: c.day, date: c.date, items: [] };
      groups.push(dayMap[c.day]);
    }
    dayMap[c.day].items.push(c);
  });

  return (
    <div className="psl__grid-only">
      {groups.map((g) => (
        <div key={g.day}>
          <div className="psl__day-hdr">
            <span className="psl__day-hdr-label">{g.day}</span>
            <span className="psl__day-hdr-meta">{g.date} · {g.items.length} captures</span>
          </div>
          <div className="psl__grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
            {g.items.map((c) => (
              <div key={c.id} className="psl__cell">
                <div className="psl__cell-thumb" style={ThumbStyle(c)}>
                  <svg viewBox="0 0 100 62" preserveAspectRatio="none" style={{ width:"100%", height:"100%", display:"block" }}>
                    <rect x="0" y="0" width="100" height="62" fill="#08070680"/>
                    <rect x="0" y="0" width="100" height="5" fill="#14110d"/>
                    <rect x="0" y="5" width="22" height="57" fill="#14110d"/>
                    {[0,1,2,3,4,5].map(i => (
                      <rect key={i} x="3" y={9+i*5} width={12 + (i*7+c.id)%6} height="1.6" fill="rgba(245,239,227,0.32)"/>
                    ))}
                    <rect x="26" y="9" width="68" height="1.8" fill="#ff8a1f" opacity="0.55"/>
                    <rect x="26" y="13" width="50" height="1.2" fill="rgba(245,239,227,0.32)"/>
                    <rect x="26" y="20" width="68" height="14" rx="1" fill="#ff8a1f11" stroke="#ff8a1f55" strokeWidth="0.4"/>
                    <rect x="28" y="23" width="50" height="1.4" fill="rgba(245,239,227,0.5)"/>
                    <rect x="28" y="26" width="56" height="1.2" fill="rgba(245,239,227,0.4)"/>
                    <rect x="26" y="38" width="68" height="11" rx="1" fill="rgba(0,0,0,0.4)"/>
                  </svg>
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
  );
}

// ============================================================
// LIBRARY SHELL (no editor — uses left + main + right rail)
// ============================================================
function LibraryShell({
  activeApp, setActiveApp,
  activeProject, setActiveProject,
  types, setTypes,
  rightTab, setRightTab,
  selectedClipIdx, setSelectedClipIdx,
  addingToProject, setAddingToProject,
  pendingAdds, setPendingAdds,
  onOpenProject,
  onNewProject,
}) {
  return (
    <div className="psl" style={{ position:"relative", gridTemplateColumns: "240px 1fr 360px" }}>
      <header className="psl__topbar">
        <div className="psl__topbar-l">
          <div className="psl__title">
            <span className="psl__title-mark"><PsAppIcon app="pwrsnap" size={14}/></span>
            <span className="psl__wordmark">Pwr<span className="a">Snap</span></span>
          </div>
          <span className="psl__count">{TOTAL_CAPTURES} captures · {PROJECTS.length} reels</span>
        </div>

        <div className="psl__topbar-c">
          <div className="psl__view">
            <button className="psl__view-btn">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="6" width="4" height="12"/><rect x="10" y="6" width="4" height="12"/><rect x="17" y="6" width="4" height="12"/></svg>
              Reel
            </button>
            <button className="psl__view-btn is-active">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              Grid
            </button>
          </div>
        </div>

        <div className="psl__topbar-r">
          <button className="psl__chip-btn--ghost" onClick={onNewProject}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14M12 5v14"/></svg>
            New Project
          </button>
          <button className="psl__icon-btn" title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .4 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.8-.4 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.4l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .4-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.4-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.8.4H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.4l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.4 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>
          </button>
          <button className="psl__chip-btn psl__chip-btn--accent" style={{ height: 28 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M5 12h14M12 5v14"/></svg>
            Quick Capture · <span className="psl__hk">⌘⇧C</span>
          </button>
        </div>
      </header>

      <LeftSidebar
        activeApp={activeApp}
        setActiveApp={setActiveApp}
        activeProject={activeProject}
        setActiveProject={setActiveProject}
        types={types}
        setTypes={setTypes}
        onNewProject={onNewProject}
      />

      <main className="psl__main" style={{ gridColumn: "2 / 3" }}>
        <LibraryGrid
          activeProject={activeProject}
          types={types}
          addingToProject={addingToProject}
          projectClipIds={pendingAdds}
          onToggleAdd={(id) => {
            if (id == null) { setAddingToProject(!addingToProject); return; }
            if (pendingAdds.includes(id)) setPendingAdds(pendingAdds.filter(x => x !== id));
            else setPendingAdds([...pendingAdds, id]);
          }}
          onOpenProjectDetail={onOpenProject}
        />
      </main>

      <RightRail
        project={activeProject}
        setProject={setActiveProject}
        selectedClipIdx={selectedClipIdx}
        setSelectedClipIdx={setSelectedClipIdx}
        onOpenProject={onOpenProject}
        initialTab={rightTab}
        allProjects={PROJECTS}
      />

      <footer className="psl__status">
        <div className="psl__status-l">
          <span><span className="a">●</span> 145 MB snaps · 31 MB clips</span>
          <span>Codex auto-tag <b>on</b></span>
          {activeProject && <span>project: <b>{activeProject.name}</b></span>}
        </div>
        <div className="psl__status-r">
          <span>⌘⇧C new · ⌘L library · ⌘N project</span>
          <span><b>v0.0.2</b></span>
        </div>
      </footer>
    </div>
  );
}

// ============================================================
// MAIN APP — switches between library and editor modes
// ============================================================
function SizzleApp({
  initialMode = "library",      // "library" | "editor"
  initialProject = "p1",         // project id
  initialRightTab = "assets",    // "assets" | "chat" | "detail"
  initialVariant = "vertical",   // "vertical" | "horizontal" | "storyboard"
  initialAdding = false,
  initialVoiceExpanded = false,
}) {
  const [mode, setMode] = useStateSZA(initialMode);
  const [activeApp, setActiveApp] = useStateSZA("all");
  const [activeProject, setActiveProject] = useStateSZA(() => PROJECTS.find(p => p.id === initialProject) || null);
  const [types, setTypes] = useStateSZA({ images: true, videos: true, projects: true });
  const [rightTab, setRightTab] = useStateSZA(initialRightTab);
  const [selectedClipIdx, setSelectedClipIdx] = useStateSZA(0);
  const [variant, setVariant] = useStateSZA(initialVariant);
  const [addingToProject, setAddingToProject] = useStateSZA(initialAdding);
  const [pendingAdds, setPendingAdds] = useStateSZA([1, 4, 7]);
  const [voiceExpanded, setVoiceExpanded] = useStateSZA(initialVoiceExpanded);

  const onOpenProject = () => setMode("editor");
  const onBackToLibrary = () => setMode("library");
  const onNewProject = () => {
    const empty = PROJECTS.find(p => p.id === "p3");
    setActiveProject(empty);
    setAddingToProject(true);
    setRightTab("assets");
  };

  if (mode === "editor" && activeProject && activeProject.clips.length > 0) {
    // Editor mode — also keep a right rail so the user can flip between Project Assets / AI Chat / Details.
    return (
      <div className="psl" style={{ position:"relative", gridTemplateColumns: "240px 1fr 360px" }}>
        <header className="psl__topbar">
          <div className="psl__topbar-l">
            <div className="psl__title">
              <span className="psl__title-mark"><PsAppIcon app="pwrsnap" size={14}/></span>
              <span className="psl__wordmark">Pwr<span className="a">Snap</span></span>
            </div>
            <span className="psl__count">editor · {activeProject.name}</span>
          </div>
          <div className="psl__topbar-c"/>
          <div className="psl__topbar-r">
            <button className="psl__chip-btn--ghost" onClick={onBackToLibrary}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 6-6 6 6 6"/></svg>
              Back to library
            </button>
            <button className="psl__chip-btn psl__chip-btn--accent" style={{ height: 28 }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M5 12h14M12 5v14"/></svg>
              Quick Capture · <span className="psl__hk">⌘⇧C</span>
            </button>
          </div>
        </header>

        <LeftSidebar
          activeApp={activeApp}
          setActiveApp={setActiveApp}
          activeProject={activeProject}
          setActiveProject={(p) => { setActiveProject(p); if (!p) setMode("library"); }}
          types={types}
          setTypes={setTypes}
          onNewProject={onNewProject}
        />

        <main className="psl__main" style={{ gridColumn: "2 / 3", position:"relative" }}>
          <SizzleEditor
            project={activeProject}
            onBack={onBackToLibrary}
            variant={variant}
            setVariant={setVariant}
            selectedIdx={selectedClipIdx}
            setSelectedIdx={setSelectedClipIdx}
            voiceExpanded={voiceExpanded}
            setVoiceExpanded={setVoiceExpanded}
          />
        </main>

        <RightRail
          project={activeProject}
          setProject={setActiveProject}
          selectedClipIdx={selectedClipIdx}
          setSelectedClipIdx={setSelectedClipIdx}
          onOpenProject={onOpenProject}
          initialTab={rightTab}
          allProjects={PROJECTS}
        />

        <footer className="psl__status">
          <div className="psl__status-l">
            <span><span className="a">●</span> editor</span>
            <span>project: <b>{activeProject.name}</b></span>
            <span>{activeProject.clips.length} clips · {formatDur(totalDur(activeProject))}</span>
          </div>
          <div className="psl__status-r">
            <span>space play · ←/→ clips · ⌘E export</span>
            <span><b>v0.0.2</b></span>
          </div>
        </footer>
      </div>
    );
  }

  // Library mode
  return (
    <LibraryShell
      activeApp={activeApp}
      setActiveApp={setActiveApp}
      activeProject={activeProject}
      setActiveProject={setActiveProject}
      types={types}
      setTypes={setTypes}
      rightTab={rightTab}
      setRightTab={setRightTab}
      selectedClipIdx={selectedClipIdx}
      setSelectedClipIdx={setSelectedClipIdx}
      addingToProject={addingToProject}
      setAddingToProject={setAddingToProject}
      pendingAdds={pendingAdds}
      setPendingAdds={setPendingAdds}
      onOpenProject={onOpenProject}
      onNewProject={onNewProject}
    />
  );
}

window.SZL = window.SZL || {};
Object.assign(window.SZL, { SizzleApp, LibraryShell, LeftSidebar });
