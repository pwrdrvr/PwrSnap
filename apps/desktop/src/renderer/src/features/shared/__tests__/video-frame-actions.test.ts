// Model test for the frame-action store. Rules:
//   1. An action acts on the LIVE head of the stage showing the capture
//      (not the throttled label head), and on nothing when no stage is.
//   2. The status shown is the newest action's: an older action that
//      settles late never overwrites it (two clicks, slow first encode).
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vitest";

const dispatchMock = vi.fn();
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args)
}));

import {
  __resetVideoFrameActionsForTests,
  formatFrameTime,
  publishVideoFramePosition,
  registerVideoFramePosition,
  runVideoFrameAction,
  subscribeForTests
} from "../video-frame-actions";

afterEach(() => {
  __resetVideoFrameActionsForTests();
  dispatchMock.mockReset();
});

describe("video frame actions", () => {
  test("acts on the live head, not the label head", async () => {
    let live = 2.7123;
    registerVideoFramePosition("cap", () => live, 0);
    publishVideoFramePosition("cap", 2.7);
    dispatchMock.mockResolvedValue({ ok: true, value: { widthPx: 10, heightPx: 10, timeSec: 2.712 } });
    await runVideoFrameAction("cap", "copy");
    expect(dispatchMock).toHaveBeenLastCalledWith("clipboard:copyVideoFrame", { captureId: "cap", timeSec: 2.7123 });
    live = 5;
    await runVideoFrameAction("cap", "save");
    expect(dispatchMock).toHaveBeenLastCalledWith("video:saveFrameAsSnap", { captureId: "cap", timeSec: 5 });
  });

  test("an explicit time (the menu's frozen head) wins over the live head", async () => {
    let live = 2.7;
    registerVideoFramePosition("cap", () => live, 0);
    dispatchMock.mockResolvedValue({ ok: true, value: { widthPx: 10, heightPx: 10, timeSec: 2.7 } });
    // The menu opened at 2.7 and named it; playback moved on before the click.
    live = 3.9;
    await runVideoFrameAction("cap", "copy", 2.7);
    expect(dispatchMock).toHaveBeenLastCalledWith("clipboard:copyVideoFrame", { captureId: "cap", timeSec: 2.7 });
    await runVideoFrameAction("cap", "copyTime", 2.7);
    expect(dispatchMock).toHaveBeenLastCalledWith("clipboard:copyText", { text: "0:02.700" });
  });

  test("with no stage and no time, nothing is dispatched", async () => {
    await runVideoFrameAction("cap", "copy");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  test("the newest action's status wins whatever order replies land in", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<"copy" | "save">("copy", "save"), { minLength: 1, maxLength: 6 }),
        fc.scheduler(),
        async (kinds, s) => {
          __resetVideoFrameActionsForTests();
          dispatchMock.mockReset();
          let seen: { kind: string; phase: string } | null = null;
          const unsub = subscribeForTests((st) => {
            seen = st === null ? null : { kind: st.kind, phase: st.phase };
          });
          registerVideoFramePosition("cap", () => 1, 0);
          dispatchMock.mockImplementation(() =>
            s.schedule(Promise.resolve({ ok: true, value: { widthPx: 1, heightPx: 1, timeSec: 1 } }))
          );
          const runs = kinds.map((k) => runVideoFrameAction("cap", k));
          await s.waitAll();
          await Promise.all(runs);
          unsub();
          expect(seen).toEqual({ kind: kinds[kinds.length - 1], phase: "done" });
        }
      ),
      { numRuns: 60 }
    );
  });

  test("frame time reads in whole milliseconds", () => {
    expect(formatFrameTime(2.7)).toBe("0:02.700");
    expect(formatFrameTime(61.0004)).toBe("1:01.000");
    expect(formatFrameTime(-3)).toBe("0:00.000");
  });
});
