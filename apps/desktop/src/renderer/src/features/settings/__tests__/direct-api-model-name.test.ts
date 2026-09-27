import { describe, expect, it } from "vitest";
import { suggestModelDisplayName } from "../direct-api-status";

describe("suggestModelDisplayName", () => {
  it.each([
    ["/models/bonsai/27B/Ternary-Bonsai-2-27B-PQ2_0.gguf", "Ternary-Bonsai-2-27B-PQ2_0"],
    ["C:\\models\\Example-7B-Q4.gguf", "Example-7B-Q4"],
    ["\\\\server\\models\\Example.gguf", "Example"],
    ["~/models/Example.gguf", "Example"],
    ["./models/Example.gguf", "Example"],
    ["../models/Example.gguf", "Example"],
    ["/models/Example/", "Example"],
    ["Example.GGUF", "Example"],
    ["vendor/model-name", "vendor/model-name"],
    ["model-name:latest", "model-name:latest"],
    ["/", "Custom model"]
  ])("suggests a label for %s", (modelId, expected) => {
    expect(suggestModelDisplayName(modelId)).toBe(expected);
  });

  it("fits the display-name limit after removing the directory", () => {
    expect(suggestModelDisplayName(`/models/${"x".repeat(150)}.gguf`)).toHaveLength(120);
  });
});
