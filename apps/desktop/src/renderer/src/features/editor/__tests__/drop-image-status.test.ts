import { describe, expect, test } from "vitest";
import type { PwrSnapError } from "@pwrsnap/shared";
import { formatDropProgress, formatDropSummary } from "../drop-image-status";
import type { DropImageFailure, DropImageSummary } from "../useDropImage";

const formatError = (error: { code: string; message: string }): string =>
  error.message;

function failure(fileIndex: number, message: string): DropImageFailure {
  const error: PwrSnapError = {
    kind: "validation",
    code: `failure_${fileIndex}`,
    message
  };
  return { fileIndex, fileName: `file-${fileIndex}.png`, error };
}

describe("drop image status", () => {
  test("shows exact live batch counts and the original gesture size", () => {
    expect(
      formatDropProgress({
        requestedCount: 20,
        attemptedCount: 16,
        processedCount: 6,
        importedCount: 4,
        failedCount: 2,
        truncatedCount: 4
      })
    ).toBe("Importing 7 of 16 · 4 imported · 2 failed · 20 dropped");
  });

  test("reports a complete batch without implying a partial result", () => {
    const summary: DropImageSummary = {
      requestedCount: 2,
      attemptedCount: 2,
      importedLayerIds: ["one", "two"],
      failures: [],
      truncatedCount: 0
    };
    expect(formatDropSummary(summary, formatError)).toBe("Imported 2 images");
  });

  test("reports exact partial counts, grouped errors, and truncation", () => {
    const summary: DropImageSummary = {
      requestedCount: 20,
      attemptedCount: 16,
      importedLayerIds: Array.from({ length: 13 }, (_, index) => `layer-${index}`),
      failures: [
        failure(1, "Unsupported image format"),
        failure(2, "Unsupported image format"),
        failure(3, "Image failed to decode")
      ],
      truncatedCount: 4
    };
    expect(formatDropSummary(summary, formatError)).toBe(
      "Imported 13 of 20 images · 3 failed: Unsupported image format (2); Image failed to decode · 4 not attempted (16-file limit)"
    );
  });
});
