/* eslint-disable */
// PwrSnap Sizzle Reels — mock data + shared helpers + small primitives
//
// Exposes window.SZL.{ PROJECTS, ASSET_BANK, TRANSITIONS, VOICES,
//                       formatDur, ProjectIcon, KindIcon, MiniThumb,
//                       TransitionIcon, transitionByKey }.

const SZL_R = React;
const { useState: useStateSZ } = SZL_R;

// ============================================================
// TRANSITIONS catalog — what the user can pick between clips
// ============================================================
const TRANSITIONS = [
  { key: "cut",        name: "Cut",          desc: "Instant",         dur: 0.0 },
  { key: "fade",       name: "Fade",         desc: "Cross-dissolve",  dur: 0.3 },
  { key: "slide-l",    name: "Slide left",   desc: "Push from right", dur: 0.4 },
  { key: "slide-u",    name: "Slide up",     desc: "Push from below", dur: 0.4 },
  { key: "wipe-amber", name: "Amber wipe",   desc: "Brand wipe bar",  dur: 0.5 },
  { key: "zoom-in",    name: "Zoom in",      desc: "Punch into clip", dur: 0.5 },
  { key: "glitch",     name: "Glitch",       desc: "RGB tear",        dur: 0.4 },
  { key: "morph",      name: "Morph",        desc: "AI-matched blur", dur: 0.6 },
];
const transitionByKey = (k) => TRANSITIONS.find((t) => t.key === k) || TRANSITIONS[0];

// ============================================================
// VOICES — AI-generated voice options
// ============================================================
const VOICES = [
  { key: "ada",   name: "Ada",   tag: "warm",       desc: "Mid-range, calm, US-English",       pitches: [3,5,6,8,10,9,7,5,4,3,4,6,8,11,12,10,8,6,4,3] },
  { key: "rio",   name: "Rio",   tag: "punchy",     desc: "Bright, energetic, US-English",     pitches: [5,7,11,13,15,12,9,7,4,3,4,7,10,14,16,13,10,7,5,4] },
  { key: "kael",  name: "Kael",  tag: "low",        desc: "Low register, dry, US-English",     pitches: [2,3,4,4,5,5,4,3,3,2,2,3,4,5,6,5,4,3,2,2] },
  { key: "self",  name: "Record", tag: "you",       desc: "Mic input — record your own VO",    pitches: [] },
];

// ============================================================
// MOCK ASSET BANK — the canon of captures used across projects.
// Each asset is a stem name + AI metadata + capture origin.
// ============================================================
const ASSET_BANK = [
  { id: "a1",  kind: "image", app: "electron", stem: "pwragent-hero-shot",          title: "PwrAgent — thread-centric coding agent",          dur: 4.0, ocr: "PwrAgent — the agent that lives inside your worktree" },
  { id: "a2",  kind: "video", app: "electron", stem: "pwragent-resume-demo",        title: "Resume any thread mid-stream",                    dur: 6.5, ocr: "Resume menu · Telegram resume not clearing" },
  { id: "a3",  kind: "image", app: "electron", stem: "pwragent-worktree-chip",      title: "Worktree isolation per thread",                   dur: 3.0, ocr: "worktree · fix/telegram-topic-resume-picker" },
  { id: "a4",  kind: "video", app: "electron", stem: "pwragent-stream-tokens",      title: "Streaming tokens, not turns",                     dur: 5.2, ocr: "Streaming Responses · OAI · debounced" },
  { id: "a5",  kind: "image", app: "electron", stem: "pwragent-composer-chips",     title: "Inline model + permission chips",                 dur: 3.5, ocr: "OpenAI · Full Access · Worktree · GPT-5.5" },
  { id: "a6",  kind: "image", app: "pwragent", stem: "pwragent-launch-deck",        title: "Launch — pwrdrvr.com/pwragnt",                    dur: 2.8, ocr: "Out now · pwrdrvr.com/pwragnt" },
  { id: "a7",  kind: "image", app: "electron", stem: "pwragent-thinking-scanner",   title: "Thinking scanner beam",                           dur: 2.4, ocr: "Worked for 3m 17s · Edited 2 files +56 -0" },
  { id: "a8",  kind: "video", app: "terminal", stem: "pnpm-typecheck-clean",        title: "pnpm typecheck — green",                          dur: 4.0, ocr: "pnpm typecheck · 0 errors · 0 warnings" },
  { id: "a9",  kind: "image", app: "electron", stem: "pwragent-context-rail",       title: "Context-rail open, branch chip on",               dur: 3.2, ocr: "Branch · Worktree clean · 2 dirty" },
  { id: "a10", kind: "image", app: "telegram", stem: "telegram-thread-handoff",     title: "Telegram → PwrAgent handoff",                     dur: 3.5, ocr: "@pwragnt resume thread 42" },
  { id: "a11", kind: "video", app: "electron", stem: "pwragent-thread-actions",     title: "Thread actions — pin, archive, fork",             dur: 4.8, ocr: "Pin · Archive · Fork to new worktree" },
  { id: "a12", kind: "image", app: "chrome",   stem: "stripe-mrr-dash",             title: "Stripe MRR dashboard",                            dur: 3.0, ocr: "MRR $14,022 · Active 412 · Churn 2.1%" },
];

