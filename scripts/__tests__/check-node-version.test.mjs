import { describe, expect, test } from "vitest";
import { nodeVersionSatisfies } from "../check-node-version.mjs";

describe("nodeVersionSatisfies (^<.nvmrc>)", () => {
  test("the pinned version and anything newer in its major pass", () => {
    expect(nodeVersionSatisfies("v24.21.0", "v24.21.0")).toBe(true);
    expect(nodeVersionSatisfies("v24.21.4", "v24.21.0")).toBe(true);
    expect(nodeVersionSatisfies("v24.30.0", "v24.21.0")).toBe(true);
  });

  test("an older version in the same major fails", () => {
    expect(nodeVersionSatisfies("v24.20.9", "v24.21.0")).toBe(false);
    expect(nodeVersionSatisfies("v24.21.0", "v24.21.1")).toBe(false);
  });

  test("another major fails in either direction", () => {
    expect(nodeVersionSatisfies("v25.0.0", "v24.21.0")).toBe(false);
    expect(nodeVersionSatisfies("v22.30.0", "v24.21.0")).toBe(false);
  });

  test(".nvmrc may pin only a major or a minor, with or without the v", () => {
    expect(nodeVersionSatisfies("v24.0.1", "24")).toBe(true);
    expect(nodeVersionSatisfies("v24.20.0", "v24.21")).toBe(false);
    expect(nodeVersionSatisfies("24.21.0", "24.21.0\n")).toBe(true);
  });

  test("an unreadable pin fails closed", () => {
    expect(nodeVersionSatisfies("v24.21.0", "lts/*")).toBe(false);
    expect(nodeVersionSatisfies("v24.21.0", "")).toBe(false);
  });
});
