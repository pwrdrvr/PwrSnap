// Who decides what a committed selection does — the renderer or the
// persisted policy. The answer is "both, in one specific way", and the
// tempting simplifications are all wrong in a way that costs the user
// something, so the whole table is pinned.

import { describe, expect, test } from "vitest";
import { resolveQuickCaptureAction } from "../quick-capture-action";

describe("resolveQuickCaptureAction", () => {
  test("ask honors whichever affordance the user reached for", () => {
    // Both actions were on screen. The keystroke IS the answer.
    expect(resolveQuickCaptureAction("ask", "snap")).toBe("snap");
    expect(resolveQuickCaptureAction("ask", "record")).toBe("record");
  });

  test("snap refuses a record the selector never offered", () => {
    // Under this policy no Record button rendered and `R` was unbound,
    // so a "record" echo is a bug or a hand-rolled IPC message. Main
    // configured the show; main gets the final say.
    expect(resolveQuickCaptureAction("snap", "record")).toBe("snap");
    expect(resolveQuickCaptureAction("snap", "snap")).toBe("snap");
  });

  test("record still honors the S escape hatch", () => {
    // The near-miss worth guarding: resolving `preference` whenever it
    // isn't "ask" reads as symmetric with the case above, and it would
    // record a selection the user explicitly pressed S to photograph.
    // "record" makes Record the PRIMARY action, not the only one.
    expect(resolveQuickCaptureAction("record", "record")).toBe("record");
    expect(resolveQuickCaptureAction("record", "snap")).toBe("snap");
  });

  test("a missing action is a snap under every policy that allows one", () => {
    // Absent is what every pre-chooser call site sends, and what the
    // renderer sends for any snap — the field only appears for a
    // recording. It must never be read as "use the policy".
    expect(resolveQuickCaptureAction("ask", undefined)).toBe("snap");
    expect(resolveQuickCaptureAction("snap", undefined)).toBe("snap");
    expect(resolveQuickCaptureAction("record", undefined)).toBe("snap");
  });
});
