import { describe, expect, test } from "vitest";
import { buildPresetExportDisplayName, exportFilenameStem } from "../export-filename";

const record = {
  id: "cap_123",
  source_app_name: "Safari"
};

describe("export display filenames", () => {
  test("uses the enrichment suggested filename stem plus preset and extension", () => {
    expect(
      buildPresetExportDisplayName({
        record,
        enrichment: {
          acceptedFilenameStem: null,
          suggestedFilenameStem: "checkout-flow-success"
        },
        preset: "low",
        ext: "mp4"
      })
    ).toBe("checkout-flow-success-low.mp4");
  });

  test("accepted filename stem overrides the suggested stem", () => {
    expect(
      buildPresetExportDisplayName({
        record,
        enrichment: {
          acceptedFilenameStem: "manual-export-name",
          suggestedFilenameStem: "codex-export-name"
        },
        preset: "med",
        ext: ".PNG"
      })
    ).toBe("manual-export-name-med.png");
  });

  test("falls back to source app or capture id when no enrichment stem exists", () => {
    expect(exportFilenameStem(record, null)).toBe("safari");
    expect(exportFilenameStem({ id: "cap_456", source_app_name: null }, null)).toBe("cap-456");
    expect(exportFilenameStem({ id: "cap_789", source_app_name: "///" }, null)).toBe("cap-789");
  });
});
