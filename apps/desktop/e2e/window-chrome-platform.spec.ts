// Platform window chrome: who reserves room for OS buttons, and where.
//
// Two halves have to agree, and neither can see the other:
//
//   • main (`platformWindowChrome` in src/main/window.ts) decides whether the
//     window has a frame, and on macOS insets the traffic lights INTO our own
//     52px title bar via `titleBarStyle: "hiddenInset"`.
//   • the renderer pads that bar out of the way — `--mac-traffic-light-reserve`
//     on macOS, `--win-caption-reserve` on Windows, nothing on Linux.
//
// `macos-traffic-light-position.test.ts` pins those numbers against each other
// by reading the source. What it cannot see is the cascade actually resolving
// in a real renderer, which depends on the `data-platform` attribute that
// index.html's inline script sets from the preload bridge. If that attribute
// goes missing, every stylesheet falls back to the unreserved base rule and
// macOS draws its traffic lights over the first control. So this spec asserts
// the attribute AND the pixels, on whatever platform it runs.
//
// It is deliberately platform-parametric rather than `test.skip`-ed to one OS:
// the defect it was written for was Linux-only (the reservation used to live on
// the base rule with only a win32 opt-out, so Linux opened every window with
// 92px of dead top bar), and the Linux Desktop E2E job is the only place that
// gets exercised automatically.

import type { Page } from "@playwright/test";

import { expect, launchPwrSnap, test } from "./fixtures/electron-app";

/** Content inset every chrome bar uses when it has no OS buttons to clear. */
const RAIL_INSET_PX = 16;
/** `--mac-traffic-light-reserve` — room for the 60pt button group at x=16. */
const MAC_RESERVE_PX = 92;

/** What the left edge of the bar's first control should clear, here. */
const EXPECTED_LEFT_PX = process.platform === "darwin" ? MAC_RESERVE_PX : RAIL_INSET_PX;

type BarMeasurement = {
  platformAttr: string | null;
  paddingLeft: string;
  firstControlOffset: number;
};

/**
 * Measure a chrome bar's left inset two ways: the computed padding, and the
 * offset the user actually sees on the first thing in the bar. The second is
 * the invariant — padding is only how we currently spell it.
 */
async function measureBar(page: Page, barSelector: string): Promise<BarMeasurement> {
  await page.waitForSelector(barSelector, { timeout: 15_000 });
  return page.evaluate((selector) => {
    const bar = document.querySelector(selector);
    if (bar === null) throw new Error(`no ${selector}`);
    const first = bar.firstElementChild;
    if (first === null) throw new Error(`${selector} has no content`);
    return {
      platformAttr: document.documentElement.getAttribute("data-platform"),
      paddingLeft: getComputedStyle(bar).paddingLeft,
      firstControlOffset: first.getBoundingClientRect().left - bar.getBoundingClientRect().left
    };
  }, barSelector);
}

function expectPlatformInset(measured: BarMeasurement, label: string): void {
  // The reservation is keyed off this attribute. A stylesheet scoped to a value
  // nothing sets is a stylesheet that never applies.
  expect(measured.platformAttr, label).toBe(process.platform);
  expect(measured.paddingLeft, label).toBe(`${EXPECTED_LEFT_PX}px`);
  expect(measured.firstControlOffset, label).toBeCloseTo(EXPECTED_LEFT_PX, 0);
}

test("the library top bar reserves traffic-light room on macOS only", async () => {
  const app = await launchPwrSnap();
  try {
    expectPlatformInset(await measureBar(app.window, ".psl__topbar"), ".psl__topbar");
  } finally {
    await app.close();
  }
});

