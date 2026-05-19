---
date: 2026-05-07
topic: durable-edit-storage
---

# Durable Edit Storage — `.pwrsnap` Bundle + Paired Composite PNG

## Problem Frame

Today PwrSnap stores immutable source PNGs under `<userData>/captures/<yyyy>/<mm>/<id>.png`
([source-store.ts](apps/desktop/src/main/persistence/source-store.ts:1-9)) and overlays / future
tags / descriptions / AI-runs as sqlite rows in `<userData>/pwrsnap.db`. The DB is the
only record of every user edit.

If `<userData>` is wiped (reinstall, Migration Assistant skip, manual cleanup of
Application Support, machine swap), the user loses every overlay, tag, description,
and AI run they've ever made. Source pixels survive only as long as `<userData>` does
— and even those, today, never see iCloud or Finder, so users can't browse their
own screenshots outside the app. The plan already commits to "overlay-as-data over
render-with-history" ([plan §1128](docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md:1128));
this brainstorm decides where that data physically lives so it survives Application
Support loss.

Scope: single-user, single-timeline disaster recovery. Concurrent multi-Mac iCloud
editing is out of scope (last-write-wins per file is acceptable until a future
brainstorm).

## Requirements

- **R1.** Every capture is durably represented by a `<name>.pwrsnap` file in
  `~/Documents/PwrSnap/`. The bundle contains the immutable source PNG, the rendered
  composite PNG, and a JSON manifest holding overlays, tags, description, AI-run
  metadata, and bundle/schema versions. Format is a ZIP container (Snagit `.snagx`
  precedent), not a macOS package directory — single inode, cross-platform-portable
  for future Phase 8 Windows/Linux builds.

- **R2.** Each `<name>.pwrsnap` ships with a paired flat `<name>.png` sibling in the
  same folder. The flat PNG is the user-visible artifact: it Quick-Looks, opens in
  Photos, drags into Slack, syncs through iCloud. Users do not need PwrSnap installed
  to view or share their screenshots.

- **R3.** The bundle is the system of record. The paired flat PNG is an ephemeral
  derivative — if the user renames or deletes it, no data is lost; the doctor
  regenerates it from the bundle. If the user deletes the bundle but keeps the PNG,
  the standalone PNG re-imports as a flat screenshot with no overlays.

- **R4.** Bundles are the durable system of record; `<userData>/pwrsnap.db`
  remains the live read path that drives every IPC, every Library render,
  every overlay lookup — its runtime role doesn't change. What changes is
  the durability story: the DB is now rebuildable from the on-disk bundles.
  App boot reconciles: any orphan bundle without a DB row is imported; any
  DB row whose bundle is missing is treated as a delete (or surfaced for
  the user to confirm if conservative). After full reconcile, the DB and
  the on-disk bundles agree.

- **R5.** A `pwrsnap doctor` / restore flow exists and is callable from Settings →
  Storage. It walks `~/Documents/PwrSnap/`, parses every bundle, and rebuilds the DB
  from scratch. Idempotent. Used both for "fresh install on new Mac" and "my library
  feels broken, re-scan it."

- **R6.** Edits to overlays, tags, or description trigger an atomic bundle update:
  re-render composite, rewrite the JSON manifest, replace the bundle via temp-file +
  rename. Bundle writes are debounced (≥1s after last edit) so dragging an arrow
  doesn't repackage the zip on every mouse-move; the DB is still the live read path
  during the debounce window.

- **R7.** Privacy: user-owned. Sources live inside the bundle in Documents — they
  sync to iCloud / Photos / wherever the user has Documents pointed. The user owns
  their data. No separate Application Support cache is required for source pixels;
  any per-machine cache (variant render sizes) is regenerable from the bundle.

- **R8.** Trash semantics extend to bundle pairs: `library:delete` moves both the
  bundle and the paired PNG to `<userData>/.trash/<id>/`, retained 14 days, then
  hard-deleted (mirrors current `source-store.ts` trash sweep).

- **R9.** Existing dev-state migration: a one-time migration converts every row in
  the current `captures` table + every PNG under `<userData>/captures/` into a bundle
  pair under `~/Documents/PwrSnap/`. Run on first boot of the new build, gated by a
  schema version. After migration, the old `<userData>/captures/` tree is preserved
  as a `.legacy/` directory until the user confirms migration succeeded, then
  removed.

- **R10.** `<userData>` holds nothing of value. After this change, every byte under
  `<userData>` is either a rebuildable index (`pwrsnap.db`), a regenerable cache
  (`cache/` for variant render sizes and pre-sized export composites), or
  short-retention trash (`.trash/<id>/`). Wiping `<userData>` costs the user a
  doctor reconcile pass and re-rendering of variant sizes on demand — no data loss.
  This is the load-bearing durability invariant; future work in this directory must
  preserve it.

## Success Criteria

- A user reinstalls PwrSnap (or restores their Documents folder onto a fresh Mac)
  and sees their full library — every overlay, tag, description, AI-run record —
  rebuilt from the on-disk bundles, with no manual import.
- Deleting `<userData>/pwrsnap.db` and relaunching the app produces an identical
  library state after the doctor's reconcile pass.
- A user sees their screenshots as image files in `~/Documents/PwrSnap/` and can
  Quick-Look, AirDrop, Slack-paste, or sync via iCloud without opening PwrSnap.
- Doctor reconcile of a 1,000-capture library completes in under 30s on M-class
  hardware (zip header + manifest read only; full bundle decode only on miss).

## Scope Boundaries

- **Out of scope: concurrent multi-Mac editing.** Two Macs editing the same capture
  simultaneously remain last-write-wins per file; iCloud's "Keep both" conflict is
  the user's problem to resolve, with the doctor reconciling whatever state is
  present after the dust settles.
