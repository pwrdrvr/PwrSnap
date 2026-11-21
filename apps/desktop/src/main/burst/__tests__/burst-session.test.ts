// Burst sessions: the rules that keep a burst's stills honest.
//
//   1. Only stills the recorder really wrote inside the session's frames
//      directory are accepted — never a path outside it, a symlink out of
//      it, a misnamed file, or a duplicate.
//   2. Keep is a model: whatever faults the capture store throws, retrying
//      the same choice ends with every chosen still kept EXACTLY once, in
//      capture order, nothing unchosen kept, and — while the session is
//      open — every still still on disk for the review to show (the store
//      consumes the file it is given).
//   3. Frame URLs round-trip, and nothing else parses as one.
//   4. The time label sits inside the still and says the clock time plus
//      the offset from the first kept still.

import { mkdirSync, mkdtempSync, existsSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";
import {
  __resetBurstSessionsForTests,
  acceptRecorderFrames,
  BURST_TEMP_PREFIX,
  burstFrameUrl,
  captureTimeLabel,
  discardBurst,
  getBurstSessionView,
  keepBurstFrames,
  onBurstSessionChange,
  openBurstSession,
  parseBurstFrameUrl,
  type PersistStill
} from "../burst-session";

const roots: string[] = [];

afterEach(() => {
  __resetBurstSessionsForTests();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function frameName(i: number): string {
  return `frame-${String(i).padStart(6, "0")}.png`;
}

/** A burst temp dir holding `count` stills 100 ms apart. */
function makeBurstDir(count: number): { rootDir: string; framesDir: string; reported: object[] } {
  const rootDir = mkdtempSync(join(tmpdir(), BURST_TEMP_PREFIX));
  roots.push(rootDir);
  const framesDir = join(rootDir, "frames");
  mkdirSync(framesDir);
  const reported = Array.from({ length: count }, (_, i) => {
    const path = join(framesDir, frameName(i));
    writeFileSync(path, `still ${i}`);
    return { index: i, path, utcMs: 1_700_000_000_000 + i * 100, width: 800, height: 600 };
  });
  return { rootDir, framesDir, reported };
}

describe("acceptRecorderFrames", () => {
  test("accepts exactly the real stills inside the frames dir", () => {
    const { rootDir, framesDir, reported } = makeBurstDir(6);
    const outside = mkdtempSync(join(tmpdir(), "pwrsnap-test-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, frameName(40)), "elsewhere");
    // A link inside the dir that points out of it.
    symlinkSync(join(outside, frameName(40)), join(framesDir, frameName(41)));
    const good = reported as Array<{ index: number; path: string; utcMs: number; width: number; height: number }>;

    type Entry = { entry: unknown; valid: number | null };
    const candidates: Entry[] = [
      ...good.map((g) => ({ entry: g, valid: g.index })),
      { entry: { ...good[0], index: 40, path: join(outside, frameName(40)) }, valid: null },
      { entry: { ...good[0], index: 41, path: join(framesDir, frameName(41)) }, valid: null },
      { entry: { ...good[1], path: join(framesDir, "..", "frames", "..", frameName(1)) }, valid: null },
      { entry: { ...good[2], index: 3 }, valid: null },
      { entry: { ...good[2], path: join(framesDir, "frame-2.png") }, valid: null },
      { entry: { ...good[3], utcMs: Number.NaN }, valid: null },
      { entry: { ...good[3], width: 0 }, valid: null },
      { entry: { ...good[4], index: -1 }, valid: null },
      { entry: { ...good[5], path: join(rootDir, frameName(5)) }, valid: null },
      { entry: null, valid: null },
      { entry: "frame-000000.png", valid: null }
    ];

    fc.assert(
      fc.property(fc.array(fc.constantFrom(...candidates), { maxLength: 24 }), (picked) => {
        const accepted = acceptRecorderFrames(framesDir, picked.map((p) => p.entry));
        const expected = [...new Set(picked.map((p) => p.valid).filter((v): v is number => v !== null))].sort(
          (a, b) => a - b
        );
        expect(accepted.map((a) => a.index)).toEqual(expected);
        for (const a of accepted) expect(a.path.startsWith(framesDir) || a.path.includes("/frames/")).toBe(true);
      }),
      { numRuns: 200 }
    );
  });
});

describe("keepBurstFrames", () => {
  // The real store moves its input into the capture bundle. The fake does
  // the same (unlinks on success) and fails on the scheduled calls.
  function fakeStore(failOnCalls: ReadonlySet<number>) {
    const kept: Array<{ content: string; capturedAt: string; label: string | null }> = [];
    let calls = 0;
    const persist: PersistStill = async (tempPath, _app, options) => {
      const call = calls++;
      if (failOnCalls.has(call)) {
        return { ok: false, error: { kind: "persistence", code: "disk_full", message: "disk full" } };
      }
      const { readFileSync } = await import("node:fs");
      const content = readFileSync(tempPath, "utf8");
      unlinkSync(tempPath);
      const label = options.annotations?.[0]?.shape;
      kept.push({
        content,
        capturedAt: options.capturedAt,
        label: label?.kind === "text" ? label.body : null
      });
      expect(options.tags).toEqual(["burst"]);
      return { ok: true, value: { id: `cap-${kept.length}` } as CaptureRecord };
    };
    return { persist, kept };
  }

  test("retrying after faults keeps each chosen still exactly once, and never loses one", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.nat(7), { minLength: 1, maxLength: 8 }),
        fc.uniqueArray(fc.nat(12), { maxLength: 6 }),
        fc.boolean(),
        async (count, rawChoice, faults, stamp) => {
          __resetBurstSessionsForTests();
          const dir = makeBurstDir(count);
          const id = openBurstSession({
            ...dir,
            frames: dir.reported,
            evictedFrames: 0,
            droppedFrames: 0,
            sourceApp: null,
            sourceWindowTitle: null,
            devicePixelRatio: 2
          });
          const choice = rawChoice.filter((i) => i < count);
          if (choice.length === 0) return;
          const chosen = [...new Set(choice)].sort((a, b) => a - b);
          const store = fakeStore(new Set(faults));
          let closed = false;
          const off = onBurstSessionChange((bid, state) => {
            if (bid === id && state === "closed") closed = true;
          });
          for (let attempt = 0; attempt < 20 && !closed; attempt++) {
            const result = await keepBurstFrames(id, choice, stamp, store.persist);
            if (!closed) {
              expect(result.ok).toBe(false);
              // Open session: every still is still there to look at.
              for (const f of dir.reported as Array<{ path: string }>) expect(existsSync(f.path)).toBe(true);
              const view = getBurstSessionView(id)!;
              expect(view.keptIndexes).toEqual(chosen.slice(0, view.keptIndexes.length));
            } else {
              expect(result.ok).toBe(true);
            }
          }
          off();
          expect(closed).toBe(true);
          // Exactly the chosen stills, once each, in capture order.
          expect(store.kept.map((k) => k.content)).toEqual(chosen.map((i) => `still ${i}`));
          expect(store.kept.map((k) => k.capturedAt)).toEqual(
            chosen.map((i) => new Date(1_700_000_000_000 + i * 100).toISOString())
          );
          // The label's offset counts from the first CHOSEN still.
          if (stamp) {
            const offsets = store.kept.map((k) => /\(\+(\d+\.\d{3}) s\)$/.exec(k.label ?? "")?.[1]);
            expect(offsets).toEqual(chosen.map((i) => ((i - chosen[0]!) * 0.1).toFixed(3)));
          } else {
            expect(store.kept.every((k) => k.label === null)).toBe(true);
          }
          // The session's directory went with it.
          expect(existsSync(dir.rootDir)).toBe(false);
        }
      ),
      { numRuns: 60 }
    );
  });

  test("nothing chosen is a refusal, not an empty keep", async () => {
    const dir = makeBurstDir(3);
    const id = openBurstSession({
      ...dir,
      frames: dir.reported,
      evictedFrames: 0,
      droppedFrames: 0,
      sourceApp: null,
      sourceWindowTitle: null,
      devicePixelRatio: 1
    });
    const store = fakeStore(new Set());
    expect(await keepBurstFrames(id, [99], true, store.persist)).toMatchObject({
      ok: false,
      error: { code: "nothing_selected" }
    });
    expect(getBurstSessionView(id)).not.toBeNull();
  });

  test("a discard waits for a running keep, then deletes the stills", async () => {
    const dir = makeBurstDir(3);
    const id = openBurstSession({
      ...dir,
      frames: dir.reported,
      evictedFrames: 0,
      droppedFrames: 0,
      sourceApp: null,
      sourceWindowTitle: null,
      devicePixelRatio: 1
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = fakeStore(new Set([1]));
    const slow: PersistStill = async (...args) => {
      await gate;
      return store.persist(...args);
    };
    const keeping = keepBurstFrames(id, [0, 1, 2], false, slow);
    const discarding = discardBurst(id);
    release();
    expect((await keeping).ok).toBe(false);
    await discarding;
    expect(getBurstSessionView(id)).toBeNull();
    expect(existsSync(dir.rootDir)).toBe(false);
    expect(store.kept).toHaveLength(1);
  });

  test("a session refuses a directory that is not a burst temp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrsnap-test-other-"));
    roots.push(dir);
    expect(() =>
      openBurstSession({
        rootDir: dir,
        framesDir: dir,
        frames: [],
        evictedFrames: 0,
        droppedFrames: 0,
        sourceApp: null,
        sourceWindowTitle: null,
        devicePixelRatio: 1
      })
    ).toThrow();
  });
});

