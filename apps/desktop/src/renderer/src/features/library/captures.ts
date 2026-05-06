import type { AppId } from "../shared/AppIcons";

export type Capture = {
  id: number;
  /** App key — curated short id for known apps (`"slack"`), lowercased
   *  bundle id (`"com.spotify.client"`) for unknown apps. Used as the
   *  group key for the sidebar and the icon-lookup key in AppIcon. */
  app: AppId;
  /** Captured user-facing app name (`"Spotify"`, `"Microsoft Edge"`).
   *  Drives the chip label and procedural-icon initials when there's
   *  no hand-drawn glyph for `app`. Null for the demo fixtures and
   *  any record that came in without a `source_app_name`. */
  appName: string | null;
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
    appName: null,
    day: day.day,
    date: day.date,
    time: day.times[slot] ?? "9:00",
    size: 220 + Math.round(Math.sin(i * 1.7) * 100 + 280),
    w: WIDTHS[i % 4]!,
    h: HEIGHTS[i % 4]!
  };
});

/**
 * Curated display names for the apps we ship a hand-drawn icon for.
 * Looked up by `app` key (the curated short id from
 * `mapBundleIdToAppId`). Apps that fall through to the lowercased
 * bundle id (or `"any"`) are NOT in this map — Library.tsx uses each
 * capture's `appName` (the OS-supplied user-facing name) for those,
 * falling back to `"Unknown app"` only when neither is available.
 *
 * The `"any"` placeholder is intentionally absent: leaving it in here
 * would shadow a captured `source_app_name` for records whose bundle
 * id is null but whose name is set (Swift helper succeeded on name
 * lookup but failed on bundle id), forcing them to render as
 * "Unknown app" instead of the user-facing name we already have.
 */
export const APP_INFO: Record<string, { name: string }> = {
  telegram: { name: "Telegram" },
  excel: { name: "Excel" },
  vscode: { name: "VS Code" },
  chrome: { name: "Chrome" },
  figma: { name: "Figma" },
  slack: { name: "Slack" },
  terminal: { name: "Terminal" },
  notion: { name: "Notion" },
  linear: { name: "Linear" },
  github: { name: "GitHub" },
  zoom: { name: "Zoom" },
  safari: { name: "Safari" },
  preview: { name: "Preview" },
  finder: { name: "Finder" }
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