- **Out of scope: cloud-native sync (PwrSnap-managed sync server).** Documents +
  iCloud is the sync substrate; PwrSnap doesn't operate one.
- **Out of scope: encrypted bundles.** Bundles are plain ZIPs. If a user wants
  encryption-at-rest, Documents lives on FileVault.
- **Out of scope: bundle format compatibility with Snagit / CleanShot.** Convergence
  with their containers offers no real value and constrains our schema.
- **Out of scope: human-friendly bundle filenames driven by AI description / tags.**
  Default naming follows the macOS Screenshot convention (`PwrSnap YYYY-MM-DD at
  HH.MM.SS.png` + `.pwrsnap` sibling). Renaming UX can come later.

## Key Decisions

- **Snagit-style bundle + paired flat PNG, not Lightroom-style sidecar JSON.** The
  research showed both are production-proven (Snagit, CleanShot, Affinity vs.
  Lightroom, Apple Photos, Capture One). PwrSnap chooses the bundle path. Rationale:
  the founder explicitly prefers a single self-describing project artifact over an
  exposed `.json` sidecar; the paired PNG addresses Snagit's same UX need (image
  visibility in Finder).

- **Source PNG lives inside the bundle, not in a separate cache.** Privacy concern
  about un-blurred originals syncing to iCloud was raised and waved off — "the file
  came from the user; they own the data." Eliminates the dual-location restore
  problem and keeps bundle truly self-contained.

- **DB role unchanged at runtime; bundles add a recovery path.** The DB stays
  the live read path that drives the UI. What changes is durability — bundles
  on disk are now the system of record, and the DB can be rebuilt from them
  when needed. Removes "lose userData, lose everything"
  failure mode entirely. The DB remains the hot read path for performance, but the
  source-of-truth is the on-disk bundle.

- **ZIP container, not macOS package directory.** Cross-platform-portable, single
  inode, no iCloud-syncs-package-as-many-files issue, matches Snagit's choice.
  Compression mode for the planner to decide (likely STORE for embedded PNGs since
  they're already compressed; DEFLATE for the JSON manifest).

- **Bundle is system of record; paired PNG is derivative.** Asymmetric durability
  semantics. User can delete or rename the PNG freely; doctor regenerates. User
  deleting the bundle is the destructive operation.

- **Embedded-PNG-metadata path rejected.** Industry research found Skitch is the
  only living-or-dead example; no current successor at any scale. Withdrawn from
  consideration.

## Dependencies / Assumptions

- `~/Documents/PwrSnap/` is the canonical location. Future "user picks library
  folder" UX can come later; default is fine for v1.
- ZIP read/write performant enough for capture hot path. Acceptable because the hot
  path only writes the bundle once at capture time; subsequent edits debounce
  bundle rewrites off the user's input.
- Sharp's PNG encoder is the existing render path; bundle write is layered on top
  via Node's `node:zlib` or a small zip library (`yauzl` / `yazl` / `archiver`) —
  selection is a planning concern.
- Existing source-immutability invariant survives the move: only the bundle writer
  touches `source.png` inside the bundle, and only at create time.

## Outstanding Questions

### Resolve Before Planning

(None — the product/durability shape is settled. Implementation details below are
proper `/ce:plan` concerns.)

### Deferred to Planning

- [Affects R1][Technical] Which Node ZIP library? Candidates: `yazl` + `yauzl`
  (separate write/read, low dependency surface), `archiver` (fat but mature),
  `adm-zip` (synchronous, lower throughput). Need to evaluate against the capture
  hot path's <120ms SLA and atomic-rename ergonomics.
- [Affects R1][Technical] Bundle internal layout / manifest schema. Proposed:
  `manifest.json` (bundle format version, capture id, created_at, source dimensions,
  source sha256, schema_version), `source.png`, `composite.png`, `overlays.json`.
  Confirm against future Phase 5 (voice-describe), Phase 6 (sizzle-reel composer)
  needs.
- [Affects R6][Technical] Debounce timing and atomic-rename pattern for bundle
  rewrites. Need to ensure no partial bundle visible to iCloud during write.
- [Affects R3][Technical] Pair-discovery algorithm: filename match (`X.png` ↔
  `X.pwrsnap`) is fragile to rename. Stable id inside the bundle's manifest
  recovers identity but doesn't recover the pairing. Either accept that user-renamed
  PNGs orphan, or store the paired-PNG filename inside the manifest and reconcile.
- [Affects R4, R5][Technical] Doctor reconcile pass: when DB and bundle disagree
  (e.g., the DB has an overlay the bundle's manifest doesn't), bundle wins. Confirm
  the conflict-resolution rules are exhaustive and tested.
- [Affects R9][Needs research] Existing dev data migration path: precise on-disk
  shape of the migration, including the `.legacy/` rollback directory and how long
  to retain it. Likely lands as its own migration script.
- [Affects R8][Technical] Trash sweep extension: `<userData>/.trash/<id>/` becomes
  a directory holding both files instead of a single PNG. Update
  [source-store.ts:88-97](apps/desktop/src/main/persistence/source-store.ts:88-97)
  and the boot-time GC.
- [Affects R7][Needs research] Cache layer for variant render sizes
  ([db.ts:52-54](apps/desktop/src/main/persistence/db.ts:52-54)): stays in
  `<userData>/cache/<capture_id>/<hash>.<format>`, regenerable from the bundle's
  source. No structural change needed but worth confirming during planning.

## Next Steps

→ `/ce:plan` for structured implementation planning. The product shape is settled;
the planner picks zip library, manifest schema, migration script shape, and pair
reconciliation rules.
