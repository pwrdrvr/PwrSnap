// Profile catalog + deterministic distribution sampler for the dev
// seeder. Profile = a named target shape (rows, day spread, lumpiness,
// max-per-day cap). Distribution = power-law over 100 synthetic
// `source_app_bundle_id` values + Zipf weights over an active day
// window. Re-running the same profile is bit-identical.
//
// Empirical caveat: real-world capture-tool app distributions are
// closer to lognormal than strict Zipf. For the seeder's stress
// purpose ("lumpy enough"), Zipf at s ∈ [0.6, 1.1] is a defensible
// approximation that hits the inflection points (top ~10 apps carry
// majority mass) without dragging in a heavier sampling library.

export type EverydayProfile = "100" | "1k" | "2k" | "10k" | "20k";
export type FlaggedProfile = "stress100k";
export type ProfileName = EverydayProfile | FlaggedProfile;

const FLAGGED: ReadonlySet<ProfileName> = new Set<FlaggedProfile>(["stress100k"]);
export const isFlagged = (n: ProfileName): n is FlaggedProfile => FLAGGED.has(n);

export type Profile = {
  rows: number;
  /** Days within the spread window that contain at least one row. */
  numActiveDays: number;
  /** How far back the active-day window reaches. */
  windowDays: number;
  /** Zipf concentration. Higher = more lumpy. ~1.0 is a natural default. */
  zipfS: number;
  /** Soft cap on rows per active day. Overflow re-distributes. */
  maxPerDay: number;
  /** Stable RNG seed. Re-running the same profile is bit-identical. */
  rngSeed: string;
};

export const PROFILES = {
  "100":        { rows: 100,    numActiveDays: 30,  windowDays: 365,  zipfS: 0.6, maxPerDay: 10,  rngSeed: "pwrsnap-100"        },
  "1k":         { rows: 1000,   numActiveDays: 100, windowDays: 365,  zipfS: 0.8, maxPerDay: 30,  rngSeed: "pwrsnap-1k"         },
  "2k":         { rows: 2000,   numActiveDays: 200, windowDays: 730,  zipfS: 0.8, maxPerDay: 30,  rngSeed: "pwrsnap-2k"         },
  "10k":        { rows: 10000,  numActiveDays: 400, windowDays: 1095, zipfS: 1.0, maxPerDay: 200, rngSeed: "pwrsnap-10k"        },
  "20k":        { rows: 20000,  numActiveDays: 500, windowDays: 1095, zipfS: 1.0, maxPerDay: 250, rngSeed: "pwrsnap-20k"        },
  "stress100k": { rows: 100000, numActiveDays: 900, windowDays: 1825, zipfS: 1.1, maxPerDay: 300, rngSeed: "pwrsnap-stress100k" }
} as const satisfies Record<ProfileName, Profile>;

export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[];

// ── RNG primitives ────────────────────────────────────────────────

/**
 * Mulberry32 — small deterministic PRNG. ~10 LOC, public domain. The
 * seeder's tests assert `mulberry32(seed)()` produces identical
 * sequences across runs.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash. Seed strings → 32-bit ints for mulberry32. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── Bundle-id catalog ─────────────────────────────────────────────

const APP_LABELS: readonly string[] = [
  "Slack", "VS Code", "Chrome", "Figma", "Notion", "Spotify",
  "Telegram", "Mail", "Calendar", "Excel", "Word", "PowerPoint",
  "Terminal", "iTerm", "Safari", "Firefox", "Arc", "Discord",
  "Zoom", "Linear", "GitHub Desktop", "Postman", "Insomnia",
  "Docker", "Sequel Pro", "TablePlus", "DataGrip", "Sublime Text",
  "Atom", "Vim", "Emacs", "Xcode", "Android Studio", "IntelliJ",
  "WebStorm", "PyCharm", "GoLand", "RubyMine", "CLion", "Rider",
  "Photoshop", "Illustrator", "Lightroom", "After Effects", "Premiere",
  "Final Cut Pro", "Logic Pro", "GarageBand", "Reaper", "Audacity",
  "OBS", "QuickTime", "VLC", "IINA", "Music", "Podcasts", "Books",
  "Pages", "Numbers", "Keynote", "Sketch", "InVision", "Miro",
  "Loom", "CleanShot", "Bear", "Obsidian", "Roam", "Logseq",
  "Things", "OmniFocus", "Reminders", "Todoist", "Trello", "Asana",
  "Monday", "ClickUp", "Jira", "Confluence", "Coda", "Airtable",
  "Dropbox", "Drive", "iCloud", "OneDrive", "Box", "Backblaze",
  "1Password", "Bitwarden", "Authy", "Tunnelblick", "ExpressVPN",
  "Activity Monitor", "Console", "Disk Utility", "System Settings",
  "Keychain Access", "Photo Booth", "Preview", "Stickies", "Calculator"
];

/**
 * Generate `n` synthetic `source_app_bundle_id` values. Mirrors the
 * shape Apple uses (`com.<vendor>.<app>`). Deterministic given a
 * fixed list. The first 100 entries cover the brainstorm's "100
 * application tags" framing; if `n > 100`, append `app-<idx>`.
 */