// ============================================================
// PROJECTS
// ============================================================
const PROJECTS = [
  {
    id: "p1",
    name: "PwrAgent 0.4 launch",
    kind: "sizzle-reel",
    modified: "2m ago",
    voice: "ada",
    notes: "Hero reel for the 0.4 release — pin to the top of pwrdrvr.com.",
    clips: [
      { assetId: "a1",  scriptOverride: "PwrAgent — a coding agent built around threads, not chat.",      durOverride: null, transition: "fade" },
      { assetId: "a2",  scriptOverride: "Pick up any thread mid-stream. The resume menu just works.",     durOverride: null, transition: "slide-l" },
      { assetId: "a3",  scriptOverride: "Every thread runs in its own worktree — isolated, reproducible.", durOverride: null, transition: "wipe-amber" },
      { assetId: "a4",  scriptOverride: "Stream tokens, not turns. The agent thinks out loud while it works.", durOverride: null, transition: "fade" },
      { assetId: "a5",  scriptOverride: "Switch models, tools, and permissions inline. No menu-diving.",  durOverride: null, transition: "cut" },
      { assetId: "a6",  scriptOverride: "PwrAgent — out now. pwrdrvr.com/pwragnt.",                       durOverride: null, transition: null },
    ],
  },
  {
    id: "p2",
    name: "OAI Hackathon demo",
    kind: "sizzle-reel",
    modified: "yesterday",
    voice: "rio",
    notes: "3-minute walkthrough for the hack-team demo Friday.",
    clips: [
      { assetId: "a8",  scriptOverride: "Start clean — pnpm typecheck passes.",                          durOverride: null, transition: "cut" },
      { assetId: "a1",  scriptOverride: "Spin up PwrAgent.",                                              durOverride: null, transition: "fade" },
      { assetId: "a10", scriptOverride: "Hand off from Telegram with one mention.",                       durOverride: null, transition: "slide-u" },
      { assetId: "a4",  scriptOverride: "Watch tokens stream in real time.",                              durOverride: null, transition: "fade" },
      { assetId: "a11", scriptOverride: "Pin, archive, or fork to a new worktree in one tap.",            durOverride: null, transition: "wipe-amber" },
    ],
  },
  {
    id: "p3",
    name: "Sizzle Reels — feature README",
    kind: "sizzle-reel",
    modified: "Mon",
    voice: "kael",
    notes: "Self-referential demo: the Sizzle Reels feature explaining itself.",
    clips: [],
  },
];

