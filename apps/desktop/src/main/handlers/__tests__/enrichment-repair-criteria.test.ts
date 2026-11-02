// `codex:repair:*` takes its criteria from a renderer, so they are rebuilt
// from checked parts rather than passed through.

import { describe, expect, test } from "vitest";

import { parseRepairConcurrency, parseRepairCriteria } from "../enrichment-repair-handlers";

const valid = {
  statuses: ["failed", "never", "failed"],
  since: "2026-10-01T00:00:00.000Z",
  until: null,
  apps: { mode: "exclude", appIds: ["com.apple.safari", "", "com.apple.safari"] }
};

describe("parseRepairCriteria", () => {
  test("keeps a valid request, de-duplicated", () => {
    expect(parseRepairCriteria(valid)).toEqual({
      statuses: ["failed", "never"],
      since: "2026-10-01T00:00:00.000Z",
      until: null,
      apps: { mode: "exclude", appIds: ["com.apple.safari", ""] }
    });
  });

  test.each([
    ["no statuses", { ...valid, statuses: [] }],
    ["an unknown status", { ...valid, statuses: ["completed"] }],
    ["a bad date", { ...valid, since: "yesterday" }],
    ["an unknown app mode", { ...valid, apps: { mode: "only", appIds: [] } }],
    ["a non-string app id", { ...valid, apps: { mode: "include", appIds: [7] } }],
    ["too many apps", { ...valid, apps: { mode: "include", appIds: Array.from({ length: 501 }, (_, i) => `a${i}`) } }],
    ["no object", null]
  ])("refuses %s", (_label, raw) => {
    expect(parseRepairCriteria(raw)).toBeNull();
  });
});

describe("window bounds", () => {
  test("are rewritten as the UTC ISO form captured_at is stored in, since the repo compares strings", () => {
    const parsed = parseRepairCriteria({ ...valid, since: "2026-10-01T00:00:00+05:00", until: "2026-10-02" });
    expect(parsed?.since).toBe("2026-09-30T19:00:00.000Z");
    expect(parsed?.until).toBe("2026-10-02T00:00:00.000Z");
    expect(parseRepairCriteria({ ...valid, since: "not a date" })).toBeNull();
  });
});

describe("parseRepairConcurrency", () => {
  test("omitted means one; 1–8 whole numbers pass; anything else is refused", () => {
    expect(parseRepairConcurrency(undefined)).toBe(1);
    expect(parseRepairConcurrency(4)).toBe(4);
    expect(parseRepairConcurrency(8)).toBe(8);
    for (const bad of [0, 9, 2.5, -1, "4", null, Number.NaN]) {
      expect(parseRepairConcurrency(bad)).toBeNull();
    }
  });
});
