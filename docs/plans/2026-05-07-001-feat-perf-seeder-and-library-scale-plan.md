---
title: Perf Seeder + Library Scale to 100k Captures
type: feat
status: active
date: 2026-05-07
origin: docs/brainstorms/2026-05-07-perf-seeder-and-library-scale-requirements.md
deepened: 2026-05-07
---

# Perf Seeder + Library Scale to 100k Captures

## Enhancement Summary

**Deepened on:** 2026-05-07 with eight parallel review/research agents:
architecture, performance, simplicity, TypeScript, data-integrity,
migration-safety, framework-docs, best-practices.

### Key corrections (correctness)

1. **Index DDL** — `idx_captures_recency` must declare both columns
   `DESC`: `(captured_at DESC, id DESC) WHERE deleted_at IS NULL`. Plan
   originally had only the lead column DESC. Without matching directions
   the planner can insert a temp b-tree sort.
2. **Insert + `bumpAppStat` must run inside `db.transaction()`** — not
   "same statement bundle." Without a real SQLite transaction, a crash
   between the two statements drifts the `app_stats` invariant the plan
   promises CI will catch.
3. **`insertOrFindCapture` should use `INSERT … ON CONFLICT(sha256) DO
   NOTHING RETURNING *`** (SQLite 3.35+) — collapses the existing
   `SELECT` + `INSERT` round-trip into one atomic statement.
4. **Seeder must hard-fail on `isNew === false`.** `insertOrFindCapture`
   silently dedups on sha256 collision; without a hard assert the row
   count is short by 1 and EXPLAIN tests pass on a malformed DB.
5. **`'∅'` sentinel for NULL bundle id is fragile.** Replace with
   nullable column + partial unique index on `COALESCE(bundle_id, '')`;
   add `CHECK (count >= 0)` to catch double-decrement bugs at the DB
   layer.
