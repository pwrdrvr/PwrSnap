// The single-source-of-truth contract for the Low/Med/High image copy.
// Every copy surface (tray, float-over, Library card body, ⌘1/2/3) routes
// through these helpers, so asserting the verb ONCE here guarantees they
// all put the same thing on the clipboard. PR #232 drifted two of those
// surfaces to `clipboard:copy-file` (a file URL that won't paste back into
// PwrSnap) precisely because each had its own inline dispatch.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../pwrsnap", () => ({
  dispatch: vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
}));

import { dispatch } from "../pwrsnap";
import { copyImagePreset, copyImagePresetPath } from "../clipboard-copy";

describe("clipboard-copy — image preset copy contract", () => {
  beforeEach(() => {
    vi.mocked(dispatch).mockClear();
  });

  it("copyImagePreset copies raw IMAGE BYTES (clipboard:copy), never a file URL", () => {
    copyImagePreset("cap_1", "med");
    expect(dispatch).toHaveBeenCalledWith("clipboard:copy", {
      captureId: "cap_1",
      preset: "med"
    });
    // The #232 regression — a file URL that reads back as "no image" on
    // paste under Universal Clipboard — must never come from this path.
    expect(
      vi.mocked(dispatch).mock.calls.some(([name]) => name === "clipboard:copy-file")
    ).toBe(false);
  });

  it("copyImagePresetPath copies the rendered file's path (clipboard:copy-path)", () => {
    copyImagePresetPath("cap_2", "high");
    expect(dispatch).toHaveBeenCalledWith("clipboard:copy-path", {
      captureId: "cap_2",
      preset: "high"
    });
  });
});