export function generateBundleIdCatalog(n: number): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const label = APP_LABELS[i] ?? `App ${i}`;
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    out.push(`com.pwrsnap.synth.${slug || `app-${i}`}`);
  }
  return out;
}

export const SYNTHETIC_BUNDLE_IDS: readonly string[] = generateBundleIdCatalog(100);

/**
 * Derive a human-readable app name from a synthetic bundle id.
 * `com.pwrsnap.synth.vs-code` → `VS Code` (best-effort: capitalize +
 * de-slug). Used to populate `source_app_name` so the Library's
 * sidebar shows recognizable labels.
 */
export function appNameFor(bundleId: string): string {
  const idx = SYNTHETIC_BUNDLE_IDS.indexOf(bundleId);
  if (idx >= 0 && APP_LABELS[idx] !== undefined) return APP_LABELS[idx];
  // Unknown synthetic — slug → title-case
  const last = bundleId.split(".").pop() ?? bundleId;
  return last.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Distribution algorithm ────────────────────────────────────────

export type PlannedRow = {
  index: number;
  capturedAt: string; // ISO 8601 with ms precision
  bundleId: string;
  appName: string;
};

/**
 * Build a row plan for a profile. Steps:
 *   1. Pick `numActiveDays` distinct days from the window (uniform).
 *   2. Assign Zipf weights, normalize to sum=rows; cap at `maxPerDay`.
 *   3. Distribute timestamps within each active day uniformly across
 *      09:00–23:00.
 *   4. Pick a `bundleId` per row via Zipf over `SYNTHETIC_BUNDLE_IDS`.
 *   5. Sort by capturedAt ASC; bump duplicate timestamps by +1 ms so
 *      the keyset cursor's `(captured_at, id)` ordering is
 *      unconditionally stable.
 *
 * Deterministic given `(profile.rngSeed)`.
 */
export function planRows(profile: Profile, now: Date = new Date()): PlannedRow[] {
  const rng = mulberry32(hashSeed(profile.rngSeed));

  // ── 1. Active days (distinct, uniform across the window) ──────
  const totalDays = profile.windowDays;
  const numActive = Math.min(profile.numActiveDays, totalDays);
  const activeDayOffsets = pickDistinctDayOffsets(rng, numActive, totalDays);

  // ── 2. Zipf weights → row counts per active day ───────────────
  const dayWeights = zipfWeights(rng, activeDayOffsets.length, profile.zipfS);
  const dayCounts = allocateRowsToDays(profile.rows, dayWeights, profile.maxPerDay);

  // ── 3 + 4. Timestamps within each day + bundleId per row ──────
  const bundleWeights = zipfWeights(rng, SYNTHETIC_BUNDLE_IDS.length, profile.zipfS);
  const bundleCdf = cumulative(bundleWeights);

  const rows: PlannedRow[] = [];
  for (let dayIdx = 0; dayIdx < activeDayOffsets.length; dayIdx++) {
    const offset = activeDayOffsets[dayIdx];
    if (offset === undefined) continue;
    const count = dayCounts[dayIdx] ?? 0;
    if (count === 0) continue;
    const dayStart = startOfDayUtc(now, offset);
    for (let i = 0; i < count; i++) {
      // 09:00–23:00 = 14h = 50.4M ms within the day.
      const dayMs = 9 * 3_600_000 + Math.floor(rng() * 14 * 3_600_000);
      const ts = dayStart + dayMs;
      const bundleIdx = sampleFromCdf(rng, bundleCdf);
      const bundleId = SYNTHETIC_BUNDLE_IDS[bundleIdx] ?? SYNTHETIC_BUNDLE_IDS[0]!;
      rows.push({
        index: -1, // assigned after sort
        capturedAt: new Date(ts).toISOString(),
        bundleId,
        appName: appNameFor(bundleId)
      });
    }
  }

  // ── 5. Sort by capturedAt; bump duplicates by +1 ms ───────────
  rows.sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0));
  let prevMs = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const ms = Date.parse(row.capturedAt);
    if (ms <= prevMs) {
      const bumped = prevMs + 1;
      row.capturedAt = new Date(bumped).toISOString();
      prevMs = bumped;
    } else {
      prevMs = ms;
    }
    row.index = i;
  }
  return rows;
}

