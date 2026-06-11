// Catalog integrity. The sidebar / router / shared protocol must
// agree on the set of page ids — this test fails the build if any
// id is unrecognized, or if the design's catalog drifts away from
// the handoff bundle.

import { describe, expect, test } from "vitest";
import type { SettingsPage } from "@pwrsnap/shared";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_PAGES_FLAT,
  SETTINGS_PAGE_IDS
} from "../settings-categories";

// Mirrors packages/shared/src/protocol.ts's `SettingsPage` union.
// Keeping a local literal copy lets us assert that the catalog is a
// total cover of the union — if anyone adds a member to the union,
// this list will need an update too, which is exactly the lock we
// want.
const ALL_PAGE_IDS = [
  "general",
  "hotkeys",
  "ai",
  "local-agents",
  "system-permissions",
  "storage",
  "about"
] as const satisfies readonly SettingsPage[];

describe("SETTINGS_CATEGORIES", () => {
  test("every id is a valid SettingsPage", () => {
    const valid = new Set<string>(ALL_PAGE_IDS);
    for (const cat of SETTINGS_CATEGORIES) {
      for (const item of cat.items) {
        expect(valid.has(item.id)).toBe(true);
      }
    }
  });

  test("every SettingsPage is represented exactly once", () => {
    const flatIds = SETTINGS_PAGES_FLAT.map((i) => i.id);
    expect(new Set(flatIds).size).toBe(flatIds.length);
    for (const id of ALL_PAGE_IDS) {
      expect(flatIds).toContain(id);
    }
  });

  test("structure matches the catalog", () => {
    expect(SETTINGS_CATEGORIES.map((c) => c.group)).toEqual([
      "General",
      "Capture",
      "Library",
      "Advanced"
    ]);

    const byGroup = Object.fromEntries(
      SETTINGS_CATEGORIES.map((c) => [c.group, c.items.map((i) => i.id)])
    );

    expect(byGroup["General"]).toEqual(["general", "hotkeys", "ai", "local-agents"]);
    expect(byGroup["Capture"]).toEqual(["system-permissions"]);
    expect(byGroup["Library"]).toEqual(["storage"]);
    expect(byGroup["Advanced"]).toEqual(["about"]);
  });

  test("SETTINGS_PAGE_IDS exposes the same id set", () => {
    expect(SETTINGS_PAGE_IDS.size).toBe(ALL_PAGE_IDS.length);
    for (const id of ALL_PAGE_IDS) {
      expect(SETTINGS_PAGE_IDS.has(id)).toBe(true);
    }
  });
});
