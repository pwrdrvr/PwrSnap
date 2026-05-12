---
date: 2026-05-07
topic: perf-seeder-and-library-scale
---

# Perf Seeder + Library Scale to 100k Captures

## Problem Frame

The Library was built around a hand-curated fixture set of ~50 rows. The
real read path (`library:list { limit: 500 }`) caps at 500, builds a DOM
node per cell, and groups by `source_app_bundle_id` against an index that
leads on bundle-id (not recency). The sidebar's app-grouping does not
maintain denormalized counts. There is no virtualization, no pagination,
no keyset cursor, no count cache.

Best guess without measurement: at 10k–100k captures the Library cold-
loads slowly, the sidebar fetches grow with row count, scrolling chokes
on layout, and `idx_captures_timeline` does not help the unfiltered
recency query. We have not actually exercised any of this — we have a
hypothesis, not data.

We need:

1. A seeder that produces realistic SQLite + on-disk state at canonical
   sizes, going through the same command-bus path the live capture
   pipeline uses, so insert cost and packing reflect production.
2. Measurement at every canonical size to confirm/refute where the
   curve breaks.
3. The minimum set of fixes — virtualization, keyset pagination, count
   denormalization, recency-leading index — required to keep the
   Library snappy regardless of dataset size.
4. An isolation primitive (env-var-driven data root) so perf runs do
   not touch the user's real Library and can be wiped wholesale by
   deleting one directory on an external volume.

## Requirements

- **R1.** Add a single source of truth for "where PwrSnap stores
  everything" — when `PWRSNAP_DATA_ROOT` is set, the SQLite DB, the
  captures source store, the render cache, the trash directory, and
  any future Documents-backed storage all root under it instead of
  `app.getPath("userData")`. The variable re-roots *every* persistent
  surface; no path bypass is permitted.
