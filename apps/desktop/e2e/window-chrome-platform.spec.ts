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

test("secondary windows follow the same rule", async () => {
  // A second stylesheet: `.pss__titlebar` lives in settings.css, not
  // library.css, and each of the four chrome bars carries its own copy of the
  // reservation rules.
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

  } finally {
    await app.close();
  }
});
