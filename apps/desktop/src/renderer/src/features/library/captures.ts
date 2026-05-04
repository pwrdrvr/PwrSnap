import type { AppId } from "../shared/AppIcons";

export type Capture = {
  id: number;
  app: AppId;
  n: string;
  tags: string[];
  day: string;
  date: string;
  time: string;
  size: number;
  w: number;
  h: number;
};

const BASE: Array<{ app: AppId; n: string; tags: string[] }> = [
  { app: "telegram", n: "Pavel re: launch deck", tags: ["chat", "launch"] },
  { app: "telegram", n: "screenshot from Anna", tags: ["chat", "ref"] },
  { app: "excel", n: "Q4 burn projection", tags: ["finance", "Q4"] },
  { app: "excel", n: "headcount roll-up", tags: ["finance"] },
  { app: "vscode", n: "auth flow — token refresh", tags: ["bug", "auth"] },
  { app: "vscode", n: "merge conflict (router.tsx)", tags: ["code"] },
  { app: "chrome", n: "Stripe dashboard MRR", tags: ["metrics", "mrr"] },
  { app: "chrome", n: "competitor pricing — CleanShot", tags: ["research"] },
  { app: "figma", n: "tray menu v3", tags: ["design", "spec"] },
  { app: "figma", n: "icon grid 24px", tags: ["design"] },
  { app: "slack", n: "DM from Ben — bug repro", tags: ["bug", "p1"] },
  { app: "slack", n: "#design-review feedback", tags: ["design"] },
  { app: "terminal", n: "kubectl logs — api crash", tags: ["bug", "prod"] },
  { app: "terminal", n: "git log --oneline", tags: ["code"] },
  { app: "notion", n: "PRD — share targets", tags: ["doc", "prd"] },
  { app: "notion", n: "Q1 OKR draft", tags: ["doc", "okr"] },
  { app: "linear", n: "PWS-218 sizzle reel", tags: ["ticket"] },
  { app: "linear", n: "PWS-204 tray modes", tags: ["ticket"] },
  { app: "github", n: "PR #1142 review", tags: ["code", "pr"] },
  { app: "github", n: "Actions run failed", tags: ["bug", "ci"] },
  { app: "zoom", n: "weekly w/ Sarah — slide 4", tags: ["meeting"] },
  { app: "safari", n: "MDN — backdrop-filter", tags: ["research"] },
  { app: "preview", n: "annotated wireframe — v2", tags: ["design", "spec"] },
  { app: "finder", n: "logo lockup — final.svg", tags: ["asset"] },
  { app: "telegram", n: "Yuri — install screenshot", tags: ["chat", "support"] },
  { app: "vscode", n: "FloatOver tags impl", tags: ["code", "done"] },
  { app: "excel", n: "infra cost forecast", tags: ["finance"] },
  { app: "chrome", n: "Vercel deploy — preview", tags: ["deploy"] },
  { app: "figma", n: "library reel — frame", tags: ["design"] },
  { app: "slack", n: "from Maya — copy variants", tags: ["copy"] },
  { app: "linear", n: "PWS-231 app-source tag", tags: ["ticket", "spec"] },
  { app: "terminal", n: "pnpm install — error", tags: ["bug", "build"] }
];

const DAYS = [
  {
    day: "Today",
    date: "Jan 23",
    times: ["9:42", "10:17", "10:46", "11:08", "11:23", "11:51", "12:04", "12:37"]
  },
  {
    day: "Yesterday",
    date: "Jan 22",
    times: ["8:22", "9:08", "13:14", "14:37", "15:21", "16:02", "16:48", "18:11"]
  },
  {
    day: "Mon",
    date: "Jan 21",
    times: ["7:55", "9:12", "10:33", "11:47", "13:04", "14:25", "15:48", "17:09"]
  },
  {
    day: "Last Fri",
    date: "Jan 18",
    times: ["8:30", "10:10", "11:14", "12:32", "13:55", "14:18", "15:42", "16:30"]
  }
];

const WIDTHS = [1840, 1280, 920, 2560];
const HEIGHTS = [1180, 800, 580, 1440];

export const CAPTURES: Capture[] = BASE.map((c, i) => {
  const dayIdx = Math.floor(i / 8);
  const slot = i % 8;
  const day = DAYS[dayIdx] ?? DAYS[3]!;
  return {
    id: i + 1,
    ...c,
    day: day.day,
    date: day.date,
    time: day.times[slot] ?? "9:00",
    size: 220 + Math.round(Math.sin(i * 1.7) * 100 + 280),
    w: WIDTHS[i % 4]!,
    h: HEIGHTS[i % 4]!
  };
});

export const APP_INFO: Record<string, { name: string; count: number }> = {
  // `any` is the fallback the adapter assigns when a real capture's
  // source_app_bundle_id is null (Phase 1 always; Phase 3 fills the
  // bundle id via NSWorkspace). Without this entry, every Phase 1
  // capture crashes the Library when APP_INFO[c.app]!.name evaluates.
  any: { name: "Unknown app", count: 0 },
  telegram: { name: "Telegram", count: 3 },
  excel: { name: "Excel", count: 3 },
  vscode: { name: "VS Code", count: 3 },
  chrome: { name: "Chrome", count: 3 },
  figma: { name: "Figma", count: 3 },
  slack: { name: "Slack", count: 3 },
  terminal: { name: "Terminal", count: 3 },
  notion: { name: "Notion", count: 2 },
  linear: { name: "Linear", count: 3 },
  github: { name: "GitHub", count: 2 },
  zoom: { name: "Zoom", count: 1 },
  safari: { name: "Safari", count: 1 },
  preview: { name: "Preview", count: 1 },
  finder: { name: "Finder", count: 1 }
};

export type DayGroup = { day: string; date: string; items: Capture[] };

export function groupByDay(items: Capture[]): DayGroup[] {
  const m: Record<string, DayGroup> = {};
  for (const c of items) {
    if (!m[c.day]) m[c.day] = { day: c.day, date: c.date, items: [] };
    m[c.day]!.items.push(c);
  }
  return Object.values(m);
}
