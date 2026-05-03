/* eslint-disable */
// PwrSnap Library — three-pane: source apps · reel · detail editor

const { useState: useStateLib, useMemo: useMemoLib } = React;
const { PsAppIcon, PsAppTag } = window.PS;

// Generated capture data — varied across apps, days, names
const CAPTURES = (() => {
  const base = [
    { app: "telegram", n: "Pavel re: launch deck",       tags: ["chat","launch"]   },
    { app: "telegram", n: "screenshot from Anna",        tags: ["chat","ref"]      },
    { app: "excel",    n: "Q4 burn projection",          tags: ["finance","Q4"]    },
    { app: "excel",    n: "headcount roll-up",           tags: ["finance"]         },
    { app: "vscode",   n: "auth flow — token refresh",   tags: ["bug","auth"]      },
    { app: "vscode",   n: "merge conflict (router.tsx)", tags: ["code"]            },
    { app: "chrome",   n: "Stripe dashboard MRR",        tags: ["metrics","mrr"]   },
    { app: "chrome",   n: "competitor pricing — CleanShot", tags: ["research"]    },
    { app: "figma",    n: "tray menu v3",                tags: ["design","spec"]   },
    { app: "figma",    n: "icon grid 24px",              tags: ["design"]          },
    { app: "slack",    n: "DM from Ben — bug repro",     tags: ["bug","p1"]        },
    { app: "slack",    n: "#design-review feedback",     tags: ["design"]          },
    { app: "terminal", n: "kubectl logs — api crash",    tags: ["bug","prod"]      },
    { app: "terminal", n: "git log --oneline",           tags: ["code"]            },
    { app: "notion",   n: "PRD — share targets",         tags: ["doc","prd"]       },
    { app: "notion",   n: "Q1 OKR draft",                tags: ["doc","okr"]       },
    { app: "linear",   n: "PWS-218 sizzle reel",         tags: ["ticket"]          },
    { app: "linear",   n: "PWS-204 tray modes",          tags: ["ticket"]          },
    { app: "github",   n: "PR #1142 review",             tags: ["code","pr"]       },
    { app: "github",   n: "Actions run failed",          tags: ["bug","ci"]        },
    { app: "zoom",     n: "weekly w/ Sarah — slide 4",   tags: ["meeting"]         },
    { app: "safari",   n: "MDN — backdrop-filter",       tags: ["research"]        },
    { app: "preview",  n: "annotated wireframe — v2",    tags: ["design","spec"]   },
    { app: "finder",   n: "logo lockup — final.svg",     tags: ["asset"]           },
    { app: "telegram", n: "Yuri — install screenshot",   tags: ["chat","support"]  },
    { app: "vscode",   n: "FloatOver tags impl",         tags: ["code","done"]     },
    { app: "excel",    n: "infra cost forecast",         tags: ["finance"]         },
    { app: "chrome",   n: "Vercel deploy — preview",     tags: ["deploy"]          },
    { app: "figma",    n: "library reel — frame",        tags: ["design"]          },
    { app: "slack",    n: "from Maya — copy variants",   tags: ["copy"]            },
    { app: "linear",   n: "PWS-231 app-source tag",      tags: ["ticket","spec"]   },
    { app: "terminal", n: "pnpm install — error",        tags: ["bug","build"]     },
  ];
  const days = [
    { day: "Today",     date: "Jan 23",   times: ["9:42","10:17","10:46","11:08","11:23","11:51","12:04","12:37"] },
    { day: "Yesterday", date: "Jan 22",   times: ["8:22","9:08","13:14","14:37","15:21","16:02","16:48","18:11"] },
    { day: "Mon",       date: "Jan 21",   times: ["7:55","9:12","10:33","11:47","13:04","14:25","15:48","17:09"] },
    { day: "Last Fri",  date: "Jan 18",   times: ["8:30","10:10","11:14","12:32","13:55","14:18","15:42","16:30"] },
  ];
  const out = [];
  base.forEach((c, i) => {
    const dayIdx = Math.floor(i / 8);
    const slot = i % 8;
    const day = days[dayIdx] || days[3];
    out.push({
      id: i + 1,
      ...c,
      day: day.day,
      date: day.date,
      time: day.times[slot] || "9:00",
      size: 220 + Math.round(Math.sin(i*1.7) * 100 + 280),
      w: [1840, 1280, 920, 2560][i % 4],
      h: [1180, 800,  580, 1440][i % 4],
    });
  });
  return out;
})();

