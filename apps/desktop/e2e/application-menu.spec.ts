// The installed application menu, end to end: what `installApplicationMenu`
// actually hands Electron, on whatever platform the run is on, plus the two
// Help items whose behavior lives in main (About, Copy Diagnostics Info).
//
// The full per-platform layout of the PwrSuite menu standard is pinned by
// the pure-builder unit test (src/main/__tests__/application-menu.test.ts),
// which checks darwin, linux and win32 on any host. This spec proves the
// wiring: that the menu Electron is running is that builder's output.

import { expect, launchPwrSnap, test, type LaunchedApp } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

type MenuShape = { label: string; type: string; items: string[] }[];

async function readMenu(app: LaunchedApp): Promise<MenuShape> {
  return await app.electronApp.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((item) => ({
      label: item.label,
      type: item.type,
      items: (item.submenu?.items ?? []).map((child) =>
        child.type === "separator" ? "---" : child.label
      )
    }))
  );
}

/** Click a menu item by label wherever it sits — the same item a person
 *  clicks, not the bus verb behind it. */
async function clickMenuItem(app: LaunchedApp, label: string): Promise<void> {
  await app.electronApp.evaluate(({ Menu }, wanted) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      const item = top.submenu?.items.find((candidate) => candidate.label === wanted);
      if (item !== undefined) {
        item.click();
        return;
      }
    }
    throw new Error(`Menu item not found: ${wanted}`);
  }, label);
}

test.describe("application menu (PwrSuite menu standard)", () => {
  test("installs File · Edit · View · Library · Window · Help in that order", async () => {
    const app = await launchPwrSnap();
    try {
      const menu = await readMenu(app);
      const labels = menu.map((item) => item.label);
      // macOS leads with the app menu, named after the app.
      expect(labels).toEqual(
        isMac
          ? [labels[0], "File", "Edit", "View", "Library", "Window", "Help"]
          : ["File", "Edit", "View", "Library", "Window", "Help"]
      );

      const help = menu.find((item) => item.label === "Help")?.items;
      expect(help).toEqual([
        "PwrSnap Documentation",
        "Changelog",
        "---",
        "Report an Issue…",
        "Report a Security Vulnerability…",
        "Copy Diagnostics Info",
        "Logs",
        "---",
        "PwrSnap Website",
        "View Source",
        "---",
        "View License",
        "Third-Party Notices",
        ...(isMac ? [] : ["---", "Check for Updates…", "About PwrSnap"])
      ]);

      const view = menu.find((item) => item.label === "View")?.items;
      expect(view?.[0]).toBe("Reload Window");

      if (isMac) {
        expect(menu[0]?.items.slice(0, 2)).toEqual(["About PwrSnap", "Check for Updates…"]);
      } else {
        const file = menu.find((item) => item.label === "File")?.items ?? [];
        // The quit role keeps Electron's platform label: "Exit" on Windows.
        const quit = process.platform === "win32" ? "Exit" : "Quit";
        expect(file.slice(-4)).toEqual(["Settings…", "---", "Close Window", quit]);
      }
    } finally {
      await app.close();
    }
  });

  test("About PwrSnap opens Settings on the About page", async () => {
    const app = await launchPwrSnap();
    try {
      await clickMenuItem(app, "About PwrSnap");
      await expect
        .poll(
          () => app.electronApp.windows().find((page) => page.url().includes("stage=settings"))?.url(),
          { timeout: 15_000 }
        )
        .toContain("page=about");
    } finally {
      await app.close();
    }
  });

  test("Copy Diagnostics Info copies the build identity and confirms it", async () => {
    const app = await launchPwrSnap();
    try {
      await app.electronApp.evaluate(({ clipboard }) => clipboard.writeText(""));
      await clickMenuItem(app, "Copy Diagnostics Info");

      // Observe the transient confirmation immediately. Keep the startup
      // interaction: preload must retain a notice until React subscribes.
      await expect(app.window.locator(".app-toast-stack .app-notice")).toHaveText(
        "Diagnostics info copied"
      );

      const copied = await app.electronApp.evaluate(({ clipboard }) => clipboard.readText());
      const lines = copied.split("\n");
      expect(lines[0]).toMatch(/^PwrSnap \S+$/);
      expect(lines.slice(1).map((line) => line.split(":")[0])).toEqual([
        "Build",
        "Platform",
        "Electron",
        "Chrome",
        "Node"
      ]);
    } finally {
      await app.close();
    }
  });
});