test("secondary windows follow the same rule, and Linux paints its own chrome", async () => {
  // One launch covers two things: a second stylesheet (`.pss__titlebar` lives
  // in settings.css, not library.css) and the rest of the Linux chrome, which
  // needs a second window to show that the posture is per-window and not a
  // property of the Library alone.
  const app = await launchPwrSnap();
  try {
    const opened = await app.dispatch("settings:open", {});
    expect(opened.ok).toBe(true);

    const deadline = Date.now() + 15_000;
    let settings: Page | undefined;
    while (settings === undefined && Date.now() < deadline) {
      settings = app.electronApp
        .windows()
        .find((candidate) => candidate.url().includes("stage=settings"));
      if (settings === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (settings === undefined) throw new Error("settings window never appeared");
    await settings.waitForLoadState("domcontentloaded").catch(() => undefined);

    expectPlatformInset(await measureBar(settings, ".pss__titlebar"), ".pss__titlebar");

    // Linux is frameless: `titleBarStyle: "hidden"` is `frame: false` there, so
    // the OS draws no title bar, no caption buttons, and — because
    // `RootView::SetMenu` returns early on `!has_frame()` — no menu bar. Every
    // one of those is now ours to paint, and nothing but this job runs on the
    // platform where that is true.
    if (process.platform === "linux") {
      const nativeMenuBars = await app.electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((win) => !win.isDestroyed())
          .map((win) => ({ url: win.webContents.getURL(), visible: win.isMenuBarVisible() }))
      );
      for (const win of nativeMenuBars) {
        expect(win.visible, `native menu bar on ${win.url}`).toBe(false);
      }

      // The Library paints the menu the native bar would have carried. Settings
      // does not, exactly as on Windows — `menu: "hidden"`.
      await app.window.waitForSelector(".psl__menubar", { timeout: 15_000 });
      expect(await settings.locator(".psl__menubar").count()).toBe(0);

      // The hairline that stands in for the border a frameless window is given
      // none of. Stamped before the first paint, on every window kind.
      for (const [page, label] of [
        [app.window, "library"],
        [settings, "settings"]
      ] as const) {
        expect(
          await page.evaluate(() => document.documentElement.dataset["windowFrame"]),
          label
        ).toBe("restored");

        // And the edge itself, not just the attribute it keys off. Three
        // files have to agree for a pixel to appear — App.tsx stamps
        // `data-chrome` from the shared stage list, library.css matches it,
        // and window-frame.ts stamps `data-window-frame` — and nothing but
        // this job runs where the result is visible.
        const edge = await page.evaluate(() => {
          const root = document.getElementById("root");
          if (root === null) return null;
          const style = getComputedStyle(root, "::after");
          return {
            chrome: document.body.dataset["chrome"],
            content: style.content,
            borderTopWidth: style.borderTopWidth,
            pointerEvents: style.pointerEvents
          };
        });
        expect(edge, label).not.toBeNull();
        expect(edge?.chrome, label).toBe("window");
        // `content: none` is what a rule that did not match leaves behind.
        expect(edge?.content, label).not.toBe("none");
        expect(edge?.borderTopWidth, label).toBe("1px");
        // It sits over every pane, so it must swallow no click — including
        // the frameless resize border just inside these bounds.
        expect(edge?.pointerEvents, label).toBe("none");
      }

      // The caption buttons, end to end — in the two halves that are OURS.
      //
      // Not asserted here: that `maximize()` maximizes. Maximizing is a window
      // manager operation (`_NET_WM_STATE_MAXIMIZED`), and this job runs under
      // bare `xvfb` with no WM at all, so the call lands nowhere and
      // `isMaximized()` stays false forever. An earlier draft polled on it and
      // timed out after 10s against a perfectly working build. What the WM
      // does with the request is the platform's business; what has to be right
      // is the wire on either side of it.

      // Half one — main's push reaches the glyph. `trackWindowFrameState`
      // reads `isMaximized()` when the event fires, so the stub is what a
      // working WM would have made true by then.
      const emitFrameEvent = async (event: "maximize" | "unmaximize", maximized: boolean) =>
        app.electronApp.evaluate(
          ({ BrowserWindow }, { name, value, urlPart }) => {
            const win = BrowserWindow.getAllWindows().find(
              (candidate) =>
                !candidate.isDestroyed() &&
                candidate.webContents.getURL().includes(urlPart) &&
                !candidate.webContents.getURL().includes("stage=")
            );
            if (win === undefined) throw new Error("library BrowserWindow missing");
            win.isMaximized = () => value;
            win.emit(name);
          },
          { name: event, value: maximized, urlPart: "/renderer/index.html" }
        );

      await emitFrameEvent("maximize", true);
      await expect(app.window.getByRole("button", { name: "Restore" })).toBeVisible();
      // ...and the hairline stands down: a maximized window has no edge left.
      await expect
        .poll(() => app.window.evaluate(() => document.documentElement.dataset["windowFrame"]), {
          timeout: 10_000
        })
        .toBe("maximized");

      await emitFrameEvent("unmaximize", false);
      await expect(app.window.getByRole("button", { name: "Maximize" })).toBeVisible();
      await expect
        .poll(() => app.window.evaluate(() => document.documentElement.dataset["windowFrame"]), {
          timeout: 10_000
        })
        .toBe("restored");

      // Half two — a painted button's click reaches the real BrowserWindow.
      // Close is the one control that needs no WM, and the one worth being
      // surest of: on Linux it is the only way to close the window from
      // inside the app.
      const settingsWindowCount = async (): Promise<number> =>
        app.electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter(
            (win) => !win.isDestroyed() && win.webContents.getURL().includes("stage=settings")
          ).length
        );
      expect(await settingsWindowCount()).toBe(1);
      await settings.getByRole("button", { name: "Close" }).click();
      await expect.poll(settingsWindowCount, { timeout: 10_000 }).toBe(0);
    }
  } finally {
    await app.close();
  }
});
