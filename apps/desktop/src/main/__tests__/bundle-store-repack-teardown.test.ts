// scheduleRepack's debounce window can outlive the DB: the timer is
// 5s (30s under iCloud), and teardown — app quit in production, suite
// shutdown under vitest — closes the database while the timer is still
// pending. The timer callback then hits `getCaptureById` → `getDb`
// which throws "db: not opened" as an UNCAUGHT exception. Under vitest
// that single stray throw fails the entire run as an unhandled error
// even when every test passed (seen live on the Windows CI lane, PR
// #355). These tests pin the two defenses:
//
//   1. The timer callback swallows the closed-DB throw (the pending
//      re-pack is recovered on next boot via `edits_version >
//      bundle_edits_version`).
//   2. `cancelScheduledRepacks()` clears pending timers outright —
//      index.ts calls it in `will-quit` just before `closeDatabase()`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { closeDatabase, openDatabase } from "../persistence/db";
import { cancelScheduledRepacks, scheduleRepack } from "../persistence/bundle-store";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-repack-teardown-"));
  process.env.PWRSNAP_DATA_ROOT = workDir;
  await openDatabase();
});

afterEach(async () => {
  cancelScheduledRepacks();
  vi.useRealTimers();
  closeDatabase();
  delete process.env.PWRSNAP_DATA_ROOT;
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("scheduleRepack teardown safety", () => {
  test("a repack timer firing after closeDatabase() is a silent no-op", () => {
    vi.useFakeTimers();
    // Schedule while the DB is open (the schedule path itself reads
    // the DB to pick the debounce delay), then close before the timer
    // fires — the exact quit-time / suite-teardown race.
    scheduleRepack("cap_repack_after_close");
    closeDatabase();
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  test("cancelScheduledRepacks clears every pending debounce timer", () => {
    vi.useFakeTimers();
    scheduleRepack("cap_repack_cancelled_a");
    scheduleRepack("cap_repack_cancelled_b");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    cancelScheduledRepacks();
    expect(vi.getTimerCount()).toBe(0);
  });
});