- **R2.** Provide a dev-only seeder, registered as a command on the
  command-bus (e.g. `dev:seed:run`, `dev:seed:wipe`), reachable via
  (a) a hidden tray menu visible only when `NODE_ENV !== 'production'`
  and (b) a CLI flag (`pnpm --filter desktop dev -- --seed=10k`).
  Production builds must not register the dev surface at all (no
  hidden-via-flag — it's not in the build).
- **R3.** The seeder must dispatch through the command-bus for each
  row, exercising the same handler chain a real capture takes: PNG on
  disk → `source-store.put` → `captures-repo.insertOrFindCapture` →
  `events:captures:changed` broadcast. A small new ingest command
  (e.g. `capture:ingest`) is acceptable and expected — the existing
  `capture:region` shells out to `screencapture(1)` and is unsuitable
  for synthetic content.
- **R4.** Generated PNGs are color-banded by the synthetic
  `source_app_bundle_id`: each app gets a base color, each row varies
  a small index region so `sha256` is unique per row. Files stay
  small (< ~1 KB after PNG compression).
- **R5.** Where possible, the seeder hardlinks subsequent rows in the
  same `(app, day)` bucket to share an inode. Each row still has a
  unique filename and the DB row's sha256 is unique; only the file
  bytes are shared. Fall back to copy when hardlinks are unavailable
  (e.g. across volumes).
- **R6.** Canonical profiles (rows / day-spread / max-per-day):
  - `100`   — 30 days within last 365.
  - `1k`    — 100 days within last 365.
  - `2k`    — 200 days within last 730.
  - `10k`   — lumpy distribution over 730–1,095 days, max ~200/day.
  - `20k`   — same shape as `10k`, max ~250/day. (Default everyday
    profile in CI / local checks.)
  - `stress100k` — over 3–5 years, lumpy, max ~300/day. Behind an
    explicit flag; not run on every check.
- **R7.** Within every profile, app distribution is power-law over
  100 distinct synthetic `source_app_bundle_id` values: top ~10 carry
  ~60% of rows, the long tail covers the rest. Distribution is
  deterministic (seeded RNG keyed on profile name + row index) so
  re-runs of the same profile produce the same dataset.
- **R8.** Rows are inserted strictly oldest-to-newest by
  `captured_at`. Each profile starts from a clean data root — the
  seeder wipes the data root before populating, then runs the full
  insert sequence. (Wiping the *real* user library is impossible
  because `PWRSNAP_DATA_ROOT` is required to point somewhere
  non-default for any wipe to occur; without it set the wipe command
  refuses.)
- **R9.** During seeding, capture per-batch insert latency: p50/p95/
  p99 wall-time per `capture:ingest` dispatch, bucketed at
  100/500/1k/2k/5k/10k/20k/50k/100k cumulative rows. Output goes to
  `<dataRoot>/perf/seed-<profile>-<ts>.jsonl`.
- **R10.** After seeding completes, the seeder automatically opens the
  Library window, instruments first-paint, and records p50/p95 across
  N reloads of the cold-load path (`library:list` request → first
  grid paint). Same JSONL stream as R9.
- **R11.** After each profile run, snapshot DB sizing: file size,
  `PRAGMA page_count`, per-index size via `dbstat`, plus `EXPLAIN
  QUERY PLAN` output for the canonical Library queries. Recorded in
  the same JSONL.
- **R12.** While the Library is open at the largest profile (and
  ideally every profile), capture frame-time samples during
  programmatic scroll and report dropped-frame %. Same JSONL.
- **R13.** Library grid is virtualized — only on-screen rows plus a
  small overscan get DOM. The current "every cell is a div" pattern
  is removed.
- **R14.** `library:list` becomes keyset/cursor paginated on
  `(captured_at DESC, id)`. The renderer requests successive windows
  as the user scrolls; the `limit: 500` ceiling goes away.
- **R15.** Counts shown in the sidebar (and anywhere else a total is
  surfaced) are served from a denormalized count source — either a
  small `app_stats` (or similar) table, triggers, or counts updated
  inline in the ingest handler. The Library never issues a
  `COUNT(*)` over the full captures table on the load path.
- **R16.** The `captures` index design is audited at every canonical
  size with `EXPLAIN QUERY PLAN`. At minimum, an index that leads on
  `captured_at DESC` (with the `deleted_at IS NULL` partial
  predicate) exists so the unfiltered recency query is index-only.
  The existing `idx_captures_timeline` stays for the
  filter-by-app-and-recency path.

## Success Criteria

- Library cold-load time and scroll smoothness at the `stress100k`
  profile are not meaningfully worse than at the empty / 100 / 20k
  profiles. Specific ms numbers are not the gate; the *shape* of the
  curve is — the perf measurement output for cold-load, scroll
  frame-rate, and per-batch insert latency is flat or sublinear from
  100 → 100k. Any super-linear segment is investigated and either
  flattened or explicitly accepted with rationale before the work is
  declared done.
- Re-running the seeder for any profile is single-command and leaves
  the user's real Library completely untouched (because
  `PWRSNAP_DATA_ROOT` is set to a directory on an external volume —
  e.g. `/Volumes/Dev/pwrsnap-perf/<profile>`).
- The dev surface (tray menu + CLI flag) is not present in production
  builds.

## Scope Boundaries

- **No** general-purpose tags / `capture_tags` / `tags` table. The
  "100 application tags" framing maps to 100 distinct
  `source_app_bundle_id` values — the existing app-grouping concept.
  When the deferred tags migration eventually lands, a follow-up
  brainstorm extends the seeder; this work does not block on it.
- **No** Phase 7 HTTP RPC. The seeder dispatches in-process via the
  command-bus. Pulling the HTTP server forward for this use case is
  out of scope.
- **No** new auth / capability checks on the dev surface beyond the
  build-time exclusion. The dev seeder is not present in production
  bundles, so transport-level gating is unnecessary here.
- **No** changes to the capture pipeline behavior in production —
  any new ingest command exists to support synthetic seeding and is
  registered alongside existing `capture:*` commands, not in place
  of them.
- **No** CI gating on absolute ms targets in this work. We ship on
  curve shape; numeric gates can be layered on later once we know
  the realistic floor on each platform.

## Key Decisions

- **Tag concept = `source_app_bundle_id`.** "100 application tags" is
  the existing app-grouping field. Avoids implementing a deferred
  feature just to stress it. — *Why:* the schema for a real tag
  system isn't in place yet, and the bottlenecks the user is worried
  about (sidebar groupings, count fetches, grid render) all sit on
  the existing field.
- **Insert path = command-bus dispatch in-process.** No new transport
  surface. — *Why:* faithful to production handler chain and avoids
  pulling Phase 7 HTTP RPC forward.
