import { describe, expect, test } from "vitest";

import { parseEnrichmentRepairOpenRequest } from "../enrichment-repair-open-request";

describe("parseEnrichmentRepairOpenRequest", () => {
  test("no request is an empty one", () => {
    expect(parseEnrichmentRepairOpenRequest(undefined)).toEqual({});
    expect(parseEnrichmentRepairOpenRequest({})).toEqual({});
  });

  test("statuses and a preset pass through, deduplicated", () => {
    expect(parseEnrichmentRepairOpenRequest({ statuses: ["failed", "failed", "never"], window: "all" })).toEqual({
      statuses: ["failed", "never"],
      window: "all"
    });
  });

  test("an exact range is rebuilt as canonical ISO", () => {
    expect(
      parseEnrichmentRepairOpenRequest({
        window: { since: "2026-10-07T10:42:00Z", until: "2026-10-07T11:20:00.000Z" }
      })
    ).toEqual({ window: { since: "2026-10-07T10:42:00.000Z", until: "2026-10-07T11:20:00.000Z" } });
    expect(parseEnrichmentRepairOpenRequest({ window: { since: "2026-10-07T10:42:00Z", until: null } })).toEqual({
      window: { since: "2026-10-07T10:42:00.000Z", until: null }
    });
  });

  test.each([
    ["not an object", "failed"],
    ["empty statuses", { statuses: [] }],
    ["unknown status", { statuses: ["failed", "other"] }],
    ["unknown preset", { window: "1y" }],
    ["unparseable since", { window: { since: "yesterday", until: null } }],
    ["missing until", { window: { since: "2026-10-07T10:42:00Z" } }],
    ["backwards range", { window: { since: "2026-10-07T11:00:00Z", until: "2026-10-07T10:00:00Z" } }],
    ["window of the wrong type", { window: 30 }]
  ])("refuses %s", (_label, raw) => {
    expect(parseEnrichmentRepairOpenRequest(raw)).toBeNull();
  });
});