const APP_INFO = {
  telegram: { name: "Telegram",       count: 3 },
  excel:    { name: "Excel",          count: 3 },
  vscode:   { name: "VS Code",        count: 3 },
  chrome:   { name: "Chrome",         count: 3 },
  figma:    { name: "Figma",          count: 3 },
  slack:    { name: "Slack",          count: 3 },
  terminal: { name: "Terminal",       count: 3 },
  notion:   { name: "Notion",         count: 2 },
  linear:   { name: "Linear",         count: 3 },
  github:   { name: "GitHub",         count: 2 },
  zoom:     { name: "Zoom",           count: 1 },
  safari:   { name: "Safari",         count: 1 },
  preview:  { name: "Preview",        count: 1 },
  finder:   { name: "Finder",         count: 1 },
};

// Generate 80 thumbnail tints + content patterns for variety
function thumbStyle(c) {
  const palettes = {
    telegram: ["#0e2230", "#229ED9", "#65b6e2"],
    excel:    ["#0a1f0e", "#107c41", "#5fb47e"],
    vscode:   ["#0a1424", "#1f3b6e", "#7baaff"],
    chrome:   ["#1a1a1a", "#4285f4", "#fbbc04"],
    figma:    ["#1f0a18", "#a259ff", "#f24e1e"],
    slack:    ["#1a0e1a", "#611f5c", "#ecb22e"],
    terminal: ["#0a0a0a", "#1f1f1f", "#5fb47e"],
    notion:   ["#1a1a18", "#2f2f2f", "#e5e5e5"],
    linear:   ["#0e0e1c", "#5e6ad2", "#a4adff"],
    github:   ["#0d1117", "#1f2733", "#7d8590"],
    zoom:     ["#0a1a2e", "#2d8cff", "#75b6ff"],
    safari:   ["#0e1a24", "#2d7fb6", "#7fd0ff"],
    preview:  ["#1a140e", "#5c4a3a", "#b89878"],
    finder:   ["#1a1a1a", "#3a3a3a", "#7f7f7f"],
  };
  const [bg, mid, hi] = palettes[c.app] || palettes.finder;
  const angle = (c.id * 47) % 360;
  return {
    background: `linear-gradient(${angle}deg, ${bg} 0%, ${mid} 60%, ${hi} 100%)`,
  };
}

// Synthetic "screenshot" canvas — UI chrome lines that suggest the app
function ThumbContent({ c, scale = 1 }) {
  const w = 100, h = 62;
  const palette = {
    telegram: { chrome: "#229ED9", lines: "rgba(255,255,255,0.6)" },
    excel:    { chrome: "#107c41", lines: "rgba(255,255,255,0.55)" },
    vscode:   { chrome: "#1f3b6e", lines: "#7baaff" },
    chrome:   { chrome: "#dadce0", lines: "rgba(255,255,255,0.7)" },
    figma:    { chrome: "#2c2c2c", lines: "#a259ff" },
    slack:    { chrome: "#3f0e3f", lines: "#ecb22e" },
    terminal: { chrome: "#1f1f1f", lines: "#5fb47e" },
    notion:   { chrome: "#2f2f2f", lines: "#e5e5e5" },
    linear:   { chrome: "#252633", lines: "#a4adff" },
    github:   { chrome: "#1f2733", lines: "#7d8590" },
    zoom:     { chrome: "#0e1f3a", lines: "#75b6ff" },
    safari:   { chrome: "#1a2a3a", lines: "#7fd0ff" },
    preview:  { chrome: "#3a3024", lines: "#d4b890" },
    finder:   { chrome: "#2a2a2a", lines: "#aaa" },
  }[c.app] || { chrome: "#2a2a2a", lines: "#aaa" };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block" }}>
      <rect x="0" y="0" width={w} height={h} fill={palette.chrome} opacity="0.32"/>
      <rect x="0" y="0" width={w} height="6" fill={palette.chrome} opacity="0.92"/>
      <circle cx="3" cy="3" r="1" fill="#ff5f57"/>
      <circle cx="6.5" cy="3" r="1" fill="#febc2e"/>
      <circle cx="10" cy="3" r="1" fill="#28c840"/>
      {/* sidebar */}
      <rect x="0" y="6" width="22" height={h-6} fill={palette.chrome} opacity="0.5"/>
      {[0,1,2,3,4].map(i => <rect key={i} x="3" y={10+i*7} width="16" height="2.6" fill={palette.lines} opacity={0.18 + (c.id+i)%3*0.08}/>)}
      {/* content lines */}
      {Array.from({length: 6}).map((_,i) => {
        const ww = 30 + ((c.id*7 + i*13) % 40);
        return <rect key={i} x="26" y={11+i*7} width={ww} height="2.4" fill={palette.lines} opacity={0.32 - i*0.025}/>;
      })}
      {/* feature box */}
      <rect x="26" y="40" width="64" height="18" fill={palette.lines} opacity="0.08" stroke={palette.lines} strokeOpacity="0.3" strokeWidth="0.4"/>
      <rect x="29" y="44" width="22" height="2.4" fill={palette.lines} opacity="0.4"/>
      <rect x="29" y="49" width="40" height="1.8" fill={palette.lines} opacity="0.25"/>
      <rect x="29" y="52.5" width="34" height="1.8" fill={palette.lines} opacity="0.25"/>
    </svg>
  );
}