// ============================================================
// Helpers
// ============================================================
function formatDur(secs) {
  if (secs == null) return "—";
  const s = Math.max(0, secs);
  const m = Math.floor(s / 60);
  const r = (s - m * 60);
  const rr = r < 10 ? "0" + r.toFixed(1) : r.toFixed(1);
  return `${m}:${rr}`;
}
function totalDur(project) {
  if (!project) return 0;
  let total = 0;
  project.clips.forEach((c, i) => {
    const a = ASSET_BANK.find((x) => x.id === c.assetId);
    total += (c.durOverride ?? (a ? a.dur : 0));
    if (c.transition && i < project.clips.length - 1) {
      total += transitionByKey(c.transition).dur;
    }
  });
  return total;
}

// ============================================================
// ProjectIcon — the stacked-rect mark + a tiny film badge
// (project = "PwrSnap stack + a play indicator")
// ============================================================
function ProjectIcon({ size = 12 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" strokeLinejoin="round" strokeLinecap="round">
      <rect x="8" y="3" width="13" height="13" rx="2.5" style={{ stroke: "var(--accent-deep)" }} strokeWidth="1.5"/>
      <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" style={{ stroke: "color-mix(in oklch, var(--accent-deep), var(--accent))" }} strokeWidth="1.5"/>
      <rect x="3" y="8" width="13" height="13" rx="2.5" style={{ stroke: "var(--accent)" }} strokeWidth="1.6" fill="var(--bg-app)"/>
      {/* play glyph inside front rect */}
      <path d="M8 12.5 L 13 15.5 L 8 18.5 Z" fill="var(--accent)" stroke="none"/>
    </svg>
  );
}

// ============================================================
// Kind icon — image vs video
// ============================================================
function KindIcon({ kind, size = 10 }) {
  if (kind === "video") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="5" width="18" height="14" rx="2"/>
      <circle cx="9" cy="11" r="1.5" fill="currentColor"/>
      <path d="m21 17-5-5-7 7"/>
    </svg>
  );
}

// ============================================================
// TransitionIcon — small glyph for each transition type
// ============================================================
function TransitionIcon({ keyName, size = 11 }) {
  const s = size;
  switch (keyName) {
    case "cut":
      return <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="3" width="5" height="10" rx="1"/><rect x="9" y="3" width="5" height="10" rx="1"/></svg>;
    case "fade":
      return <svg width={s} height={s} viewBox="0 0 16 16"><defs><linearGradient id="fg" x1="0" x2="1"><stop offset="0" stopColor="currentColor"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs><rect x="2" y="3" width="12" height="10" rx="1" fill="url(#fg)"/></svg>;
    case "slide-l":
      return <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m11 8-5 0M11 8 8 5M11 8 8 11"/><path d="M13 3v10" strokeWidth="1.2"/></svg>;
    case "slide-u":
      return <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8 11 8 6M8 6 5 9M8 6l3 3"/><path d="M3 13h10" strokeWidth="1.2"/></svg>;
    case "wipe-amber":
      return <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3" width="12" height="10" rx="1"/><line x1="10" y1="2" x2="6" y2="14" strokeWidth="2.2"/></svg>;
    case "zoom-in":
      return <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="2" y="2" width="12" height="12" rx="1"/><rect x="5.5" y="5.5" width="5" height="5" rx="0.5"/></svg>;
    case "glitch":
      return <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 4h12M2 8h12M2 12h12" strokeDasharray="2.5 1.5"/></svg>;
    case "morph":
      return <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 8c0-3 2-5 6-5s6 2 6 5-2 5-6 5-6-2-6-5z"/><path d="M5 8h6" strokeWidth="0.8" strokeDasharray="1 1"/></svg>;
    default:
      return null;
  }
}