// ── helpers ───────────────────────────────────────────────────────

function pickDistinctDayOffsets(rng: () => number, n: number, windowDays: number): number[] {
  const set = new Set<number>();
  while (set.size < n) {
    set.add(Math.floor(rng() * windowDays));
  }
  return Array.from(set).sort((a, b) => a - b);
}

function zipfWeights(rng: () => number, k: number, s: number): number[] {
  // Weights sorted descending by rank (rank-1 = heaviest). Within a
  // call we use them in two ways: to weight DAYS (where ordering
  // doesn't matter — we shuffle so heavy days fall anywhere) and to
  // weight BUNDLE IDS (where the ordering DOES matter — top-10
  // bundle ids are the "heavy" apps).
  //
  // For day weights we shuffle. For bundle weights we leave sorted —
  // SYNTHETIC_BUNDLE_IDS[0..9] are the "heavy hitters" by design.
  const out: number[] = [];
  for (let i = 1; i <= k; i++) out.push(1 / Math.pow(i, s));
  // Caller-decides shuffle; for symmetry, inline a Fisher-Yates here
  // for the day-weights case. Bundle-weights caller can re-sort
  // descending afterwards.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function cumulative(weights: number[]): number[] {
  const sorted = [...weights].sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0);
  const cdf: number[] = [];
  let acc = 0;
  for (const w of sorted) {
    acc += w / total;
    cdf.push(acc);
  }
  return cdf;
}

function sampleFromCdf(rng: () => number, cdf: number[]): number {
  const u = rng();
  for (let i = 0; i < cdf.length; i++) {
    if (u < (cdf[i] ?? 1)) return i;
  }
  return cdf.length - 1;
}

function allocateRowsToDays(totalRows: number, weights: number[], maxPerDay: number): number[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  // Initial proportional allocation (rounded down); track residuals.
  const counts: number[] = weights.map((w) => Math.floor((w / sumW) * totalRows));
  let residual = totalRows - counts.reduce((a, b) => a + b, 0);
  // Distribute residual to days with biggest fractional remainder.
  const fracs = weights
    .map((w, idx) => ({ idx, frac: ((w / sumW) * totalRows) - (counts[idx] ?? 0) }))
    .sort((a, b) => b.frac - a.frac);
  for (let i = 0; residual > 0 && i < fracs.length; i++) {
    counts[fracs[i]!.idx] = (counts[fracs[i]!.idx] ?? 0) + 1;
    residual -= 1;
  }
  // Apply maxPerDay cap; redistribute overflow round-robin.
  for (let pass = 0; pass < 3; pass++) {
    let overflow = 0;
    for (let i = 0; i < counts.length; i++) {
      const c = counts[i] ?? 0;
      if (c > maxPerDay) {
        overflow += c - maxPerDay;
        counts[i] = maxPerDay;
      }
    }
    if (overflow === 0) break;
    // Distribute to under-cap days, biggest first.
    const candidates = counts
      .map((c, idx) => ({ idx, room: maxPerDay - c }))
      .filter((x) => x.room > 0)
      .sort((a, b) => b.room - a.room);
    for (const c of candidates) {
      if (overflow === 0) break;
      const take = Math.min(c.room, overflow);
      counts[c.idx] = (counts[c.idx] ?? 0) + take;
      overflow -= take;
    }
    if (overflow > 0) {
      // Window is too small for maxPerDay × numActive — caller picked
      // an impossible profile shape. Stuff the rest into the last
      // bucket; the test suite will catch this.
      counts[counts.length - 1] = (counts[counts.length - 1] ?? 0) + overflow;
    }
  }
  return counts;
}

function startOfDayUtc(now: Date, offsetDays: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.getTime();
}
