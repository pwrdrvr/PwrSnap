// The update row's whole point is WHERE it is. AppUpdateRow.test.tsx
// proves the component behaves; nothing proved either host surface
// still mounts it, so deleting a line from TrayMenu.tsx or
// FloatOver.tsx left the suite green and the feature gone.
//
// Grep-asserting the production sources is the same guard
// tray-instant-hide.test.ts and local-agent-minting-boundary.test.ts
// use for "this call site must keep existing": a render test for the
// tray would need the whole library/hotkey/ResizeObserver harness to
// assert one element's presence.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FEATURES = join(__dirname, "..", "..");

const HOSTS: Array<{ label: string; path: string; mount: string; anchor: string }> = [
  {
    label: "tray popover",
    path: join(FEATURES, "tray", "TrayMenu.tsx"),
    mount: '<AppUpdateRow variant="tray" />',
    // Directly under the header and above Quick Capture — the offer
    // leads the popover body without displacing the primary verb.
    anchor: "ps-tray__quick"
  },
  {
    label: "post-capture toast",
    path: join(FEATURES, "float-over", "FloatOver.tsx"),
    mount: '<AppUpdateRow variant="float-over" />',
    // Under the toast header, ahead of the preview, so it never
    // competes with Edit in the footer.
    anchor: "fo__preview"
  }
];

describe("AppUpdateRow placement", () => {
  it.each(HOSTS)("$label mounts the row", ({ path, mount }) => {
    expect(readFileSync(path, "utf8")).toContain(mount);
  });

  it.each(HOSTS)("$label mounts it above $anchor", ({ path, mount, anchor }) => {
    const source = readFileSync(path, "utf8");
    expect(source.indexOf(mount)).toBeLessThan(source.indexOf(anchor));
  });

  it.each(HOSTS)("$label imports it from the update feature", ({ path }) => {
    expect(readFileSync(path, "utf8")).toContain(
      'import { AppUpdateRow } from "../update/AppUpdateRow"'
    );
  });
});