// ============================================================
// MiniThumb — synthetic thumbnail for an asset. Slim variant of
// the Library Thumb that pulls in the app palette + draws a
// generic-looking dense UI. Uses simple SVGs so it composes well.
// ============================================================
function MiniThumb({ assetId, withPlay = false }) {
  const asset = ASSET_BANK.find((a) => a.id === assetId);
  if (!asset) return <div style={{ background: "var(--bg-input)", width:"100%", height:"100%" }} />;
  // Palettes derived from the Library palette set
  const palettes = {
    electron: ["#070605","#15110b","#241a0e","#ff8a1f"],
    pwragent: ["#050505","#0e1a2b","#1f7cff","#9fc4ff"],
    telegram: ["#0a1f2a","#1c8adb","#7fc1ed","#dff2ff"],
    terminal: ["#050505","#1a1a1a","#5fb47e","#9be8b2"],
    chrome:   ["#171717","#3a3a3a","#fbbc04","#fff"],
  };
  const [bg, mid, hi, accent] = palettes[asset.app] || palettes.electron;
  // angle hash so each asset looks distinct
  const seed = parseInt(asset.id.slice(1), 10) || 1;
  const angle = (seed * 47) % 360;
  return (
    <div style={{ position:"absolute", inset:0, background: `linear-gradient(${angle}deg, ${bg}, ${mid} 55%, ${hi})` }}>
      <svg viewBox="0 0 100 62" preserveAspectRatio="none" style={{ width:"100%", height:"100%", display:"block" }}>
        {/* chrome bar */}
        <rect x="0" y="0" width="100" height="5" fill={mid} opacity="0.95"/>
        <circle cx="3" cy="2.5" r="0.8" fill="#ff5f57"/>
        <circle cx="6" cy="2.5" r="0.8" fill="#febc2e"/>
        <circle cx="9" cy="2.5" r="0.8" fill="#28c840"/>
        {/* sidebar */}
        <rect x="0" y="5" width="22" height="57" fill={mid} opacity="0.92"/>
        {[0,1,2,3,4].map(i => (
          <rect key={i} x="3" y={9 + i*5} width={12 + (i*5+seed)%6} height="1.6" fill="rgba(245,239,227,0.32)"/>
        ))}
        {/* main content */}
        <rect x="26" y="9" width="68" height="1.8" fill={accent} opacity="0.55"/>
        <rect x="26" y="13" width="50" height="1.2" fill="rgba(245,239,227,0.32)"/>
        <rect x="26" y="20" width="68" height="14" rx="1" fill={`${accent}11`} stroke={`${accent}55`} strokeWidth="0.4"/>
        <rect x="28" y="23" width="50" height="1.4" fill="rgba(245,239,227,0.5)"/>
        <rect x="28" y="26" width="56" height="1.2" fill="rgba(245,239,227,0.4)"/>
        <rect x="28" y="29" width="42" height="1.2" fill="rgba(245,239,227,0.36)"/>
        <rect x="26" y="38" width="68" height="11" rx="1" fill="rgba(0,0,0,0.4)" stroke="rgba(255,255,255,0.06)"/>
        <rect x="28" y="41" width="38" height="1.2" fill="rgba(245,239,227,0.5)"/>
        <rect x="28" y="44" width="48" height="1.2" fill="rgba(245,239,227,0.4)"/>
        <circle cx="86" cy="44" r="1.2" fill={accent}/>
        {/* "video" indicator */}
        {asset.kind === "video" && (
          <g>
            <rect x="80" y="52" width="14" height="8" rx="1.4" fill="rgba(0,0,0,0.55)"/>
            <polygon points="84,54.5 90,56.5 84,58.5" fill={accent}/>
          </g>
        )}
      </svg>
      {withPlay && (
        <div style={{
          position:"absolute", inset:0,
          display:"flex", alignItems:"center", justifyContent:"center",
          pointerEvents:"none",
        }}>
          <div style={{
            width:42, height:42, borderRadius:"50%",
            background:"rgba(0,0,0,0.55)",
            border:"1.5px solid rgba(255,255,255,0.35)",
            display:"inline-flex", alignItems:"center", justifyContent:"center",
            backdropFilter:"blur(8px)",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
              <polygon points="7 4 22 12 7 20 7 4"/>
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Export
// ============================================================
window.SZL = {
  TRANSITIONS, VOICES, ASSET_BANK, PROJECTS,
  transitionByKey, formatDur, totalDur,
  ProjectIcon, KindIcon, TransitionIcon, MiniThumb,
};