6. **TanStack Virtual nesting** — use `useVirtualizer` with a
   `getScrollElement` callback against `.psl__grid-wrap`, not
   `useWindowVirtualizer` (which fights the existing nested scroll
   container). Sticky day-headers require an explicit `rangeExtractor`
   that always pins the active sticky index — known TanStack gotcha
   ([TanStack/virtual#640](https://github.com/TanStack/virtual/issues/640)).
7. **`exactOptionalPropertyTypes` compliance** — every optional field
   in `capture:ingest` and the new `library:list` cursor must be
   `?: T | undefined`, not bare `?: T`. The codebase's
   `tsconfig.base.json` enforces this; the plan's original snippets
   wouldn't compile.
8. **`import.meta.env.DEV` is renderer-typed only.** Main needs
   `apps/desktop/src/main/vite-env.d.ts` with `electron-vite/node`
   reference, otherwise the static substitution silently degrades to
   `any` and the tree-shake guarantee is invalidated.
9. **Sentinel UUID + mtime check** for wipe safety, not just file
   existence — defends against Time Machine-restored stale sentinels.
10. **Same-volume invariant** between `getCapturesRoot()` and
    `getTrashRoot()` — atomic rename on soft-delete fails with EXDEV
    across volumes. Add a startup smoke check.

### Key corrections (design)

11. **`PRAGMA optimize`** at every connection open (`0x10002` mask) +
    on quit. SQLite team's recommendation as of 3.46. Currently absent
    from `db.ts`. Single highest-leverage missing piece.
12. **Drop `db.ts` re-exports** outright — the soft delegation invites
    drift. Sweep `source-store.ts` (the only real consumer) to import
    from `paths.ts` in the same PR and delete the `db.ts` exports.
13. **Encapsulate `bumpAppStat` inside the repo functions**
    (`insertOrFindCapture`, `softDeleteCapture`), not as separate
    handler-side calls. Tightens the invariant ownership.
14. **Cut `library:appStats` separate command** — fold into
    `library:list` response. Saves a round-trip on every Library open
    and removes one parity-test entry.
15. **Cut `--seed-trace` flag** — RAF-based scroll probe is the primary
    metric; chrome://tracing can be added in ~5 lines if diagnosis
    actually needs it.
16. **Cut `getDocumentsExportRoot()` placeholder.** Pure YAGNI;
    forward-stream owns its own accessor when it lands.
17. **Cold-load probe via renderer-side reload IPC, not window
    recreate.** Window construction is 100–400ms of NSWindow / GPU
    surface boot — pure noise vs. the data-load path we want to
    measure. Add window-recreate as a separate, once-per-profile
    baseline.
18. **Collapse seeder to 4 files** (`index.ts`, `profiles.ts`,
    `runner.ts`, `wipe.ts`) — `distribution.ts`, `png-gen.ts`,
    `measurement.ts` were filing-cabinet structure for ~50 LOC each.
    Wipe stays separate because the safety code is worth isolating
    for review.
19. **Replace reservoir-sampling quantile estimator with sort-and-pick.**
    Bucket sizes ≤50k samples × 8 bytes = 400 KB; sort is sub-50ms.
    Reservoir was overengineering.
20. **Drop `suppressBroadcast` from `capture:ingest` request shape.**
    It's a seeder-internal optimization; move broadcast-throttling
    into the runner via debounced broadcast or a no-op listener.
21. **`capture:ingest` ships dev-gated**, not permanent, until a real
    consumer lands. Permanent commands enlarge the parity surface and
    `tempPngPath` is a path-traversal sink over future HTTP RPC
    without a trusted-root validator.
22. **MeasurementRow as a discriminated union** with `assertNever` —
    the JSONL is a read path (Phase 5 generates a results table), not
    write-only.
23. **`recomputeAppStats()` self-heal** — periodic reconciliation in
    addition to the CI invariant test. Cheap (one indexed scan) and
    converts drift from a CI-only concept into an in-product safety
    net. Bound to a hidden dev tray "Repair stats" item + a guarded
    boot-time check.
24. **Bundle-size diff in CI** + runtime `NODE_ENV !== 'production'`
    defense-in-depth alongside `import.meta.env.DEV` for the seeder
    tree-shake gate.
25. **Bump `capturedAt` by +1 ms per duplicate within a day** so the
    keyset cursor's `(captured_at, id)` ordering is unconditionally
    stable even with the seeder's bulk-day inserts.

### Sections most affected

- "Architecture > Data-root rerooting" — drop deprecation shim, add
  same-volume invariant.
- "Architecture > `capture:ingest` command" — DEV-gate, drop
  `suppressBroadcast`, fix `exactOptionalPropertyTypes`.
- "Architecture > Schema changes (`0003_perf.sql`)" — full rewrite of
  the migration body.
- "Architecture > Seeder structure" — 4-file tree, sort-and-pick,
  collision hard-fail.
- "Architecture > Library scale" — `useVirtualizer` + `rangeExtractor`,
  fold `library:appStats` into `library:list`.
- "Architecture > Measurement" — sorted-array quantiles, reload-IPC
  cold-load probe, MeasurementRow union, drop `--seed-trace`.

## Overview

Build a dev-only seeder that produces realistic SQLite + on-disk state at
canonical sizes (100, 1k, 2k, 10k, 20k, plus a flagged `stress100k`),
inserting through the live command-bus so that DB packing, file-system
cost, and capture-pipeline overhead are exercised the same way a real
capture would. Use the resulting datasets to measure per-batch insert
latency, Library cold-load time, scroll frame-time, and DB sizing — and
land the structural fixes (virtualization, keyset pagination, count
denormalization, recency-leading partial index) required to keep the
Library snappy regardless of dataset size.

The brainstorm explicitly chose **direction over numbers** as the success
bar (see origin: `docs/brainstorms/2026-05-07-perf-seeder-and-library-scale-requirements.md`,
"Success Criteria"): the gate is a flat / sublinear curve from 100 →
100k, not specific ms targets.

## Problem Statement

The Library was built around a hand-curated fixture set of ~50 rows.
Production realities at 10k–100k captures:

- `library:list` caps at `limit: 500` ([useLibrary.ts:50](apps/desktop/src/renderer/src/lib/useLibrary.ts:50))
  and renders one DOM cell per row ([Library.tsx](apps/desktop/src/renderer/src/features/library/Library.tsx)).
  At 100k there's nothing to render — the cap throws away 99.5% of the
  user's library.
- `idx_captures_timeline` is `(source_app_bundle_id, captured_at DESC)
  WHERE deleted_at IS NULL` ([0001_init.sql](apps/desktop/src/main/persistence/migrations/0001_init.sql)).
  An unfiltered recency query (the default Library load) does not lead
  with the recency column and so the index does not help — at scale
  this becomes a sort of the partial index entries.
- The sidebar shows "Apps" grouping but counts (if added) would be
  `COUNT(*)` over the captures table per app — quadratic on Library
  open if naïvely added.
- We have no measurement of insert cost at scale, so we cannot tell
  whether anything is O(n²).
- All persistent state lives under `app.getPath("userData")` (see all
  four call sites in [db.ts:45-57](apps/desktop/src/main/persistence/db.ts:45)).
  Running a 100k seed against the user's real Library would be
  catastrophic and impossible to clean up.

A future stream of work intends to put some PwrSnap data under
`~/Documents` (origin: "Dependencies / Assumptions" — forward-looking).
Any rerooting primitive added now has to cover that path too.

## Proposed Solution

A 5-phase change. Phases stack — each is independently shippable but
the perf measurement (Phase 5) only meaningfully runs after the fixes
in Phase 4 land.

1. **Foundation** — `PWRSNAP_DATA_ROOT` env-var rerooting; new
   `capture:ingest` command on the bus; wipe-with-sentinel safety.
2. **Seeder core** — color-banded PNG generator, profile catalog,
   power-law / Zipf distribution + lumpy day spread, runner +
   per-batch latency measurement, dev-only tray menu + CLI flag with
   build-time exclusion.
3. **DB schema improvements** — `app_stats` table with backfill +
   inline maintenance; new `idx_captures_recency` partial index; seed
   migration `0003_perf.sql`.
4. **Library scale fixes** — keyset/cursor pagination on
   `library:list`; TanStack Virtual integration in `Library.tsx`;
   sidebar reads from `app_stats`.
5. **Measurement + acceptance** — cold-load + scroll instrumentation;
   `dbstat` + `EXPLAIN QUERY PLAN` snapshots; full-ladder run; flat /
   sublinear curve validation.

## Technical Approach

### Architecture

#### Data-root rerooting (R1)

Single-source-of-truth path resolver in a new
[`apps/desktop/src/main/persistence/paths.ts`](apps/desktop/src/main/persistence/paths.ts):

```ts
// apps/desktop/src/main/persistence/paths.ts
import { app } from "electron";
import { statSync } from "node:fs";
import { join } from "node:path";

const ENV_KEY = "PWRSNAP_DATA_ROOT";

export function getDataRoot(): string {
  const override = process.env[ENV_KEY];
  if (override !== undefined && override.length > 0) return override;
  return app.getPath("userData");
}

export function isOverriddenDataRoot(): boolean {
  return getDataRoot() !== app.getPath("userData");
}

export function getDbPath(): string         { return join(getDataRoot(), "pwrsnap.db"); }
export function getCapturesRoot(): string   { return join(getDataRoot(), "captures"); }
export function getCacheRoot(): string      { return join(getDataRoot(), "render-cache"); }
export function getTrashRoot(): string      { return join(getDataRoot(), ".trash"); }
export function getPerfRoot(): string       { return join(getDataRoot(), "perf"); }

// Sentinel marker that this is a seeder-managed tree. Created when the
// seeder first touches a non-default root; required for any wipe.
// Content is a UUID generated at create time + mtime check on use —
// see dev/seeder/wipe.ts.
export const SEEDER_SENTINEL = ".pwrsnap-perf-root";

/**
 * Invariant: getCapturesRoot() and getTrashRoot() must live on the
 * same filesystem so soft-delete's atomic rename succeeds. The
 * compose-from-getDataRoot() shape enforces this by construction;
 * this check is a defensive smoke test for future code that might
 * route trash differently.
 */
export function assertSameVolume(): void {
  if (!import.meta.env.DEV) return;
  try {
    const captures = statSync(getCapturesRoot()).dev;
    const trash = statSync(getTrashRoot()).dev;
    if (captures !== trash) {
      throw new Error(
        `paths invariant violated: captures and trash on different volumes`
      );
    }
  } catch {
    // Either path may not exist yet; that's fine — they will be
    // created under the same root.
  }
}
```

**Sweep `db.ts` exports outright.** The original plan kept the four
existing accessors as thin re-exports for backward compat. Per
architectural review: the only consumer is
[`source-store.ts`](apps/desktop/src/main/persistence/source-store.ts);
sweep its imports to `paths.ts` in the same PR and delete the `db.ts`
exports. Soft delegation produces two import sites for the same
concept and invites future code to land on the deprecated one.

> **Removed:** `getDocumentsExportRoot()` placeholder. Per simplicity
> review, anticipatory abstraction with no current consumer is YAGNI;
> the forward-stream that adds Documents-backed storage will route
> through `paths.ts` and add its own accessor at that time.

> **`getDataRoot()` and `app.getPath()` are now the only places main
> may resolve persistence paths.** Add an ESLint rule banning
> `app.getPath("userData")` outside `paths.ts` and banning raw SQL
> against `captures` outside `captures-repo.ts`.

#### `capture:ingest` command (R3)

Dev-gated command on the bus — registered only when
`import.meta.env.DEV` is true. The original plan shipped this as a
permanent command on the rationale "future agent flow could ingest a
synthesized snap." Per architectural review: a permanent command for a
hypothetical caller bloats the parity surface (every transport must
expose it), and `tempPngPath` becomes a path-traversal sink over future
HTTP RPC without a trusted-root validator. Gate on `DEV` until a real
consumer lands; lifting the gate is one-line.

`exactOptionalPropertyTypes`-correct shape (the codebase enforces this
in `tsconfig.base.json` — bare `?: T` means `T | <missing>`, not
`T | undefined`, and dynamic builders that pass `undefined` would fail
typechecking):

```ts
// packages/shared/src/protocol.ts
export type LibraryCursor = { capturedAt: string; id: string };

"capture:ingest": {
  req: {
    /** Absolute path to a temp PNG. Caller owns; handler reads, hashes, persists. */
    tempPngPath: string;
    /** ISO 8601 with millisecond precision. Backdated for seeded rows. */
    capturedAt: string;
    sourceAppBundleId: string | null;
    sourceAppName: string | null;
    /** Optional: when omitted, source-store reads via sharp metadata. */
    widthPxHint?: number | undefined;
    heightPxHint?: number | undefined;
    devicePixelRatio?: number | undefined;
  };
  res: { record: CaptureRecord; isNew: boolean };
}
```

> **Removed:** `suppressBroadcast` from the request shape. Per
> architectural + simplicity review, broadcast throttling is a
> seeder-internal optimization and doesn't belong on the protocol
> surface. The runner installs a debounced no-op listener on
> `events:captures:changed` for the duration of a seed run, then
> emits one final broadcast when the profile completes (and at JSONL
> bucket boundaries if the live Library is open). The handler always
> broadcasts; the seeder absorbs the noise.

Handler chain ([capture-handlers.ts](apps/desktop/src/main/handlers/capture-handlers.ts)):

```
capture:ingest req
  → putCaptureSourceWithCapturedAt(tempPngPath, capturedAt)
       (parameterized version of putCaptureSource that accepts an
        explicit captured_at; not a sibling — same code path with one
        extra argument so paths don't drift)
  → insertOrFindCapture({ ...metadata, captured_at })
       (now wraps INSERT … ON CONFLICT(sha256) DO NOTHING RETURNING *
        + bumpAppStat(+1) inside db.transaction(); see below)
  → broadcastCapturesChanged([id])  (factored out of capture-handlers.ts
                                     into a shared events.ts so the
                                     seeder runner can intercept)
```

`broadcastCapturesChanged` is currently file-private to
[`capture-handlers.ts:43-48`](apps/desktop/src/main/handlers/capture-handlers.ts:43);
factor it out to `apps/desktop/src/main/events.ts` so the seeder
runner can install its own debounce/no-op listener path.

#### Bus principal (TypeScript review)

The seeder dispatches via `bus.dispatch(name, req, ctx)`. The third
arg requires a `CommandContext`. Add a `"seeder"` member to
`CommandPrincipal` so seeder dispatches are distinguishable in any
future audit log — the wipe-the-DB blast radius makes this worth
having now. `principal: "ipc"` would also work today but loses the
provenance signal.

#### Seeder structure (R2, R4, R6, R7, R8)

New module tree under [`apps/desktop/src/main/dev/seeder/`](apps/desktop/src/main/dev/seeder/) —
collapsed to four files per simplicity review:

```
apps/desktop/src/main/dev/seeder/
├── index.ts            ← registerDevSeeder() entry + tray menu wiring + CLI flag
├── profiles.ts         ← profile catalog + bundle-id catalog +
│                         deterministic distribution (Zipf, day-spread,
│                         mulberry32 RNG, FNV-1a seed hash)
├── runner.ts           ← orchestration: build plan, dispatch ingests,
│                         compose PNG via sharp, write JSONL, run probes
└── wipe.ts             ← sentinel-guarded data-root reset (kept separate
│                         because the safety code is worth isolating for
│                         review)
```

`distribution.ts`, `png-gen.ts`, `measurement.ts` from the original
plan are folded — each was ~50 LOC and didn't earn its own file.

**Build-time exclusion** — the gate runs in [`main/index.ts`](apps/desktop/src/main/index.ts)
with defense-in-depth (static substitution + runtime check):

```ts
if (import.meta.env.DEV && process.env.NODE_ENV !== "production") {
  const { registerDevSeeder } = await import("./dev/seeder");
  registerDevSeeder();
}
```

`import.meta.env.DEV` is statically replaced at build time by
electron-vite (verified in framework-docs research) — the production
build's Rollup pass drops both the branch and the dynamically-imported
module. The runtime `NODE_ENV !== "production"` check is belt-and-
suspenders against an audit oversight + against `vitest` and other
non-electron-vite consumers that import `main/index.ts` directly (where
`import.meta.env.DEV` evaluates live, not statically).

> **TypeScript prerequisite.** `import.meta.env.DEV` typechecks in the
> renderer (which has `vite-env.d.ts` referencing `vite/client`) but
> not in main, which is `tsconfig.json`'s `"types": ["node"]` only.
> Add [`apps/desktop/src/main/vite-env.d.ts`](apps/desktop/src/main/vite-env.d.ts):
>
> ```ts
> /// <reference types="electron-vite/node" />
> ```
>
> Without it, `import.meta.env.DEV` either errors or silently degrades
> to `any` (depending on `skipLibCheck`), and the tree-shake guarantee
> becomes false.

**Acceptance gates** for the tree-shake (Phase 5):
- `grep -r "registerDevSeeder\|dev/seeder" out/` → zero matches.
- Bundle-size regression check: `out/main/index.js` size diff vs.
  baseline must not increase by more than the seeder's source weight.

CLI flag handling sits in `main/index.ts`:

```ts
const seedFlag = process.argv.find((arg) => arg.startsWith("--seed="));
if (seedFlag !== undefined && import.meta.env.DEV) {
  // Run profile then exit; called as `pnpm dev -- --seed=10k`.
}
```

Tray menu items are added by `dev/seeder/index.ts` only when registered.
`tray.ts` exposes a `registerExtraMenuItems(items)` seam — already a
small refactor away.

##### Profile catalog

Per TypeScript review: drop the `flagged` field (encode it in the type
union); use `as const satisfies` to keep literal seed strings; drop
the redundant `name` field (the catalog key is the name):

```ts
// apps/desktop/src/main/dev/seeder/profiles.ts
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
  /** Soft cap on rows per active day. Overflow re-distributes to next-highest. */
  maxPerDay: number;
  /** Stable RNG seed string. Re-running the same profile is bit-identical. */
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

/** Synthetic bundle IDs the seeder distributes across. 100 entries —
 *  matches the brainstorm's "100 application tags" framing. */
export const SYNTHETIC_BUNDLE_IDS: readonly string[] = generateBundleIdCatalog(100);
```

> **Empirical model footnote.** Best-practices research notes that
> real-world tool-usage distributions are typically lognormal or a
> lognormal–Pareto mix; strict Zipf is asymptotic. For the seeder's
> stress purpose ("lumpy enough"), Zipf at `s ∈ [0.6, 1.1]` is a
> defensible approximation. Add a one-line comment in
> `profiles.ts` acknowledging the model is approximate.

##### Distribution algorithm (R6, R7)

`planRows` lives in `profiles.ts` (per the 4-file collapse).

```ts
export type PlannedRow = {
  index: number;            // 0..rows-1 in final temporal order
  capturedAt: string;       // ISO 8601 ms precision
  bundleId: string;         // from SYNTHETIC_BUNDLE_IDS
  appName: string;          // human-friendly label derived from bundleId
};

export function planRows(profile: Profile): PlannedRow[] {
  const rng = mulberry32(hashSeed(profile.rngSeed));

  // 1. Pick `numActiveDays` distinct days from [now - windowDays, now].
  // 2. Assign Zipf weights, normalize to sum=rows.
  // 3. Apply maxPerDay cap; redistribute overflow to next-highest day.
  // 4. For each day, distribute timestamps uniformly across 09:00–23:00.
  // 5. For each row, pick a bundleId via Zipf over SYNTHETIC_BUNDLE_IDS
  //    (top 10 carry ~60% mass at zipfS=1.0).
  // 6. Sort all rows by capturedAt ASC. Assign monotonic index.
  // 7. Walk in order; if any row's capturedAt equals the previous,
  //    bump it by +1ms. Repeat for ties beyond that. Guarantees the
  //    keyset cursor's (capturedAt, id) ordering is unconditionally
  //    stable even with bulk-day inserts. Cost is bounded — at most
  //    maxPerDay collisions per day.
}
```

`mulberry32` is a tiny deterministic PRNG (~10 lines); no extra
dependency. `hashSeed` is FNV-1a over the seed string.

##### PNG generator (R4)

`sharp` (already a dep) composes a 64×64 PNG with:
- Background: HSL color derived from `bundleId` hash (each app gets a
  recognisable hue band — supports "spot bugs by eye while scrolling").
- A small index region in the upper-left corner: 8×8 block colored by
  the row's monotonic index (R, G, B taken from index bytes). Forces
  per-row pixel uniqueness → per-row sha256 uniqueness.
- Optional faint header label rendered via libvips text — keeps each
  row visually distinguishable in the Library at a glance.

Approximate file size: 150–250 bytes per PNG. 100k rows ≈ 20 MB on disk.

> **Brainstorm note (R4 vs R5):** The origin requirements doc lists both
> "sha256-unique per row" (R4) and "hardlink within `(app, day)` bucket"
> (R5). These are mutually exclusive — hardlinks force identical bytes
> → identical sha256 → `insertOrFindCapture` ([captures-repo.ts:67-70](apps/desktop/src/main/persistence/captures-repo.ts:67))
> dedups to a single DB row. **Resolution: drop R5.** At ≤250 bytes per
> PNG, the disk-cost concern that motivated R5 is negligible (20 MB at
> 100k). Carry R4 forward; mark R5 as obsoleted by analysis. (See origin:
> "Requirements R4, R5".)

##### Runner (R3, R8, R9)

```ts
// apps/desktop/src/main/dev/seeder/runner.ts
const SEEDER_PRINCIPAL: CommandPrincipal = "seeder"; // see protocol changes

export async function runProfile(name: ProfileName): Promise<RunResult> {
  assertCanWipe();                          // sentinel + UUID + mtime
  await wipe();                             // clear data root
  await openDatabase();                     // recreates schema via migrations
  await createSentinel();                   // writes UUID + current mtime

  // Install a no-op listener on events:captures:changed so the live
  // Library doesn't rerender for every ingest. Final broadcast at
  // bucket boundaries + profile end.
  const restoreBroadcast = installSeederBroadcastSink();

  const plan = planRows(PROFILES[name]);
  const measurement = openMeasurementStream(name);
  const buckets = [100, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000];
  let nextBucket = 0;

  for (const row of plan) {
    const tempPath = await writeTempPng(row);
    const t0 = performance.now();
    const result = await bus.dispatch(
      "capture:ingest",
      {
        tempPngPath: tempPath,
        capturedAt: row.capturedAt,
        sourceAppBundleId: row.bundleId,
        sourceAppName: appNameFor(row.bundleId),
      },
      { principal: SEEDER_PRINCIPAL }
    );
    measurement.record(performance.now() - t0, result);

    // sha256 collision = generator bug; fail loud so EXPLAIN/curve
    // tests don't pass on a row-short DB.
    if (!result.ok) throw new Error(`ingest failed at row ${row.index}: ${result.error.message}`);
    if (!result.value.isNew) {
      throw new Error(`sha256 collision at row ${row.index} bundleId=${row.bundleId}`);
    }

    // Periodic WAL checkpoint so the WAL doesn't grow unbounded
    // mid-run (per perf review). PASSIVE so it doesn't block writers.
    if ((row.index + 1) % 10_000 === 0) {
      getDb().pragma("wal_checkpoint(PASSIVE)");
    }

    if (row.index + 1 === buckets[nextBucket]) {
      measurement.flushBucket(buckets[nextBucket]);
      restoreBroadcast.flushOnce([]);  // let the live Library see partial state
      nextBucket++;
    }
  }
  restoreBroadcast.dispose();             // restore normal broadcast path
  getDb().pragma("optimize");             // best-practice: stats refresh post-bulk

  await captureSchemaSnapshot(measurement);  // dbstat + EXPLAIN  (Phase 5)
  await runColdLoadProbes(measurement, 5);   // Library probes      (Phase 5)
  await runScrollProbes(measurement);        // frame-time          (Phase 5)
  return measurement.close();
}
```

> **Insert-throughput note.** Per perf review, individual
> `capture:ingest` dispatches run as separate SQLite transactions —
> realistic for production capture cadence (one snap at a time) but
> at 100k rows the fsync cost dominates (~300–800 rows/sec on SSD).
> Two mitigations are *available* but not default:
> 1. `--seed-batch=N` flag wraps every N dispatches in a single
>    `db.transaction()`. Amortizes fsync; useful for "is index growth
>    super-linear?" diagnosis where fsync noise hides the curve.
> 2. The default behavior (per-row, autocommit) is the production-
>    fidelity measurement. Document expected wall-time per profile so
>    nobody is surprised that `stress100k` takes 2–6 minutes.

##### Wipe safety (R8 + open question resolved)

Per data-integrity review: defense-in-depth around the file existence
check (Time Machine restore could preserve a stale sentinel). Per
simplicity review: the env-not-equal-userData check is tautological
once the sentinel UUID matches (the seeder never writes a sentinel
under userData), and the banned-paths list is redundant under the
same logic. Final design — sentinel is the primary guard, content +
mtime are the secondary checks:

```ts
// apps/desktop/src/main/dev/seeder/wipe.ts
type SentinelBlob = { uuid: string; createdAt: string };

export function assertCanWipe(): void {
  // Primary: the configured root must NOT be the default userData.
  if (!isOverriddenDataRoot()) {
    throw new Error("Refusing to wipe: PWRSNAP_DATA_ROOT is unset or equal to userData.");
  }
  const sentinelPath = join(getDataRoot(), SEEDER_SENTINEL);
  if (!existsSync(sentinelPath)) {
    throw new Error(`Refusing to wipe: ${sentinelPath} not found. Run a non-wipe seed first to claim this root.`);
  }
  // Secondary: sentinel content must parse and the UUID must match the
  // expected shape (rules out empty/corrupted/restored files).
  const blob = JSON.parse(readFileSync(sentinelPath, "utf8")) as SentinelBlob;
  if (typeof blob.uuid !== "string" || blob.uuid.length !== 32) {
    throw new Error(`Refusing to wipe: sentinel content malformed at ${sentinelPath}`);
  }
  // Tertiary: stale sentinel guard. A backup-restored sentinel from
  // months ago shouldn't authorize a wipe of accumulated data.
  const ageDays = (Date.now() - statSync(sentinelPath).mtimeMs) / 86_400_000;
  if (ageDays > 30) {
    throw new Error(`Refusing to wipe: sentinel mtime is ${ageDays.toFixed(0)}d old; create a fresh seed run first.`);
  }
}
```

#### Schema changes (R15, R16) — `0003_perf_app_stats.sql`

> **Filename:** `0003_perf_app_stats.sql` (more self-documenting than
> the original `0003_perf.sql`; matches `0001_init.sql` /
> `0002_overlays.sql` peer pattern).

```sql
-- 0003_perf_app_stats — denormalized app counts + recency-leading index
-- for the unfiltered timeline read. Pairs with the perf-seeder work.

-- Per-app live count. NULL bundle_id is preserved as NULL (no '∅'
-- sentinel — keeps `WHERE source_app_bundle_id IS NULL` joins working
-- without special cases). The partial unique index over
-- COALESCE(bundle_id, '') is what gives us point-lookup + UPSERT.
CREATE TABLE app_stats (
  source_app_bundle_id  TEXT,
  count                 INTEGER NOT NULL DEFAULT 0,
  CHECK (count >= 0)
);

CREATE UNIQUE INDEX idx_app_stats_bundle
  ON app_stats (COALESCE(source_app_bundle_id, ''));

-- Backfill: GROUP BY honors NULL (every NULL bundle_id collapses to
-- the same group), so the COUNT(*) lands in a single (bundle_id IS NULL)
-- row. No sentinel character anywhere.
INSERT INTO app_stats (source_app_bundle_id, count)
SELECT source_app_bundle_id, COUNT(*)
FROM captures
WHERE deleted_at IS NULL
GROUP BY source_app_bundle_id;

-- Recency-leading partial index for unfiltered Library timeline reads.
-- BOTH columns DESC so the planner satisfies `ORDER BY captured_at DESC,
-- id DESC` with a single forward index walk — no temp b-tree.
-- Pairs with the existing idx_captures_timeline (kept) which serves
-- the filter-by-app-then-recency path.
CREATE INDEX idx_captures_recency
  ON captures (captured_at DESC, id DESC)
  WHERE deleted_at IS NULL;
```

`captures-repo.ts` changes:
- `bumpAppStat(bundleId | null, delta)` — UPSERT keyed on
  `COALESCE(source_app_bundle_id, '')`. Encapsulated inside the repo
  module; not called from handlers.
- `insertOrFindCapture` rewrites to `INSERT … ON CONFLICT(sha256) DO
  NOTHING RETURNING *` and wraps insert + `bumpAppStat` in
  `db.transaction()`. Returns `{ record, isNew }` based on whether
  the RETURNING row was produced or the existing row was selected.
- `softDeleteCapture` runs `UPDATE captures SET deleted_at = …` +
  `bumpAppStat(bundleId, -1)` inside the same `db.transaction()`.
- `hardDeleteCapture` becomes defensive — reads the row's
  `(deleted_at, source_app_bundle_id)` first and decrements
  `app_stats` only when `deleted_at IS NULL` (i.e. the row was
  hard-deleted without prior soft-delete; the CASCADE GC sweep is
  unaffected).
- New `recomputeAppStats()` — single-statement reconciliation that
  recomputes the table from a `GROUP BY` over `captures`. Invoked
  (a) in dev on connection open after `PRAGMA optimize`, (b) from a
  hidden "Repair stats" tray menu in dev. Cheap (one indexed scan).

Invariant tests:
- **CI**: `SUM(app_stats.count) == COUNT(captures WHERE deleted_at IS
  NULL)` after every captures-mutation test (`afterEach`).
- **Dev runtime**: `db.ts` boot sanity check (gated on
  `import.meta.env.DEV`) — same query, throws on drift. Catches a
  bad code path on next boot instead of waiting for CI.

Migration test fixture matrix (Phase 3):
- (a) empty DB → `app_stats` empty; `idx_captures_recency` exists.
- (b) 1 row → backfill produces 1 row, `count=1`.
- (c) 100k rows (use seeder) → backfill <2s; `EXPLAIN QUERY PLAN` of
  the keyset query shows `SEARCH … USING INDEX idx_captures_recency`.
- (d) mixed-NULL bundle ids → NULL bucket has correct count; non-NULL
  buckets correct.
- (e) soft-deleted rows → excluded from backfill SUM and from the
  partial index (verify via EXPLAIN).

#### Library scale (R13, R14)

##### `library:list` keyset pagination (R14) + folded app counts

`exactOptionalPropertyTypes`-correct shape, with a named
`LibraryCursor` type for round-tripping the cursor through callers,
and `appStats` folded into the response (saves a separate
`library:appStats` round-trip per simplicity review):

```ts
// packages/shared/src/protocol.ts
export type LibraryCursor = { capturedAt: string; id: string };

export type LibraryAppStat = {
  bundleId: string | null;
  count: number;
};

"library:list": {
  req: {
    /** When omitted, returns the most recent page. */
    cursor?: LibraryCursor | undefined;
    limit?: number | undefined;       // hard cap 200, default 100
    appBundleId?: string | undefined;
    includeDeleted?: boolean | undefined;
  };
  res: {
    rows: CaptureRecord[];
    nextCursor: LibraryCursor | null;
    /** Returned only when cursor is undefined (head-page request).
     *  Keeps the sidebar count off the cold-load critical path
     *  while avoiding a second round-trip. */
    appStats?: LibraryAppStat[];
    /** Total live count for the virtualizer's `count` property. */
    totalLive?: number;
  };
}
```

Repo query (`captures-repo.ts`) — both columns DESC in the index, both
columns DESC in the ORDER BY (per data-integrity + perf review):

```sql
-- 0003_perf_app_stats.sql
CREATE INDEX idx_captures_recency
  ON captures (captured_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- query
SELECT *
FROM captures
WHERE deleted_at IS NULL
  AND (@cursor_at IS NULL OR (captured_at, id) < (@cursor_at, @cursor_id))
ORDER BY captured_at DESC, id DESC
LIMIT @limit
```

The tuple comparison form `(captured_at, id) < (?, ?)` is canonical
for SQLite ≥ 3.15 ([SQLite row values](https://sqlite.org/rowvalue.html))
and is optimized into a range scan against the composite index. The
Phase 5 EXPLAIN regression test gates this — if any profile shows
`SCAN` instead of `SEARCH … USING INDEX idx_captures_recency`, fall
back to the disjunctive form `captured_at < ? OR (captured_at = ? AND
id < ?)` and re-EXPLAIN.

Tie-breaker stability: the seeder's planner bumps duplicate
`capturedAt` values by +1 ms (see Distribution algorithm); the index's
secondary `id DESC` column then disambiguates any remaining edge
cases via random-but-deterministic nanoid order.

##### Virtualization (R13)

Decision: **TanStack Virtual** (`@tanstack/react-virtual`, currently
3.13.x — verify pin at implementation time). ~5 KB gz (revised from
the original "~7 KB" estimate per framework-docs research).

Rationale (deferred question resolved):
- Active maintenance through 2026, React 19 compatible.
- Native support for variable row sizes — needed for the day-grouped
  section headers ([Library.tsx](apps/desktop/src/renderer/src/features/library/Library.tsx)).
- Documented patterns for both sticky headers and infinite scroll.

Rejected alternatives:
- `react-window`: smaller (~6 KB) but `FixedSizeGrid` does not handle
  the day-grouped section-header layout. `react-window-infinite-loader`
  adds back complexity.
- Hand-rolled: `content-visibility: auto` already lifts paint cost;
  hand-rolled adds subtle bugs (scroll restoration on unmount, sticky
  headers, font-swap reflow). Net negative.

**Integration shape** (revised per perf + framework-docs review — the
original plan's `useWindowVirtualizer` would fight the existing nested
scroll container):

- Use `useVirtualizer({ getScrollElement: () => gridScrollRef.current })`
  pointed at `.psl__grid-wrap` (the existing nested scroll container in
  `Library.tsx`). Window virtualizer would fight `data-mode` toggling
  + the outer chrome layout.
- Flatten the day-grouped data into a 1-D row list of discriminated
  entries:

  ```ts
  type LibraryRow =
    | { kind: "header"; day: string; date: string }
    | { kind: "cells"; cells: CaptureRecord[] };
  ```

  Header rows and cell rows participate in the same virtualizer with
  per-index size estimates (`HEADER_PX` vs. `ROW_PX`).
- **Sticky day-headers require an explicit `rangeExtractor`** that
  always pins the active sticky index — known TanStack gotcha
  ([TanStack/virtual#640](https://github.com/TanStack/virtual/issues/640)).
  Without it, the active header disappears on scroll. Plan this in
  `Library.tsx`'s virtualizer config.
- `measureElement` for first-paint-correct heights; without it the
  scrollbar jumps as the user scrolls into unmeasured rows. Important
  for any future "jump to date" UX.
- Cell DOM count caps at `(visibleRows + overscan) × cellsPerRow` —
  typically ~30–60 cells regardless of dataset size.
- Infinite-scroll boundary: `useEffect` watches
  `getVirtualItems().slice(-1)[0]?.index >= rows.length - K` and
  triggers `loadMore()`. K is the prefetch threshold (e.g. 5 rows
  before edge).
- React 19 caveat: pass `useFlushSync: false` to opt into batched
  updates and silence `flushSync` warnings during scroll.

##### `useLibrary` hook update

`useLibrary` becomes a paginated store with snapshot
`{ rows, hasMore, loadMore, isLoadingMore, error, appStats, totalLive }`.

> **Breaking-change handling.** The current snapshot is
> `{ records, loading, error }` (per [`useLibrary.ts`](apps/desktop/src/renderer/src/lib/useLibrary.ts)).
> Per TypeScript review, list call sites in the same PR and rename
> `records → rows` everywhere. The Three-State View Model
> ([2026-05-05-001 plan](docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md))
> consumes `loading`; verify whether `isLoadingMore` is its successor
> or whether both are needed. `loadMore` must have stable function
> identity across renders — store it on the snapshot itself, not via
> `useCallback` (which doesn't survive `useSyncExternalStore`'s
> indirection).

Soft-delete event handling (per perf review): on
`events:captures:changed`, **merge** the change into the loaded
window instead of nuking the cursor and refetching page 1. Otherwise
a delete from row 50,000 teleports the user back to the top.

##### Sidebar counts (R15)

> **Removed:** the separate `library:appStats` command. Folded into
> `library:list` response (`appStats?: LibraryAppStat[]` field,
> populated only on head-page requests). Saves a round-trip on every
> Library open and removes one parity-test entry. Sidebar reads
> `appStats` from the same snapshot the grid binds to.

#### Measurement (R9, R10, R11, R12)

Output stream: `<dataRoot>/perf/seed-<profile>-<isoTs>.jsonl`. One JSON
object per line. Per TypeScript review, `MeasurementRow` is a
discriminated union — Phase 5 generates a results table from the
JSONL files, so the read path needs typed parsing with `assertNever`
exhaustiveness:

```ts
// runner.ts (folded from measurement.ts per simplicity review)
export type MeasurementRow =
  | { type: "profile_start"; profile: ProfileName; rows: number; ts: string }
  | { type: "insert_bucket"; at_n: number; p50: number; p95: number; p99: number; wallMs: number }
  | { type: "db_size"; fileBytes: number; pageCount: number; pageSize: number }
  | { type: "db_index"; name: string; bytes: number; rows: number }
  | { type: "explain"; query: string; plan: readonly string[] }
  | { type: "cold_load"; run: number; openMs: number; firstPaintMs: number; mode: "reload" | "recreate" }
  | { type: "scroll"; durationMs: number; frames: number; droppedPct: number; p95FrameMs: number }
  | { type: "scroll_error"; error: "timeout" }
  | { type: "error"; message: string }
  | { type: "profile_end"; totalMs: number };
```

Per perf review, replace the original reservoir-sampling estimator
with **sort-and-pick**: per-bucket sample sizes are bounded
(largest jump 50k → 100k = 50k samples × 8 bytes = 400 KB),
`Array.prototype.sort` is sub-50 ms even on the slowest target
hardware. Reservoir sampling is overengineering for an offline dev
tool.

Sample row stream:

```jsonl
{"type":"profile_start","profile":"10k","rows":10000,"ts":"…"}
{"type":"insert_bucket","at_n":100,"p50":0.42,"p95":0.78,"p99":1.4,"wallMs":50.1}
{"type":"insert_bucket","at_n":500,"p50":0.46,"p95":0.81,"p99":1.6,"wallMs":250.4}
…
{"type":"db_size","fileBytes":3145728,"pageCount":768,"pageSize":4096}
{"type":"db_index","name":"idx_captures_recency","bytes":423456,"rows":10000}
{"type":"explain","query":"library:list@head","plan":["SEARCH captures USING INDEX idx_captures_recency …"]}
{"type":"cold_load","run":1,"openMs":12.4,"firstPaintMs":83.1}
{"type":"scroll","durationMs":5000,"frames":283,"droppedPct":0.011,"p95FrameMs":17.2}
{"type":"profile_end","totalMs":18421}
```

##### Cold-load instrumentation (R10) — primary probe revised

Per perf review, the original "close + recreate window N times" probe
mostly measures `BrowserWindow` construction overhead (NSWindow alloc,
NSView tree, GPU surface, IPC bridge boot — 100–400 ms per recreate)
instead of the data-load path. Two probes:

1. **Reload probe (primary).** Keep the Library window mounted; send
   an `events:perf:reload` IPC; renderer drops its `useLibrary`
   snapshot and re-runs the head fetch. Measures the data-relevant
   cold path (DB query + IPC + first paint) without window-construction
   noise.
2. **Recreate probe (baseline only).** Close + recreate the window
   once per profile to capture the worst-case "cold-start" number.
   Logged separately (`mode: "recreate"`).

Renderer side ([`Library.tsx`](apps/desktop/src/renderer/src/features/library/Library.tsx)):

```tsx
const firstRowsCommitted = useRef(false);
useLayoutEffect(() => {
  if (firstRowsCommitted.current || rows.length === 0) return;
  firstRowsCommitted.current = true;
  window.pwrsnap.perfMark("library:firstPaint", {
    rowsRendered: rows.length,
    timeOriginMs: performance.timeOrigin,  // for cross-process clock skew
  });
}, [rows.length]);
```

`EVENT_CHANNELS.perfMark = "events:perf:mark"` is the renderer→main
signal channel. Add typed payload:

```ts
export type PerfMarkPayload =
  | { kind: "library:firstPaint"; rowsRendered: number; timeOriginMs: number };
```

##### Scroll probe (R12) — channel pair → bus command

Per simplicity review, collapse the original
`events:perf:scrollProbe:begin` + `:end` channel pair into a single
bus command (request/response is the bus's natural shape):

```ts
"perf:scrollProbe": {
  req: { durationMs: number; pxPerFrame: number };
  res: { frames: number; droppedPct: number; p95FrameMs: number };
}
```

The renderer registers the handler. Inside it:
1. Programmatically scrolls the virtualizer viewport at fixed velocity
   via `Element.scrollTo` for `durationMs`.
2. RAF callback computes `delta = now - lastFrame`. Counts frames where
   `delta > 1.5 × (1000 / 60)` as dropped.
3. Returns `{ frames, droppedPct, p95FrameMs }` via the bus's normal
   Result envelope.

> **Removed:** `--seed-trace` flag and the `app.contentTracing` plumbing.
> Per simplicity review (and the plan's own risk-table acknowledgement
> that tracing is "not friendly to non-developers"): the RAF-based
> probe is the primary metric, and `app.contentTracing.startRecording`
> is ~5 lines if it's needed for one-off diagnosis later. Don't ship a
> permanent flag for a maybe-future need.

##### `dbstat` + EXPLAIN (R11) — open question resolved

`dbstat` virtual table is on by default in `better-sqlite3`'s pinned
SQLite build (verified by `PRAGMA compile_options;` at first connection).
Fallback: emit only file size + page count if absent.

EXPLAIN is run for the four canonical Library queries:
- `library:list` head (no cursor, no app filter)
- `library:list` page (with cursor)
- `library:list` filtered by app
- `library:appStats` SELECT

### Implementation Phases

#### Phase 1: Foundation

Tasks:
- [ ] Create [`apps/desktop/src/main/persistence/paths.ts`](apps/desktop/src/main/persistence/paths.ts)
      with `getDataRoot()`, `isOverriddenDataRoot()`, `SEEDER_SENTINEL`,
      `assertSameVolume()`, and the four root accessors (`getDbPath` /
      `getCapturesRoot` / `getCacheRoot` / `getTrashRoot`) plus
      `getPerfRoot`. Skip `getDocumentsExportRoot()` — added when the
      forward-stream actually needs it.
- [ ] Sweep `app.getPath("userData")` call sites in
      [`db.ts`](apps/desktop/src/main/persistence/db.ts) **and** all
      consumers (notably [`source-store.ts`](apps/desktop/src/main/persistence/source-store.ts))
      to import directly from `paths.ts`. Delete the corresponding
      exports from `db.ts` — no deprecation shim.
- [ ] Add `apps/desktop/src/main/vite-env.d.ts` with
      `/// <reference types="electron-vite/node" />` so
      `import.meta.env.DEV` typechecks in main.
- [ ] Add ESLint rule banning `app.getPath("userData")` outside
      `paths.ts` and banning raw SQL against `captures` outside
      `captures-repo.ts`.
- [ ] Add `PRAGMA optimize=0x10002` at every connection open in
      [`db.ts`](apps/desktop/src/main/persistence/db.ts) (after the
      existing pragma block) and `PRAGMA optimize` in `app.before-quit`
      shutdown — SQLite team's recommendation as of 3.46. Highest-
      leverage perf addition before measurement.
- [ ] Add a dev-only invariant self-check to `db.ts` boot (gated on
      `import.meta.env.DEV`): `SELECT (SELECT COALESCE(SUM(count), 0)
      FROM app_stats) - (SELECT COUNT(*) FROM captures WHERE deleted_at
      IS NULL)` — throw if non-zero. Catches drift on next boot.
- [ ] Add `capture:ingest` to [`packages/shared/src/protocol.ts`](packages/shared/src/protocol.ts)
      with `exactOptionalPropertyTypes`-correct shape; define
      `LibraryCursor` and `LibraryAppStat` types here too. Add
      `EVENT_CHANNELS.perfMark = "events:perf:mark"` to
      [`packages/shared/src/ipc.ts`](packages/shared/src/ipc.ts) with
      typed `PerfMarkPayload` discriminated union.
- [ ] Add `"seeder"` to `CommandPrincipal` so seeder dispatches are
      distinguishable in any future audit log.
- [ ] Factor `broadcastCapturesChanged` out of
      [`capture-handlers.ts:43`](apps/desktop/src/main/handlers/capture-handlers.ts:43)
      into a new `apps/desktop/src/main/events.ts` so the seeder runner
      can install a no-op listener.
- [ ] Parameterize [`source-store.ts`](apps/desktop/src/main/persistence/source-store.ts):
      `putCaptureSource(tempPath, opts?: { capturedAt?: string })` —
      single function, no sibling. The existing zero-arg call sites
      stay unchanged.
- [ ] Register `capture:ingest` handler in
      [`capture-handlers.ts`](apps/desktop/src/main/handlers/capture-handlers.ts),
      gated on `import.meta.env.DEV` (until a real consumer lands).
- [ ] Wire build-time-conditional dev-seeder import in
      [`main/index.ts`](apps/desktop/src/main/index.ts) with the
      defense-in-depth `import.meta.env.DEV && process.env.NODE_ENV !==
      "production"` gate; empty `dev/seeder/index.ts` placeholder.
- [ ] Tests:
  - [ ] `paths.test.ts` — env override, default, `isOverriddenDataRoot`,
        `assertSameVolume` happy path.
  - [ ] `capture-ingest.test.ts` — round-trip via the bus, dedup on
        repeated sha256 (assert `isNew === false`), DEV-gated
        registration absent in non-DEV main.
  - [ ] Build-artifact grep: `grep -r "registerDevSeeder\|dev/seeder" out/`
        → zero matches in production build.
  - [ ] Bundle-size diff: `out/main/index.js` size diff vs. baseline
        within tolerance.

Success criteria:
- `PWRSNAP_DATA_ROOT=/tmp/pwrsnap-test pnpm dev` puts pwrsnap.db,
  captures/, render-cache/, .trash/ all under `/tmp/pwrsnap-test`.
- `bus.dispatch("capture:ingest", { … })` produces a row identical in
  shape to one produced by the live capture pipeline.

Estimated effort: ~1 day.

#### Phase 2: Seeder core

Tasks:
- [ ] [`profiles.ts`](apps/desktop/src/main/dev/seeder/profiles.ts) —
      profile catalog as defined above plus `generateBundleIdCatalog(100)`.
- [ ] [`distribution.ts`](apps/desktop/src/main/dev/seeder/distribution.ts) —
      mulberry32 PRNG, FNV-1a seed hashing, day-spread sampler, Zipf
      bundle sampler, `planRows()` orchestration.
- [ ] [`png-gen.ts`](apps/desktop/src/main/dev/seeder/png-gen.ts) —
      sharp pipeline composing 64×64 PNG with bundle hue + index region;
      `writeTempPng(row)` helper.
- [ ] [`runner.ts`](apps/desktop/src/main/dev/seeder/runner.ts) —
      orchestration loop, bucket-boundary callbacks, broadcast
      throttling.
- [ ] [`wipe.ts`](apps/desktop/src/main/dev/seeder/wipe.ts) — sentinel
      + banned-path checks; `createSentinel()` helper.
- [ ] [`measurement.ts`](apps/desktop/src/main/dev/seeder/measurement.ts) —
      JSONL writer, latency histogram per bucket, p50/p95/p99 from a
      lightweight quantile estimator (reservoir sampling — exact
      quantiles would be O(n log n) per bucket).
- [ ] [`index.ts`](apps/desktop/src/main/dev/seeder/index.ts) —
      `registerDevSeeder()` adds tray menu items via `tray.ts`'s
      `registerExtraMenuItems` seam.
- [ ] CLI flag handling (`--seed=<profile>`, `--seed-wipe`, `--seed-trace`)
      in [`main/index.ts`](apps/desktop/src/main/index.ts).
- [ ] Tests:
  - [ ] `distribution.test.ts` — determinism (same seed → same plan),
        Zipf properties (top 10 carry ~60% mass at zipfS=1.0), day-cap
        respected.
  - [ ] `wipe.test.ts` — refuses without sentinel, refuses on
        `process.env.HOME`, refuses when env unset, accepts when all
        guards pass.
  - [ ] `runner.test.ts` — happy path on `100` profile end-to-end:
        seed, query DB, assert row count + temporal order + bundle
        distribution shape.

Success criteria:
- `PWRSNAP_DATA_ROOT=/Volumes/Dev/pwrsnap-perf/100 pnpm dev -- --seed=100`
  produces a fully-populated DB in <2 s with a JSONL file showing
  per-bucket latency.
- Re-running the same profile produces a bit-identical DB
  (modulo `id` nanoids, but same `(captured_at, sha256, bundleId)`
  tuples).
- Production build excludes the seeder (verified via grep).

Estimated effort: ~2 days.

#### Phase 3: DB schema improvements

Tasks:
- [ ] Migration [`0003_perf_app_stats.sql`](apps/desktop/src/main/persistence/migrations/0003_perf_app_stats.sql) —
      `app_stats` table (nullable `source_app_bundle_id`, `CHECK (count
      >= 0)`, partial unique index on `COALESCE(bundle_id, '')`),
      backfill, and `idx_captures_recency (captured_at DESC, id DESC)
      WHERE deleted_at IS NULL`. Bare `CREATE TABLE` (no `IF NOT
      EXISTS`) — the runner's transactional retry semantics make
      guards redundant; matches the 0001/0002 pattern.
- [ ] `captures-repo.ts` rewrites:
  - [ ] `bumpAppStat(bundleId, delta)` — UPSERT keyed on
        `COALESCE(bundle_id, '')`. Module-private; called only from
        within other repo functions.
  - [ ] `insertOrFindCapture` uses `INSERT … ON CONFLICT(sha256) DO
        NOTHING RETURNING *`; wraps insert + `bumpAppStat(+1)` in a
        single `db.transaction()`. Returns `{ record, isNew }`
        derived from whether RETURNING produced a row.
  - [ ] `softDeleteCapture` wraps `UPDATE … SET deleted_at` +
        `bumpAppStat(-1)` in `db.transaction()`.
  - [ ] `hardDeleteCapture` becomes defensive: reads
        `(deleted_at, source_app_bundle_id)` first; decrements
        `app_stats` only if `deleted_at IS NULL`.
  - [ ] `listCaptures` rewritten for keyset pagination
        `(cursor, limit) → { rows, nextCursor }`.
  - [ ] `getAppStats()` returns the denormalized counts.
  - [ ] `getTotalLive()` returns
        `SELECT COALESCE(SUM(count), 0) FROM app_stats` (no `COUNT(*)`).
  - [ ] `recomputeAppStats()` — single-statement reconciliation
        (`INSERT INTO app_stats SELECT … GROUP BY … ON CONFLICT DO
        UPDATE`). Called from a hidden dev "Repair stats" tray entry
        and from the dev-only boot self-check on drift.
- [ ] `library:list` handler in [`library-handlers.ts`](apps/desktop/src/main/handlers/library-handlers.ts)
      returns `{ rows, nextCursor, appStats?, totalLive? }` (last two
      populated only on head-page requests). No separate
      `library:appStats` command.
- [ ] Tests (per migration-safety review's fixture matrix):
  - [ ] **(a)** Empty DB → backfill empty; `idx_captures_recency`
        present in `sqlite_master`.
  - [ ] **(b)** 1 row → backfill produces 1 row, `count=1`.
  - [ ] **(c)** 100k rows seeded → backfill <2s; `EXPLAIN QUERY PLAN`
        of unfiltered keyset query shows `SEARCH … USING INDEX
        idx_captures_recency`.
  - [ ] **(d)** Mixed-NULL bundle ids → NULL bucket has correct count;
        non-NULL buckets correct.
  - [ ] **(e)** Soft-deleted rows → excluded from backfill SUM and
        from the partial index.
  - [ ] CI invariant `afterEach` mutation test:
        `SUM(app_stats.count) == COUNT(captures WHERE deleted_at IS NULL)`.
  - [ ] Keyset pagination walk: full ladder, no duplicates, no gaps,
        monotonic cursor across pages with identical timestamps.
  - [ ] `recomputeAppStats()` smoke: drift the table by hand
        (`UPDATE app_stats SET count = count + 1`), call recompute,
        assert invariant restored.

Success criteria:
- `EXPLAIN QUERY PLAN` for unfiltered `library:list` reports `SEARCH
  captures USING INDEX idx_captures_recency`.
- `app_stats` matches GROUP BY count after every seeder profile run.

Estimated effort: ~1.5 days.

#### Phase 4: Library scale fixes

Tasks:
- [ ] Add `@tanstack/react-virtual` to [`apps/desktop/package.json`](apps/desktop/package.json).
      Pin version. ~7 KB gz.
- [ ] Rewrite [`Library.tsx`](apps/desktop/src/renderer/src/features/library/Library.tsx)
      around `useWindowVirtualizer`. Day-section headers participate
      in the virtualization (variable row size). Cell DOM caps at
      `(visibleRows + overscan) × cellsPerRow`.
- [ ] Update [`useLibrary.ts`](apps/desktop/src/renderer/src/lib/useLibrary.ts)
      for keyset pagination. Snapshot exposes
      `{ rows, hasMore, loadMore, isLoadingMore, error }`.
- [ ] Bind sidebar to `library:appStats`. New `useAppStats` hook with
      same `useSyncExternalStore` shape.
- [ ] Drop the `limit: 500` ceiling. Remove the comment in [`Thumb.tsx`](apps/desktop/src/renderer/src/features/library/Thumb.tsx)
      that references "sufficient through ~1000 captures without a
      virtualization library" — now obsolete.
- [ ] Tests:
  - [ ] Renderer test: at 100k mocked rows, total DOM cell count stays
        under 200.
  - [ ] Pagination test: scrolling triggers `loadMore` exactly when
        the bottom of the loaded window enters the overscan band.
  - [ ] Visual: existing day-grouping continues to render correctly
        across page boundaries.

Success criteria:
- Library opens with `stress100k` seeded and renders within visual
  parity of the empty state.
- Sidebar shows accurate counts without a `COUNT(*)` query (verified
  via SQLite query log).

Estimated effort: ~2 days.

#### Phase 5: Measurement + acceptance

Tasks:
- [ ] Renderer perf marks (`library:firstPaint`) wired in `Library.tsx`.
- [ ] `runColdLoadProbes(measurement, N=5)` in `runner.ts` — close /
      recreate library window, time from create to first paint.
- [ ] `runScrollProbes(measurement)` — programmatic scroll over the
      virtualizer; RAF-based dropped-frame counter; round-trip via
      `events:perf:scrollProbe:*`.
- [ ] `captureSchemaSnapshot(measurement)` — `dbstat` + per-index
      sizes + EXPLAIN QUERY PLAN for the four canonical queries.
- [ ] `--seed-trace` flag enables `app.contentTracing` for the run.
- [ ] Run all profiles end-to-end on `/Volumes/Dev/pwrsnap-perf/<profile>/`.
      Generate a results table from the JSONL files.
- [ ] Walk the ladder; investigate any super-linear segment.
- [ ] Document findings in a follow-up `docs/solutions/2026-MM-DD-pwrsnap-library-scale-findings.md`
      (one-shot, not part of the canonical seeder output).
- [ ] Tests:
  - [ ] Smoke: cold-load probe records a `cold_load` row in JSONL.
  - [ ] Smoke: scroll probe records a `scroll` row with non-zero
        frame count.

Success criteria:
- Per-batch insert latency, cold-load p50, and scroll dropped-frame %
  are flat or sublinear from `100` → `stress100k`.
- Any super-linear segment is investigated and either flattened or
  explicitly accepted with rationale before the work is closed.

Estimated effort: ~1.5 days (plus investigation budget for whatever
the measurement turns up).

## Alternative Approaches Considered

**Pull Phase 7 HTTP RPC forward.** Rejected. The brainstorm explicitly
chose in-process command-bus dispatch (see origin: "Key Decisions"). The
HTTP RPC server is a meaningful project (HMAC URL signing, DNS-rebind
defense, port pinning) that doesn't earn its keep just for seeding.

**Triggers for `app_stats` denormalization.** Rejected. SQLite triggers
work but are easy to miss when reasoning about a code path; with
soft-delete + the existing CASCADE on `render_cache`, the trigger
conditions get fiddly. Inline `bumpAppStat` calls in three repo
functions are simpler and easier to test.

**In-memory cache for `app_stats`.** Rejected. The simplest path that
satisfies the brainstorm requirement ("Library never issues `COUNT(*)`
on the load path") still required one cold-load `COUNT GROUP BY`. At
100k that's measurable. The denormalized table is closer to the
brainstorm's framing and survives restarts.

**`react-window` for virtualization.** Rejected. `FixedSizeGrid` does
not support the day-grouped section-header layout; `VariableSizeGrid`
does but the API for "row of N cells with periodic full-width headers"
becomes hand-rolled anyway.

**1×1 PNG with index in tEXt chunk.** Rejected at brainstorm time
(see origin: PNG strategy decision); 1×1 inputs degenerate the render
cache pipeline (240w.webp etc.) and break grid layout measurement.

**Hardlink within `(app, day)` bucket (R5).** Obsoleted by analysis
during planning: contradicts R4 because identical bytes → identical
sha256 → `insertOrFindCapture` dedup. At ≤250 bytes/PNG, the disk-cost
problem R5 was solving doesn't exist.

## System-Wide Impact

### Interaction Graph

`capture:ingest` dispatch:
1. `bus.dispatch("capture:ingest", req)` →
2. `putCaptureSourceWithCapturedAt(tempPath, capturedAt)` writes under
   `<dataRoot>/captures/<yyyy>/<mm>/<id>.png`, hashes via SHA-256,
   reads dimensions via `sharp.metadata()`. →
3. `insertOrFindCapture(...)` runs `INSERT … VALUES …` against
   `captures`; `sha256 UNIQUE` constraint dedups silently if the row
   already exists. →
4. `bumpAppStat(sourceAppBundleId, +1)` UPSERTS `app_stats`. →
5. If `!suppressBroadcast`: every `BrowserWindow` receives
   `events:captures:changed`. →
6. Each renderer that listens (`useLibrary`, the future float-over):
   invalidates its cursor, refetches first page, re-renders the
   virtualized grid (DOM cell count bounded).

`library:list` (paginated):
1. Renderer's `useLibrary` calls `bus.dispatch("library:list", { cursor, limit })`. →
2. Repo executes index-driven keyset query against `idx_captures_recency`. →
3. Snapshot updates in renderer; TanStack Virtual recomputes overscan
   if the new tail crossed the bottom of the loaded window.

### Error & Failure Propagation

- Bus `dispatch` already returns `Result<Res, PwrSnapError>` — the
  result-pattern strips `Error.instanceof` across IPC. Seeder treats
  `result.ok === false` as a fatal stop with a JSONL `{type:"error",
  …}` row preceding `profile_end`.
- `putCaptureSource` throws on PNG dim read failure; seeder propagates
  as `PwrSnapError { kind: "validation" }`.
- Migration failure during `runMigrations` (e.g. `0003_perf.sql`) is
  caught by the existing transaction wrapper in
  [`db.ts`](apps/desktop/src/main/persistence/db.ts); seeder fails fast.
- Wipe path failures (sentinel missing, banned path) throw before any
  destructive operation runs.
- `events:perf:scrollProbe:end` not received within 30s of begin →
  seeder writes `{type:"scroll",error:"timeout"}` and continues.

### State Lifecycle Risks

- **Half-seeded DB on crash mid-run.** Each `capture:ingest` is
  transactional (insert + bumpAppStat in one statement bundle). A
  crash mid-profile leaves a consistent partial state. The next run
  wipes before reseeding — sentinel guard ensures we only wipe the
  data root that the seeder owns.
- **Dangling temp PNGs.** `writeTempPng` writes to `<dataRoot>/perf/tmp/`;
  cleaned in a `finally` per row. Crash leaves stale temps; next wipe
  clears them.
- **`app_stats` drift.** Mitigated by the CI invariant test
  (sum = COUNT). Add it to the lifecycle test in
  [`apps/desktop/src/main/__tests__/`](apps/desktop/src/main/__tests__/).
- **`pwrsnap-cache://` cache pollution under perf root.** The render
  cache also reroots — wipe takes it out with the rest of the tree.

### API Surface Parity

The agent-native parity invariant (`pnpm test:parity`, see plan §
"Phase 7" of the canonical buildout plan) requires every UI command-
bus call to have a registered handler reachable from every transport.
- `capture:ingest` is registered in `capture-handlers.ts`; the parity
  test sees it as soon as it's added.
- `library:appStats` likewise.
- The dev-seeder CLI flag is **not** a transport — it's an in-process
  caller. No parity implications.

### Integration Test Scenarios

1. **Seed-then-load flow.** Seed `2k` profile, open the Library
   window, scroll from top to bottom. Assert: total `library:list`
   dispatch count is `ceil(2000/100) + 1`, no `COUNT(*)` in the
   SQLite query log, DOM cell count never exceeds the cap.
2. **Soft-delete during seed.** While `10k` profile is mid-run,
   programmatically `library:delete` the most recent capture. Assert:
   `app_stats` decrements correctly; subsequent inserts continue;
   final SUM invariant holds.
3. **Production build exclusion.** `pnpm --filter desktop build`,
   then `grep -r "registerDevSeeder\|dev/seeder" out/`. Expect zero
   matches.
4. **Re-root + wipe + re-seed.** With `PWRSNAP_DATA_ROOT=/Volumes/Dev/pwrsnap-perf/test`
   set, run `--seed=100`, verify userData is untouched
   (compare mtimes of files under userData before and after).
5. **EXPLAIN regression.** Seed each profile in sequence, capture
   EXPLAIN QUERY PLAN for `library:list@head`. Assert every plan uses
   `idx_captures_recency` and the access pattern remains `SEARCH …
   USING INDEX` (not `SCAN TABLE`).

## Acceptance Criteria

### Functional Requirements

- [ ] `PWRSNAP_DATA_ROOT` env var, when set, reroots DB, captures
      source store, render cache, trash directory, and the new
      `perf/` directory. Default behavior (env unset) is unchanged.
- [ ] `capture:ingest` command exists on the bus and is reachable
      from any transport. Round-trip from a temp PNG produces a
      `CaptureRecord` indistinguishable in shape from one created
      by `capture:region`.
- [ ] Seeder catalog: `100`, `1k`, `2k`, `10k`, `20k`, `stress100k`.
      `stress100k` requires explicit flag.
- [ ] Tray menu items appear in dev builds, not in production
      (verified by build-output grep).
- [ ] CLI flag `--seed=<profile>` runs and exits.
- [ ] Wipe refuses without sentinel; sentinel is created on first
      non-wipe seed run; sentinel never appears under user `userData`.
- [ ] `0003_perf.sql` migration is idempotent and includes backfill;
      migration test passes against a pre-populated DB.
- [ ] `library:list` accepts a cursor; old un-cursored shape is
      replaced. (Schema change, no compat shim.)
- [ ] Library renders virtualized; cell DOM count bounded.
- [ ] Sidebar reads counts from `app_stats`.

### Non-Functional Requirements

- [ ] Per-batch insert latency p50, p95, p99, and total wall-time are
      flat or sublinear across the ladder `100 → 1k → 2k → 10k → 20k
      → 100k`. Any super-linear segment is documented.
- [ ] Library cold-load p50 (open-to-first-paint) is flat / sublinear
      across the ladder.
- [ ] Scroll dropped-frame % is flat / sublinear across the ladder.
- [ ] DB file size scales linearly with row count (no pathological
      index growth at 100k).
- [ ] Production bundle does not include any code from
      `apps/desktop/src/main/dev/seeder/`.

### Quality Gates

- [ ] All Phase 1–4 tests pass (`pnpm test`).
- [ ] `pnpm test:parity` continues to pass (every dispatch-call has a
      registered handler reachable from every transport).
- [ ] `app_stats` invariant test passes.
- [ ] EXPLAIN regression test passes.
- [ ] Dev tray menu does not appear in production build.

## Success Metrics

- **Curve flatness.** Plot per-batch p50 insert latency, cold-load
  p50, and scroll dropped-frame % at `100`, `1k`, `2k`, `10k`, `20k`,
  `100k`. Each curve must be visually flat or sublinear.
- **DOM economy.** At `stress100k`, total Library cell DOM count
  stays under 250 regardless of scroll position (the visible-window
  + overscan cap).
- **Insert throughput stability.** Mean rows-per-second within ±25%
  across the ladder. Significant slowdown at higher counts indicates
  either index growth, page-fault pressure, or a quadratic somewhere
  — investigate.

## Dependencies & Prerequisites

- `sharp` (existing dep) — used by the PNG generator.
- `@tanstack/react-virtual` — new dep, pin version, ~7 KB gz.
- `better-sqlite3` `dbstat` virtual table — verified at first
  connection; fallback to file-size-only if absent.
- An external volume (e.g. `/Volumes/Dev`) with enough free space for
  the largest profile. The seeder fails fast with a clear message if
  the configured `PWRSNAP_DATA_ROOT` is unset, missing, or unwritable.
- Forward-looking: a separate stream of work intends to put PwrSnap
  data under `~/Documents`. R1 must continue to cover that path —
  every persistent surface should route through `getDataRoot()`.

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `app.getPath` call slips into a new file, bypassing rerooting | Wipe deletes user data, or seed leaks into real Library | ESLint rule banning `app.getPath("userData")` outside `paths.ts` (custom rule, simple regex) |
| `app_stats` drifts from captures | Sidebar counts wrong | CI invariant test on every mutation test; fail loud |
| TanStack Virtual API churn | Forced upgrade in 6 months | Pin major version, keep adapter thin (single `Library.tsx` integration point) |
| `chrome://tracing` not friendly to non-developers | Diagnosis tool not used | RAF-based scroll probe is the primary metric; tracing is `--seed-trace` opt-in |
| Production build accidentally ships the seeder | Hidden code in shipped binary | Build-output grep in CI; `import.meta.env.DEV` is statically tree-shaken; visual check of bundle size |
| Profile RNG seeds change | Re-running an old profile is no longer bit-identical | Seeds live in `profiles.ts` and are versioned with the file; treat as part of the public-ish surface for the seeder |
| `dbstat` not compiled in pinned `better-sqlite3` | Schema snapshot is partial | Detect via `PRAGMA compile_options`; fall back to file-size + page-count only |

## Resource Requirements

- Single engineer; ~8 working days end-to-end across the five phases.
- External SSD (the user's `/Volumes/Dev`) for perf runs. Seeder will
  not run against the default `userData`.
- Disk: `stress100k` ≈ 50–80 MB on disk (~250 byte PNGs × 100k
  + DB + index + cache + JSONL).

## Future Considerations

- **Phase 7 HTTP RPC.** When it lands, an external CLI seeder over
  HTTP becomes possible — most of `runner.ts` ports verbatim;
  `bus.dispatch` becomes an HTTP fetch. Today's design does not
  block that move.
- **Tags table** (deferred from the canonical buildout plan). When
  `tags` and `capture_tags` land, the seeder gains a follow-up
  brainstorm to extend the distribution model with a tag dimension.
  The 100-bundle-id distribution shape is the obvious starting point.
- **CI perf budget.** Once curves are characterized, layer numeric
  budgets on top: for example, `20k cold-load p50 ≤ 1s in dev`. Today
  the gate is curve shape; numbers can come later.
- **`getDocumentsExportRoot()` placeholder.** Forward-stream "Documents"
  work owns the final design; today's `paths.ts` exposes a
  placeholder so future code routes through the same primitive.

## Documentation Plan

- `docs/solutions/2026-MM-DD-pwrsnap-library-scale-findings.md` — one-
  shot post-implementation note: what the curves looked like, what
  surprises emerged, what was investigated.
- Update [`AGENTS.md`](AGENTS.md) to add a note about
  `PWRSNAP_DATA_ROOT` and the wipe sentinel so future contributors
  don't accidentally break the safety contract.
- No new top-level doc otherwise — the seeder is dev-only tooling and
  lives next to its code.

## Sources & References

### Origin

- **Origin document:**
  [docs/brainstorms/2026-05-07-perf-seeder-and-library-scale-requirements.md](docs/brainstorms/2026-05-07-perf-seeder-and-library-scale-requirements.md)
  Key decisions carried forward:
  - Tag concept = `source_app_bundle_id` (no new tags table).
  - Insert path = command-bus dispatch in-process (no Phase 7 HTTP RPC).
  - Success bar = direction over numbers (flat / sublinear curve).
  - Data isolation = `PWRSNAP_DATA_ROOT` env var rerooting every
    persistent surface (current and future, including a planned
    Documents-backed addition).
  - Profile ladder includes inflection points (`2k`, `20k`) plus a
    flagged `stress100k`.
  - PNG strategy = color-banded by app, vary small index region per row.

### Internal References

- [apps/desktop/src/main/persistence/db.ts](apps/desktop/src/main/persistence/db.ts) —
  current data-root call sites (`app.getPath("userData")`).
- [apps/desktop/src/main/persistence/source-store.ts](apps/desktop/src/main/persistence/source-store.ts) —
  PNG persistence + sha256 hashing pattern.
- [apps/desktop/src/main/persistence/captures-repo.ts](apps/desktop/src/main/persistence/captures-repo.ts) —
  `insertOrFindCapture`, dedup-by-sha256.
- [apps/desktop/src/main/persistence/migrations/0001_init.sql](apps/desktop/src/main/persistence/migrations/0001_init.sql) —
  current `idx_captures_timeline` partial index.
- [apps/desktop/src/main/handlers/capture-handlers.ts](apps/desktop/src/main/handlers/capture-handlers.ts) —
  shape for adding `capture:ingest`.
- [apps/desktop/src/renderer/src/lib/useLibrary.ts](apps/desktop/src/renderer/src/lib/useLibrary.ts) —
  current `library:list { limit: 500 }` call site.
- [apps/desktop/src/renderer/src/features/library/Library.tsx](apps/desktop/src/renderer/src/features/library/Library.tsx) —
  cell-per-row DOM, target of virtualization.
- [packages/shared/src/protocol.ts](packages/shared/src/protocol.ts) —
  command registry, target of `capture:ingest` and the cursored
  `library:list`.
- [packages/shared/src/ipc.ts](packages/shared/src/ipc.ts) —
  `EVENT_CHANNELS` map, target of new perf channels.
- [docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md](docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md) —
  canonical buildout plan; pricing in this perf work alongside its
  Phase 1–7 ordering.
- [AGENTS.md](AGENTS.md) — channel-naming convention, Result-pattern,
  agent-native parity rules.

### External References

#### Virtualization
- [TanStack Virtual — docs](https://tanstack.com/virtual/latest)
- [TanStack Virtual — sticky example](https://tanstack.com/virtual/v3/docs/framework/react/examples/sticky)
- [TanStack Virtual — infinite-scroll example](https://tanstack.com/virtual/latest/docs/framework/react/examples/infinite-scroll)
- [TanStack Virtual issue #640 — sticky header rangeExtractor](https://github.com/TanStack/virtual/issues/640)

#### SQLite + better-sqlite3
- [SQLite `PRAGMA optimize`](https://www.sqlite.org/pragma.html#pragma_optimize) — recommended at every connection open since 3.46
- [SQLite Partial Indexes](https://www.sqlite.org/partialindex.html) — predicate-string-must-match-literally rule
- [SQLite Row Values](https://sqlite.org/rowvalue.html) — tuple comparison form `(a,b) < (?,?)` as range scan
- [SQLite EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html)
- [SQLite `dbstat` virtual table](https://www.sqlite.org/dbstat.html)
- [SQLite `lang_analyze`](https://sqlite.org/lang_analyze.html) — guidance to prefer `PRAGMA optimize` over raw `ANALYZE`
- [`better-sqlite3` README](https://github.com/WiseLibs/better-sqlite3)
- [`better-sqlite3` compilation flags](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md) — confirms `dbstat` in prebuilds
- [phiresky — SQLite tuning](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/)
- [Clément Joly — SQLite pragma cheatsheet](https://cj.rs/blog/sqlite-pragma-cheatsheet-for-performance-and-consistency/)

#### Electron + electron-vite
- [electron-vite — Env Variables and Modes](https://electron-vite.org/guide/env-and-mode) — `import.meta.env.DEV` static substitution
- [Electron `contentTracing`](https://www.electronjs.org/docs/latest/api/content-tracing) — used only if a `--seed-trace` follow-up is added
- [Palette — Improving Electron app perf](https://palette.dev/blog/improving-performance-of-electron-apps) — first-paint via renderer perf marks
- [NearForm — Architecting for 60fps](https://www.nearform.com/blog/architecting-electron-applications-for-60fps/) — RAF-based dropped-frame counter pattern

#### Image generation
- [Sharp — composite API](https://sharp.pixelplumbing.com/api-composite/)
- [Sharp — constructor (create)](https://sharp.pixelplumbing.com/api-constructor)

#### Distribution / RNG
- [Apache Commons Math — Zipf rejection-inversion sampler](https://commons.apache.org/proper/commons-math/javadocs/api-3.6.1/org/apache/commons/math3/distribution/ZipfDistribution.html)
- [Heavy-tailed distributions overview](https://medium.com/@ozsp12/exploring-heavy-tailed-distributions-pareto-gompertz-lognormal-and-normal-50b80fb05861) — Zipf is asymptotic; lognormal more empirical (acknowledged caveat in `profiles.ts`)

#### Filesystem
- [Apple APFS hard links + clones summary](https://eclecticlight.co/2023/04/28/apfs-hard-links-symlinks-aliases-and-clone-files-a-summary/)
- [Node `fs.linkSync`](https://nodejs.org/api/fs.html#fslinksyncexistingpath-newpath)

### Related Work

- `docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md` —
  recently-landed Library reducer; the virtualization rewrite must
  preserve the three-state view-model contract.
- `docs/plans/2026-05-04-001-fix-capture-flow-window-choreography-plan.md` —
  capture pipeline reference for `capture:ingest` chain shape.
