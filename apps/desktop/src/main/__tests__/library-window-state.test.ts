import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  defaultLibraryWindowBounds,
  fitLibraryWindowBoundsToWorkArea,
  readLibraryWindowBounds,
  writeLibraryWindowBounds
} from "../library-window-state";

describe("Library window bounds", () => {
  it("shrinks and centers the first-launch frame inside a smaller Windows work area", () => {
    expect(defaultLibraryWindowBounds({ x: 0, y: 0, width: 1226, height: 1014 })).toEqual({
      x: 0,
      y: 27,
      width: 1226,
      height: 960
    });
  });

  it("preserves a previously sized frame that still fits", () => {
    expect(
      fitLibraryWindowBoundsToWorkArea(
        { x: 140, y: 90, width: 900, height: 700 },
        { x: 0, y: 0, width: 1920, height: 1040 }
      )
    ).toEqual({ x: 140, y: 90, width: 900, height: 700 });
  });

  it("re-clamps an oversized off-screen restore after the display changes", () => {
    expect(
      fitLibraryWindowBoundsToWorkArea(
        { x: 1500, y: -400, width: 1440, height: 960 },
        { x: 0, y: 40, width: 1280, height: 680 }
      )
    ).toEqual({ x: 0, y: 40, width: 1280, height: 680 });
  });

  it("supports displays positioned to the left of the primary display", () => {
    expect(
      fitLibraryWindowBoundsToWorkArea(
        { x: -1800, y: 100, width: 1000, height: 700 },
        { x: -1920, y: 0, width: 1920, height: 1040 }
      )
    ).toEqual({ x: -1800, y: 100, width: 1000, height: 700 });
  });
});

describe("Library window state persistence", () => {
  it("round-trips the last normal bounds through the atomic state file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-window-state-"));
    const filePath = join(dir, "library-window-state.json");
    const bounds = { x: 10, y: 20, width: 840, height: 620 };

    writeLibraryWindowBounds(filePath, bounds);

    expect(readLibraryWindowBounds(filePath)).toEqual(bounds);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      schemaVersion: 1,
      normalBounds: bounds
    });
  });

  it("quarantines malformed state and falls back to first launch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-window-state-"));
    const filePath = join(dir, "library-window-state.json");
    await writeFile(filePath, "{not-json", "utf8");

    expect(readLibraryWindowBounds(filePath)).toBeNull();
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^library-window-state\.json\.corrupt-.+\.json$/);
  });
});
