import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

test.skip(process.platform !== "win32", "Library bounds persistence is Windows-only");
test.setTimeout(60_000);

test("Library restores the last normal bounds after it is closed and reopened", async () => {
  const app = await launchPwrSnap();
  try {
    const desired = await app.electronApp.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return url.includes("/renderer/index.html") && !url.includes("stage=");
      });
      if (win === undefined) throw new Error("missing Library window");
      const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
      const width = Math.min(820, workArea.width);
      const height = Math.min(640, workArea.height);
      const bounds = {
        x: Math.round(workArea.x + (workArea.width - width) / 2),
        y: Math.round(workArea.y + (workArea.height - height) / 2),
        width,
        height
      };
      win.setBounds(bounds);
      return bounds;
    });

    const nextLibrary = app.electronApp.waitForEvent("window", {
      predicate: async (page) => (await page.title()) === "PwrSnap"
    });
    const libraryClosed = app.window.waitForEvent("close");
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return url.includes("/renderer/index.html") && !url.includes("stage=");
      });
      if (win === undefined) throw new Error("missing Library window");
      win.close();
    });
    await libraryClosed;

    const statePath = path.join(app.homeRoot, "library-window-state.json");
    await expect
      .poll(async () => {
        const stored = JSON.parse(await readFile(statePath, "utf8")) as {
          normalBounds: { x: number; y: number; width: number; height: number };
        };
        return stored.normalBounds;
      })
      .toEqual(desired);

    const focus = await app.dispatch("library:focus", {});
    expect(focus.ok).toBe(true);
    const reopened = await nextLibrary;
    await reopened.waitForLoadState("domcontentloaded");

    const restored = await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return url.includes("/renderer/index.html") && !url.includes("stage=");
      });
      if (win === undefined) throw new Error("missing reopened Library window");
      return win.getNormalBounds();
    });
    expect(restored).toEqual(desired);
  } finally {
    await app.close();
  }
});
