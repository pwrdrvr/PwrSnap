import { describe, expect, test } from "vitest";
import { inferUpdateSelection } from "../protocol";

describe("inferUpdateSelection", () => {
  test("maps website download versions onto the matching train and track", () => {
    expect(inferUpdateSelection("1.0.1")).toEqual({
      train: "stable",
      channel: "latest"
    });
    expect(inferUpdateSelection("1.0.1-prerelease.5")).toEqual({
      train: "stable",
      channel: "prerelease"
    });
    expect(inferUpdateSelection("1.1.0-beta.2")).toEqual({
      train: "beta",
      channel: "latest"
    });
    expect(inferUpdateSelection("v1.1.0-alpha.7")).toEqual({
      train: "beta",
      channel: "prerelease"
    });
  });

  test("keeps historical 1.0.0-beta builds on Stable Latest", () => {
    expect(inferUpdateSelection("1.0.0-beta.50")).toEqual({
      train: "stable",
      channel: "latest"
    });
  });
});
