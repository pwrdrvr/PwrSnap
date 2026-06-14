# Windows E2E flakes after the `windows-latest` → VS2026 runner image migration

**Date:** 2026-06-13
**Symptom:** "Windows Desktop E2E" job (`ci.yml`) started going red on `main`
and on unrelated PR branches, all at once. Reported as flaky:

- `tray-first-paint.spec.ts` — `tray popover height 248 outside expected
  range [560, 720]` for the seeded scenario.
- `tray-sizing.spec.ts:269` — `expect(...).toBeGreaterThanOrEqual(370)` got
  `248` under non-1.0 zoom.
- `settings.spec.ts` — `EBUSY: resource busy or locked, unlink
  '...\pwrsnap-e2e-home-XXXX\DIPS-wal'` (also seen on `pwrsnap.db`).

It *looked* like PR #247 caused it (failure appeared on the first push after
it merged), but #247 was a coincidence.

## Root cause: the runner image changed, not our code

GitHub migrated the `windows-latest` / `windows-2025` label to a new image —
**Windows Server 2025 + Visual Studio 2026** (`windows-2025-vs2026`, GA
2026-06-08, gradual rollout through ~06-15). Our runs flipped from the old
VS2022 image to the new VS2026 image between 2026-06-11 and 2026-06-13.

Evidence (read the `Set up job` → `Runner Image` block of any job log):

| When | Image | Windows E2E |
|---|---|---|
| Jun 8–11 | `win25/20260525–20260607` (VS2022) | green, every run |
| Jun 13 (all day) | `win25-vs2026/20260608.135` (VS2026) | green ~7×, then first fail |

The old VS2022 image was 100% green. The failures **only** appear on the new
VS2026 image. Why #247 is exonerated: (1) it only touched `App.tsx` /
`app.css` / the auto-updater — not the tray or settings windows the failing
specs exercise; (2) the new image was already green several times before it
merged; (3) PR branches without #247's code fail identically. These specs are
flaky (pass on retry), so #247's merge was just when the new image's
low-frequency flake first rolled a loss.

**Lesson:** when CI goes red "right after PR X" but X can't plausibly touch
the failing code, check the runner image version in the job log *before*
blaming the PR. `runs-on: windows-latest` auto-migrates underneath you.

## What actually broke: two latent races the new image's timing exposes

The VS2026 image has different CPU/disk/GPU/WebView2 timing, which lost two
races our code had been winning by luck.

### 1. Tray remeasure race (the `248` heights)

`248` is the **empty-tray** height. The seeded tray's "last snap" section is
fetched over IPC and its preview image decoded via `pwrsnap-capture://`, so
the renderer measures the empty/text-only height first (~248) and re-measures
to the full height (~634) only after that async reflow lands.

- `measureTrayFirstPaintForE2E` (main, `tray.ts`) declared "stable" on *no
  resize for `stableMs` (300ms)*. When the seeded reflow arrives >300ms after
  the first measurement — routine on the slow image — it broke at 248.
- `tray-sizing.spec.ts` zoom test: `setZoomFactor` → `zoom-changed` →
  `events:popover:remeasure` → renderer re-post round-trip can outlast
  `waitForStableSize`'s window, so it sampled the pre-zoom 248.

**Fix:** gate "stable" on the expected content actually arriving, not on a
quiet timer.
- Added `minStableHeight` to `measureTrayFirstPaintForE2E`; the cold + prewarmed
  breaks now also require `getContentSize()[1] >= minStableHeight`. The spec
  passes `scenario.minHeight`. A height that never arrives **times out** (a real
  regression still fails) instead of silently sampling the transient state.
- Zoom test polls `contentSize.height` past the pre-zoom value before
  `waitForStableSize`.

This is the same class of bug the tray sizing notes in `CLAUDE.md` warn about:
a tuned constant (`stableMs`) that's right on the machine it was tuned on and
wrong elsewhere. The fix replaces the heuristic with a content-arrival gate.

### 2. Windows file-handle race in teardown (the `EBUSY`)

`removeHomeRoot` (`e2e/fixtures/electron-app.ts`) `rm`s the temp HOME right
after Electron exits. On Windows the OS reaps a dead process's file handles
**asynchronously**, so better-sqlite3's WAL/db files can still be locked for a
beat → `unlink` hits `EBUSY`. The old `maxRetries: 5 / 100ms` (~1.5s) wasn't
enough on the slower image.

The real damage: the `rm` **threw in test teardown**, which crashes the
Playwright worker (`Failed worker ran 36 tests`) and fails the whole job. That
is why a "3 flaky / 67 passed" report still exits 1 — the worker death, not the
flaky tests themselves.

**Fix:** bump retries (`maxRetries: 10 / 200ms`) **and never throw** — a leaked
temp dir on an ephemeral runner is harmless; crashing the worker is not. Log a
warning and move on.

## If you need green CI *now* (escape hatches, in order)

1. **Preferred:** the fixes above (root cause, survives the image).
2. Pinning is a poor option: `windows-2025` also migrates to VS2026, and the
   only VS2022 label left is `windows-2022` — which downgrades the OS to Server
   2022 (we've been on Server 2025 since late May). There is no "Server 2025 +
   VS2022" pin, and the old labels retire anyway.

## Files

- `apps/desktop/src/main/tray.ts` — `minStableHeight` gate in
  `measureTrayFirstPaintForE2E`.
- `apps/desktop/e2e/tray-first-paint.spec.ts` — `measure()` passes the floor.
- `apps/desktop/e2e/tray-sizing.spec.ts` — poll past pre-zoom height before
  sampling.
- `apps/desktop/e2e/fixtures/electron-app.ts` — `removeHomeRoot` retries
  harder and swallows.
