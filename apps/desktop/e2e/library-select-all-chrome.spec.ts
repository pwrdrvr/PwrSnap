// App chrome is not selectable — Select All regression spec.
//
// The Library, tray, float-over and settings surfaces are UI: labels,
// counts, chips, timestamps. Left selectable (the CSS initial value), a
// native Select All sweeps the ENTIRE window into one text selection and
// repaints every one of them in the OS selection blue — because nothing
// intercepts it outside the editor canvas. `role: "selectAll"` in the Edit
// menu (src/main/index.ts) hands ⌘A straight to Blink, and the Library's
// own keydown handler bails on any modifier. The wash then STICKS: it
// survives Escape, view changes and navigation, clearing only when the
// user happens to click something that is itself selectable.
//
// The fix is `body { user-select: none }` in styles/app.css plus explicit
// per-surface opt-ins wherever the text IS the content. Both halves are
// pinned here: the second test is what fails if someone ever "simplifies"
// the rule to `* { user-select: none }`, which would take the caret,
// double-click-to-word and drag-select out of every text field in the app.
//
// Scope: the Library window only. The tray, float-over and settings
// surfaces are stages of the SAME renderer bundle, so they load the same
// app.css and the rule reaches them by construction — but nothing here
// asserts that, so a stage-specific stylesheet could still regress them.
//
// The first test drives `webContents.selectAll()` from the main process
// rather than `document.execCommand` in the page: that is the exact call
// Electron's `role: "selectAll"` menu item makes, so the spec exercises
// the path the user's keypress actually takes.

import { expect, launchPwrSnap, type LaunchedApp, test } from "./fixtures/electron-app";

// `launchPwrSnap` resolves on `domcontentloaded`, which is BEFORE React
// mounts — evaluating straight away races an empty `#root`. Every test
// below waits on a real element first.
const SEARCH_INPUT = "input.psl__search";

async function waitForLibraryMount(app: LaunchedApp): Promise<void> {
  await app.window.waitForSelector(SEARCH_INPUT, { state: "attached", timeout: 30_000 });
}

/** Run the Edit ▸ Select All menu role against the library window. */
async function selectAllViaMenuRole(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => {
      if (candidate.isDestroyed()) return false;
      const url = candidate.webContents.getURL();
      return url.includes("/renderer/index.html") && !url.includes("stage=");
    });
    if (win === undefined) throw new Error("library BrowserWindow missing");
    win.webContents.selectAll();
  });
}

test("Select All in the Library selects no chrome text", async () => {
  const app = await launchPwrSnap();
  try {
    await waitForLibraryMount(app);

    await app.window.evaluate(() => document.getSelection()?.removeAllRanges());
    await selectAllViaMenuRole(app);

    // selectAll() crosses main → renderer, so the selection lands a tick
    // later. Poll rather than sleep; a non-empty read fails immediately.
    await expect
      .poll(async () =>
        app.window.evaluate(() => ({
          bodyUserSelect: getComputedStyle(document.body).userSelect,
          // Guards against a vacuous pass: an empty selection proves
          // nothing if the window painted no text in the first place.
          renderedTextLength: document.body.innerText.trim().length,
          selected: document.getSelection()?.toString() ?? ""
        }))
      )
      .toEqual(
        expect.objectContaining({
          bodyUserSelect: "none",
          selected: ""
        })
      );

    const rendered = await app.window.evaluate(() => document.body.innerText.trim().length);
    expect(rendered).toBeGreaterThan(50);
  } finally {
    await app.close();
  }
});

test("text fields opt back in to selection", async () => {
  const app = await launchPwrSnap();
  try {
    await waitForLibraryMount(app);

    const result = await app.window.evaluate((selector) => {
      const input = document.querySelector<HTMLInputElement>(selector);
      if (input === null) throw new Error(`library rendered no ${selector}`);
      // Chromium inherits `user-select: none` into form controls, so the
      // app-wide default has to be undone explicitly for them.
      const userSelect = getComputedStyle(input).userSelect;
      // `.psl__search` is a CONTROLLED React input — write past its state
      // only for the length of this measurement, then put back exactly
      // what was there rather than assuming it started empty.
      const original = input.value;
      input.focus();
      input.value = "hello world";
      input.select();
      const selectedLength = (input.selectionEnd ?? 0) - (input.selectionStart ?? 0);
      input.value = original;
      input.blur();
      return { userSelect, selectedLength, disabled: input.disabled };
    }, SEARCH_INPUT);

    // A disabled field cannot be selected, so the length assertion below
    // would fail for a reason that has nothing to do with the CSS.
    expect(result.disabled).toBe(false);
    expect(result.userSelect).toBe("text");
    expect(result.selectedLength).toBe("hello world".length);
  } finally {
    await app.close();
  }
});

test("error text opts back in to selection", async () => {
  const app = await launchPwrSnap();
  try {
    await waitForLibraryMount(app);

    // Error surfaces are conditional, so probe the rule rather than
    // waiting for a failure to happen: an alert-role node must resolve to
    // selectable text, and a control inside it must not.
    const result = await app.window.evaluate(() => {
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      const button = document.createElement("button");
      alert.append(button);
      document.body.append(alert);
      const measured = {
        alertUserSelect: getComputedStyle(alert).userSelect,
        buttonUserSelect: getComputedStyle(button).userSelect
      };
      alert.remove();
      return measured;
    });

    expect(result.alertUserSelect).toBe("text");
    expect(result.buttonUserSelect).toBe("none");
  } finally {
    await app.close();
  }
});
