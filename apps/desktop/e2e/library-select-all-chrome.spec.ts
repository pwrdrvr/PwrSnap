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

import { expect, launchPwrSnap, test } from "./fixtures/electron-app";

test("Select All in the Library selects no chrome text", async () => {
  const app = await launchPwrSnap();
  try {
    const result = await app.window.evaluate(() => {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      document.execCommand("selectAll");
      const selected = selection?.toString() ?? "";
      selection?.removeAllRanges();
      return {
        bodyUserSelect: getComputedStyle(document.body).userSelect,
        // Guards against a vacuous pass: an empty selection proves nothing
        // if the window painted no text in the first place.
        renderedTextLength: (document.body.innerText ?? "").trim().length,
        selected
      };
    });

    expect(result.renderedTextLength).toBeGreaterThan(50);
    expect(result.bodyUserSelect).toBe("none");
    expect(result.selected).toBe("");
  } finally {
    await app.close();
  }
});

test("text fields opt back in to selection", async () => {
  const app = await launchPwrSnap();
  try {
    const result = await app.window.evaluate(() => {
      const input = document.querySelector("input");
      if (input === null) throw new Error("library rendered no text input");
      // Chromium inherits `user-select: none` into form controls, so the
      // app-wide default has to be undone explicitly for them.
      input.focus();
      input.value = "hello world";
      input.select();
      const selectedLength = (input.selectionEnd ?? 0) - (input.selectionStart ?? 0);
      input.value = "";
      input.blur();
      return { inputUserSelect: getComputedStyle(input).userSelect, selectedLength };
    });

    expect(result.inputUserSelect).toBe("text");
    expect(result.selectedLength).toBe("hello world".length);
  } finally {
    await app.close();
  }
});