describe("frame URLs", () => {
  test("round-trip, full and thumb", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{6,32}$/),
        fc.integer({ min: 0, max: 9_999_999 }),
        fc.constantFrom("full" as const, "thumb" as const),
        (id, index, variant) => {
          expect(parseBurstFrameUrl(burstFrameUrl(id, index, variant))).toEqual({ burstId: id, index, variant });
        }
      )
    );
  });

  test("nothing else parses", () => {
    for (const url of [
      "pwrsnap-screen://b/../etc/passwd",
      "pwrsnap-screen://b/abcdefgh/1/../../x",
      "pwrsnap-screen://b/abc/1",
      "pwrsnap-screen://b/abcdefgh/-1",
      "pwrsnap-screen://b/abcdefgh/1/thumbs",
      "pwrsnap-screen://b/abcdefgh/1.5",
      "pwrsnap-screen://r/abcdefgh",
      "pwrsnap-capture://b/abcdefgh/1"
    ]) {
      expect(parseBurstFrameUrl(url)).toBeNull();
    }
  });
});

describe("captureTimeLabel", () => {
  test("sits inside the still and states clock time + offset from the first kept", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 64, max: 7680 }),
        fc.integer({ min: 64, max: 4320 }),
        fc.integer({ min: 0, max: 120_000 }),
        (w, h, offset) => {
          const first = Date.UTC(2026, 10, 21, 9, 15, 30, 250);
          const label = captureTimeLabel({ utcMs: first + offset, widthPx: w, heightPx: h }, first, "UTC");
          expect(label.shape.kind).toBe("text");
          if (label.shape.kind !== "text") return;
          // Always inside the still; in its top-left quarter wherever the
          // still is big enough to have one (a 64 px-tall strip is mostly
          // label — the text size comes from the shared annotation ladder).
          const { x, y } = label.shape.point;
          expect(x > 0 && x < 1 && y > 0 && y < 1).toBe(true);
          if (Math.min(w, h) >= 240) {
            expect(x).toBeLessThan(0.5);
            expect(y).toBeLessThan(0.5);
          }
          const at = new Date(first + offset);
          const clock = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}:${String(at.getUTCSeconds()).padStart(2, "0")}.${String(at.getUTCMilliseconds()).padStart(3, "0")}`;
          expect(label.shape.body).toBe(`${clock} (+${(offset / 1000).toFixed(3)} s)`);
        }
      )
    );
  });
});