- **PNG strategy = color-banded per app, vary small region per row.**
  Tiny on disk, visually rich, sha256-unique. — *Why:* makes UI
  scroll/spotting issues visible by eye, doesn't degenerate the
  render-cache pipeline like a 1×1 PNG would.
- **Profile ladder = 100 / 1k / 2k / 10k / 20k everyday, plus
  `stress100k` behind a flag.** Captures the inflection points
  (2k, 20k) where O(n²) typically appears, without making 100k a
  routine cost. — *Why:* user explicitly asked for granularity at
  the bend, not a pure 10× ladder.
- **Data isolation = `PWRSNAP_DATA_ROOT` env var.** Single primitive
  that re-roots DB, captures, cache, trash, and any future
  Documents-backed storage. — *Why:* makes wipe-and-reseed safe
  (deleting one directory on an external SSD), keeps the user's
  real Library untouched, and supports the upcoming work that will
  put some content under `~/Documents`.
- **Success bar = direction over numbers.** Flat / sublinear curve
  is the gate; specific ms targets are guidance. — *Why:* user
  explicitly chose this; lets us land the structural fixes without
  litigating absolute numbers we haven't measured yet.
- **Hardlink within `(app, day)` buckets.** One physical PNG per
  bucket, hardlinks for the rest in the same bucket. — *Why:*
  keeps `stress100k` from chewing up the SSD while still exercising
  per-row directory entries and per-row sha256.

## Dependencies / Assumptions

- The user has an external volume (e.g. `/Volumes/Dev`) with enough
  free space for the largest profile's hardlinked layout. The
  seeder fails fast with a clear message if the configured
  `PWRSNAP_DATA_ROOT` does not exist or is not writable.
- `app.getPath("userData")` is currently the only on-disk root used
  by the desktop app. R1 is a small refactor across `db.ts`,
  `source-store.ts`, render-cache plumbing, and trash plumbing —
  not a sprawling change.
- `better-sqlite3` `dbstat` virtual table is available (it's a
  compile-time option but is on by default in the version pinned by
  `apps/desktop`). Confirm during planning; if absent, fall back to
  a simpler size breakdown.
- Forward-looking: a separate stream of work intends to start
  storing some PwrSnap data under `~/Documents`. R1 must cover that
  path too — when it lands it routes through the same
  `getDataRoot()` plumbing.

## Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R3][Technical] Exact name and shape of the synthetic
  ingest command — `capture:ingest` taking `{ pngBytes, capturedAt,
  sourceAppBundleId, sourceAppName, widthPx, heightPx }` is the
  obvious shape; planning confirms whether to ship this as a
  permanent agent-facing command (it's useful beyond seeding) or
  scope it dev-only.
- [Affects R13][Needs research] Virtualization library choice —
  TanStack Virtual vs `react-window` vs hand-rolled. Pick during
  planning based on bundle size, grid-with-section-headers support
  (the Library currently groups by day), and integration with the
  three-state view-model reducer.
- [Affects R15][Technical] Count denormalization mechanism — small
  `app_stats` table with explicit increments in the ingest handler,
  vs. SQLite triggers, vs. computed-on-open and cached in memory.
  All three work; planning picks based on simplicity and how they
  interact with soft-delete.
- [Affects R16][Needs research] Whether the new recency-leading
  index is a *replacement* for `idx_captures_timeline` or an
  addition. EXPLAIN QUERY PLAN at every profile size will tell us;
  planning runs that check.
- [Affects R10, R12][Technical] How to instrument first-paint and
  frame-time from inside the seeder run — the cleanest path is
  probably a perf-marker IPC channel the renderer publishes when
  the grid first commits, plus `chrome.tracing` for frame-time.
  Decide during planning.
- [Affects R5][Technical] Hardlink strategy when
  `PWRSNAP_DATA_ROOT` lives on a filesystem that doesn't support
  hardlinks (rare on macOS, but external SSDs formatted exFAT do
  not). Detect and fall back to copy with a one-line warning.
- [Affects R8][Technical] Wipe semantics — `rm -rf` of the data
  root, or use `app.getPath` only after re-rooting? Planning picks
  the safer one. Hard rule: refuse to wipe unless
  `PWRSNAP_DATA_ROOT` is set and not equal to the user's default
  `app.getPath('userData')`.

## Next Steps

→ `/ce:plan` for structured implementation planning.