function Thumb({ c }) {
  return (
    <div style={{ position: "absolute", inset: 0, ...thumbStyle(c) }}>
      <ThumbContent c={c} />
    </div>
  );
}

// Group captures by day for grid + reel
function groupByDay(items) {
  const m = {};
  items.forEach((c) => {
    if (!m[c.day]) m[c.day] = { day: c.day, date: c.date, items: [] };
    m[c.day].items.push(c);
  });
  return Object.values(m);
}

function Library({ initialSelected = 5, sizzleMode = false, sizzlePicks = [] }) {
  const [selected, setSelected] = useStateLib(initialSelected);
  const [activeApp, setActiveApp] = useStateLib("all");
  const [view, setView] = useStateLib("reel"); // reel | grid
  const [picks, setPicks] = useStateLib(sizzlePicks);
  const sizzle = sizzleMode || picks.length > 0;

  const visible = activeApp === "all" ? CAPTURES : CAPTURES.filter(c => c.app === activeApp);
  const grouped = useMemoLib(() => groupByDay(visible), [activeApp]);
  const current = CAPTURES.find(c => c.id === selected) || CAPTURES[0];

  return (
    <div className="psl">
      <header className="psl__topbar">
        <div className="psl__topbar-l">
          <div className="psl__title">
            <span style={{ display: "inline-flex", width: 22, height: 22, alignItems: "center", justifyContent: "center", border: "1px solid var(--accent-border)", borderRadius: 5, background: "var(--bg-panel-elevated)", color: "var(--accent)" }}>
              <PsAppIcon app="any" size={12} />
            </span>
            Pwr<span className="a">Snap</span>
          </div>
          <span className="psl__count">{CAPTURES.length} captures</span>
        </div>
        <div className="psl__topbar-c">
          <div className="psl__view">
            <button className={"psl__view-btn" + (view==="reel"?" is-active":"")} onClick={()=>setView("reel")}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="6" width="4" height="12"/><rect x="10" y="6" width="4" height="12"/><rect x="17" y="6" width="4" height="12"/></svg>
              Reel
            </button>
            <button className={"psl__view-btn" + (view==="grid"?" is-active":"")} onClick={()=>setView("grid")}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              Grid
            </button>
          </div>
        </div>
        <div className="psl__topbar-r">
          <div className="psl__search-wrap">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input className="psl__search" placeholder="Search captures, tags, OCR…" defaultValue="" />
          </div>
          <button className="psl__chip-btn psl__chip-btn--accent" style={{ height: 28 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M5 12h14M12 5v14"/></svg>
            New snap · ⌘⇧P
          </button>
        </div>
      </header>

      <aside className="psl__left">
        <div className="psl__left-section">Library</div>
        <button className={"psl__nav" + (activeApp==="all"?" is-active":"")} onClick={()=>setActiveApp("all")}>
          <span className="psl__nav-icon"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></span>
          <span className="psl__nav-label">All Captures</span>
          <span className="psl__nav-count">{CAPTURES.length}</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>
          <span className="psl__nav-label">Today</span>
          <span className="psl__nav-count">8</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4l1 16h12l1-16"/><path d="M9 4V2h6v2"/></svg></span>
          <span className="psl__nav-label">Trash</span>
          <span className="psl__nav-count">14</span>
        </button>

        <div className="psl__left-section">Source App</div>
        {Object.entries(APP_INFO).map(([app, info]) => (
          <button
            key={app}
            className={"psl__nav" + (activeApp===app?" is-active":"")}
            onClick={()=>setActiveApp(app)}
          >
            <span className="psl__nav-icon"><PsAppIcon app={app} size={11} /></span>
            <span className="psl__nav-label">{info.name}</span>
            <span className="psl__nav-count">{CAPTURES.filter(c=>c.app===app).length}</span>
          </button>
        ))}

        <div className="psl__left-section">Smart Filters</div>
        <button className="psl__nav">
          <span className="psl__nav-icon"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2 9 9l-7 1 5 5-1 7 6-3 6 3-1-7 5-5-7-1z"/></svg></span>
          <span className="psl__nav-label">Pinned</span>
          <span className="psl__nav-count">6</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0Z"/><path d="m9 12 2 2 4-4"/></svg></span>
          <span className="psl__nav-label">Bug repros</span>
          <span className="psl__nav-count">5</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h16v6H4zM4 14h16v6H4z"/></svg></span>
          <span className="psl__nav-label">Has annotations</span>
          <span className="psl__nav-count">11</span>
        </button>
      </aside>

      <main className="psl__main">
        {sizzle && (
          <div className="psl__sizzle-strip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 3v18l7-4 7 4V3z"/></svg>
            <div className="psl__sizzle-strip-text">
              <b>Sizzle Reel</b> — {picks.length || 5} captures · ~28s · Codex chose order
              <small>drag frames to reorder · ⌥click to drop · export as MP4 / GIF / Markdown</small>
            </div>
            <button className="psl__chip-btn psl__chip-btn--accent">Export reel</button>
          </div>
        )}

        <section className="psl__reel-wrap">
          <div className="psl__reel-hdr">
            <span className="psl__reel-title">Timeline · {activeApp === "all" ? "all sources" : APP_INFO[activeApp].name}</span>
            <span className="psl__reel-mode">scrub <b>⌘[ / ⌘]</b></span>
          </div>
          <div className="psl__reel" id="psl-reel">
            <div className="psl__playhead" style={{ left: 318 }} />
            {grouped.map((g) => (
              <div key={g.day} className="psl__reel-day">
                <div className="psl__reel-day-label">{g.day} · {g.date}</div>
                <div className="psl__reel-day-frames">
                  {g.items.map((c, idx) => (
                    <button
                      key={c.id}
                      className={
                        "psl__frame"
                        + (c.id === selected ? " is-selected" : "")
                        + (picks.includes(c.id) ? " is-in-reel" : "")
                      }
                      onClick={() => setSelected(c.id)}
                    >
                      <Thumb c={c} />
                      <span className="psl__frame-num">{c.time}</span>
                      <span className="psl__frame-app"><PsAppIcon app={c.app} size={8} /></span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="psl__grid-wrap">
          {grouped.slice(0, 2).map((g) => (
            <div key={g.day}>
              <div className="psl__day-hdr">
                <span className="psl__day-hdr-label">{g.day}</span>
                <span className="psl__day-hdr-meta">{g.date} · {g.items.length} captures</span>
                <span className="psl__day-hdr-line" />
              </div>
              <div className="psl__grid">
                {g.items.map((c, idx) => (
                  <div
                    key={c.id}
                    className={
                      "psl__cell"
                      + (c.id === selected ? " is-selected" : "")
                      + (picks.includes(c.id) ? " is-in-reel" : "")
                    }
                    onClick={() => setSelected(c.id)}
                  >
                    <div className="psl__cell-thumb">
                      <Thumb c={c} />
                      <span className="psl__cell-time">{c.time}</span>
                      <span className="psl__cell-app"><span className="psl__app-dot"><PsAppIcon app={c.app} size={10} /></span></span>
                      {sizzle && (
                        <span className="psl__cell-pick">
                          {picks.indexOf(c.id) >= 0 ? picks.indexOf(c.id)+1 : ""}
                        </span>
                      )}
                    </div>
                    <div className="psl__cell-meta">
                      <div className="psl__cell-name">{c.n}</div>
                      <div className="psl__cell-tags">
                        <PsAppTag app={c.app} name={APP_INFO[c.app].name} size="sm" />
                        {c.tags.slice(0,1).map((t) => <span key={t} className="ps-tag is-sm">{t}</span>)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </main>

      <aside className="psl__right">
        <div className="psl__right-tabs">
          <button className="psl__right-tab is-active">Detail</button>
          <button className="psl__right-tab">History</button>
          <button className="psl__right-tab">OCR</button>
        </div>
        <div className="psl__right-body">
          <div className="psl__preview">
            <div style={{ position: "relative", aspectRatio: "16/10", overflow: "hidden", background: "var(--bg-input)" }}>
              <Thumb c={current} />
              {/* example annotation overlay */}
              <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} viewBox="0 0 100 62" preserveAspectRatio="none">
                <rect x="48" y="34" width="22" height="9" fill="none" stroke="#e8743a" strokeWidth="0.6"/>
                <path d="M48 34 L 30 22" stroke="#e8743a" strokeWidth="0.5"/>
                <circle cx="30" cy="22" r="1.6" fill="#e8743a"/>
              </svg>
            </div>
            <div className="psl__preview-toolbar">
              <button className="psl__pt-btn is-active" title="Crop"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2v16h16M2 6h16v16"/></svg></button>
              <button className="psl__pt-btn" title="Arrow"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M5 19 19 5M19 5h-7M19 5v7"/></svg></button>
              <button className="psl__pt-btn" title="Box"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16"/></svg></button>
              <button className="psl__pt-btn" title="Text"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 6h14M12 6v14M9 20h6"/></svg></button>
              <button className="psl__pt-btn" title="Blur"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="7" cy="12" r="2"/><circle cx="13" cy="8" r="2"/><circle cx="17" cy="14" r="2"/><circle cx="11" cy="17" r="2"/></svg></button>
              <span className="psl__pt-sep" />
              <button className="psl__pt-btn" title="Magic wand"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m4 20 12-12M14 4h2v2M20 8h2v2M18 14h2v2"/></svg></button>
              <button className="psl__pt-btn" title="Undo"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 12h12a4 4 0 1 1 0 8h-3"/><path d="m7 8-4 4 4 4"/></svg></button>
            </div>
          </div>

          <div className="psl__detail-meta">
            <input className="psl__detail-name" defaultValue={current.n} />
            <div className="psl__detail-row">
              <span><b>{current.w}×{current.h}</b></span>
              <span>{current.size} KB</span>
              <span>PNG</span>
              <span>{current.day} · {current.time}</span>
            </div>
            <div className="psl__detail-tags">
              <PsAppTag app={current.app} name={APP_INFO[current.app].name} />
              {current.tags.map((t) => <span key={t} className="ps-tag">{t}</span>)}
              <span className="ps-tag is-suggest">+ codex</span>
            </div>
          </div>

          <div className="psl__ai-card">
            <div className="psl__ai-card-hdr">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m12 2 2.5 5 5.5.5-4 4 1 5.5-5-3-5 3 1-5.5-4-4 5.5-.5z"/></svg>
              Codex caption
              <small>haiku-4.5 · 1.4s</small>
            </div>
            <div className="psl__ai-card-text">
              <b>{APP_INFO[current.app].name}</b> capture showing <b>{current.tags.join(", ")}</b>. Highlighted region likely the <b>error toast at column G37</b>. Suggest tagging <b>finance</b>, <b>Q4</b>.
            </div>
            <div className="psl__ai-card-actions">
              <button className="psl__chip-btn">Regenerate</button>
              <button className="psl__chip-btn">Apply tags</button>
              <button className="psl__chip-btn">Copy as alt-text</button>
            </div>
          </div>

          <div className="psl__big-cta">
            <button className="is-primary">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15V5h10"/></svg>
              Copy
            </button>
            <button>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4v12M6 10l6-6 6 6M4 20h16"/></svg>
              Share
            </button>
            <button>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14"/></svg>
            </button>
            <button title="Open full editor">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>
              Editor
            </button>
          </div>
        </div>
      </aside>

      <footer className="psl__status">
        <div className="psl__status-l">
          <span><span className="a">●</span> 3.2 GB local · <b>iCloud sync</b></span>
          <span>Codex auto-tag <b>on</b></span>
        </div>
        <div className="psl__status-r">
          <span>⌘⇧P new · ⌘L library · ⌘K search</span>
          <span><b>v0.4.2</b></span>
        </div>
      </footer>
    </div>
  );
}

window.PS = window.PS || {};
Object.assign(window.PS, { Library, CAPTURES, APP_INFO });
