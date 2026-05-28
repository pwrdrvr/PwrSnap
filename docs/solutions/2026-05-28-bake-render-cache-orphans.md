# Bake render cache — content-addressed, orphans tolerated

**Status**: Architectural decision documented after [#138](https://github.com/pwrdrvr/PwrSnap/issues/138) /
[PR #143](https://github.com/pwrdrvr/PwrSnap/pull/143) (closed without merging).

**TL;DR** — the render cache is content-addressed by sha256 hash that
includes `BAKE_PIPELINE_VERSION`. When the version bumps, every cached
file becomes unreachable by hash and is **orphaned** on disk. We
**deliberately do NOT auto-sweep** the orphans. Lazy regen always
produces correct bytes; users get a "Clear cache" button in Settings
for the rare case where they care about the disk space.

---

## How the cache works

### Structure

```
~/Library/Application Support/PwrSnap/render-cache/
  <captureId-A>/
    abc123def456...png      ← renderHash="abc123def456..."
    xyz789abc123...webp
  <captureId-B>/
    9f2c1e...png
```

Filename = `<renderHash>.<format>`. `renderHash` is `sha256` over a
deterministic JSON serialization of EVERY input that affects the
output bytes:

- `BAKE_PIPELINE_VERSION` (the in-process integer in
  `apps/desktop/src/main/render/compose-tree.ts`)
- Canvas dims (`canvasWidthPx`, `canvasHeightPx`)
- Output width + format (`png` / `webp`)
- The full flattened layer tree:
  - For raster layers: `id`, `parent_id`, `z_index`, `opacity`,
    `blend_mode`, `transform`, `source_ref.sha256`, `natural_*_px`,
    `visible`
  - For vector layers: above + `shape` (the discriminated Overlay)
  - For effect layers: above + `effect` + `clip_rect`

See `computeTreeRenderHash()` in `compose-tree.ts` for the canonical
input list.

### Why `BAKE_PIPELINE_VERSION` is in the hash

The hash is the **correctness mechanism**. Without the version in the
hash:

```
v=4 ship → cache has H.png with v=4 bake bytes
v=5 deploys (fixed pixelate algorithm)
v=5 request → SAME hash inputs → SAME hash H → cache HIT → returns the
              v=4 bytes the user already complained about
```

Including the version means a bake-pipeline change produces a
different hash → different filename → cache miss → re-bake at the new
version → new bytes returned. The old file is now **unreachable** by
any hash → orphaned.

This is fundamental to content-addressed caching: ANY change to the
hash inputs invalidates the old key. The version is just another
input.

---

## Why we don't auto-sweep orphans

PR #143 added `enforceRenderCacheVersion()` to wipe the render cache
on boot when `BAKE_PIPELINE_VERSION` changed. It was closed without
merging because the **cost > benefit**, and the cost falls
disproportionately on **development**.

### Production user — orphans are mostly invisible

- One bump every few months (each bake fix that changes output bytes).
- 400 captures × 3 presets × 2 formats × N versions ≈ a few hundred MB
  of orphans accumulated over the app's lifetime.
- Settings → Storage → "Clear cache" wipes it all in one click.
- Lazy regen rebuilds on next access at the current version. No
  correctness exposure ever.

The "free disk space" gain from auto-sweeping is small relative to
the noise. Users who run out of disk space already have a UI for it.

### Development — auto-sweep is actively painful

Branch switching is a normal dev activity. Suppose:

```
main           → BAKE_PIPELINE_VERSION = "5"
fix/foo        → BAKE_PIPELINE_VERSION = "5"  (no bake changes)
fix/bar        → BAKE_PIPELINE_VERSION = "6"  (bake fix)
fix/baz        → BAKE_PIPELINE_VERSION = "6"  (different bake fix)
```

With auto-sweep enabled:

1. `git checkout fix/bar` → launch app → marker mismatches → **full cache wipe**
2. Scroll the library → 2400 lazy re-bakes to repopulate
3. `git checkout main` → launch app → marker mismatches **again** → **full cache wipe**
4. Scroll the library → 2400 lazy re-bakes AGAIN
5. `git checkout fix/baz` → launch app → marker matches v=6 from step 1 but bake bytes are from `fix/bar`'s algorithm → **another full wipe** (because the marker is only the version int, not the commit)
6. ...

Without auto-sweep:

1. `git checkout fix/bar` → launch → bytes from main still there, but
   their hashes don't match the new requests → fresh bakes written
   alongside, old files orphaned
2. `git checkout main` → launch → main's hashes still match its
   leftover bytes from before → **cache hits, no rebake**
3. `git checkout fix/baz` → launch → new hashes, new bakes, files
   from main still cached for next switchback

Without auto-sweep, **branches with the same `BAKE_PIPELINE_VERSION`
share cache entries via the hash** — switchbacks are fast. With
auto-sweep, every switch between different-version branches restarts
from zero.

The trade-off favors NOT sweeping. The cost (dev branch-switching
pain) is recurring and high; the benefit (one-time prod disk cleanup)
is rare and bounded.

---

## When to bump `BAKE_PIPELINE_VERSION`

Bump when a code change makes the bake produce **different output
bytes for the same input layer tree + dims + format**. Examples:

- Algorithm change (pixelate's down→up samples changed, highlight's
  blend formula changed).
- Encoder option change (`palette: false` on sharp's PNG output).
- New layer kind support that produces visible pixels where the old
  version produced none.

Do NOT bump when:

- Refactoring without changing output bytes (renaming variables,
  splitting functions, reordering instructions that don't affect
  computation).
- Adding logging.
- Adding new commands that don't touch `composeV2`.

If unsure: bake a known capture before and after the change, sha256
the resulting PNG. If the hashes match, don't bump.

---

## User-facing escape hatches

For users (and devs) who DO want to clear orphans:

1. **Settings → Storage → Clear cache** — wipes everything under
   `render-cache/`. Next request lazy-regenerates at the current
   version.
2. **Settings → Storage → Trim cache** — keeps only the rapid-render
   thumbnails (140 + 400 widths) that drive Library scroll. Trims
   bigger MED/HIGH bakes that get re-made on copy.

Both implemented in
`apps/desktop/src/main/persistence/render-cache-maintenance.ts`
(`clearRenderCache` + `trimRenderCache`).

A `enforceRenderCacheVersion` function is NOT exported from that
module — see [PR #143](https://github.com/pwrdrvr/PwrSnap/pull/143)
for the rejected implementation if you want to reconsider.

---

## Open question — bounded orphan growth

The cache has no upper bound. A long-lived install across many bake
versions could accumulate gigabytes in pathological cases. If this
becomes a real complaint, two options:

1. **Time-based GC** — delete files older than N days that haven't
   been read in the last M days (`atime` on the file). Independent of
   version, doesn't penalize branch-switching. Could run in a
   background task or on user-initiated trim.
2. **Bounded LRU** — track access timestamps in the DB; evict to a
   total-size budget. More plumbing, more correct.

Neither is built. Lazy regen + user-initiated clear is enough for
now.

---

## Adjacent code

| File | What it owns |
|---|---|
| `apps/desktop/src/main/render/compose-tree.ts` | `BAKE_PIPELINE_VERSION` constant, `computeTreeRenderHash`, the cache-hit check in `composeV2` |
| `apps/desktop/src/main/render/coordinator.ts` | `renderViaCoordinator` — the main entry point for all bake callers (clipboard, library thumbnails, etc.) |
| `apps/desktop/src/main/persistence/paths.ts` | `getCacheRoot()` — `<userData>/render-cache/` |
| `apps/desktop/src/main/persistence/render-cache-maintenance.ts` | `clearRenderCache` (Settings action), `trimRenderCache` (Settings action), `migrateLegacyRenderCache` (one-time migration from Chromium's cache bucket) |
| `apps/desktop/src/main/storage/accounting.ts` | `getStorageSnapshot` — measures cache dir size for the Storage popover |
