// E2E coverage for the v2 editor Phase 1 activity-bar surface
// (task #11).
//
// Behaviors under test:
//   a) Click Info pin → panel appears + persists across editor reopen.
//   b) ⌘\ (Cmd+Backslash on macOS, Ctrl+Backslash elsewhere) toggles
//      the sidebar pin.
//   c) ⌘1 / ⌘2 / ⌘3 select Info / Chat / Tool Config respectively.
//   d) After first session click, hovering an icon for ~400ms pops
//      the panel as an overlay (the NN/g + Amazon hover-pop pattern).
//   e) The stoplight coachmark shows only on the FIRST popover open;
//      after the 3s auto-dismiss writes
//      `settings.editor.coachmarks.stoplightSeen = true`, subsequent
//      opens skip it.
//
// State under test: `EditorChrome` settings ingestion + the Settings
// substrate (`editor.sidebar.pinned`, `editor.sidebar.lastSelectedPanel`,
// `editor.coachmarks.stoplightSeen`). Unit tests cover EditorChrome's
// keyboard handling + activity bar click flow against a mocked
// dispatch; this spec exercises the real file-on-disk round-trip
// through `settings:write`.

import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";
import { openEditor, seedImageCapture } from "./fixtures/editor";

test.setTimeout(120_000);

// Most modifier-driven keyboard tests work on both macOS and Linux
// because EditorChrome uses `isPrimaryAccel` (Meta on Mac, Ctrl
// elsewhere). Playwright's keyboard.press("Meta+\") emits the Mac
// chord; on Linux/xvfb we want Ctrl. Same accel-key helper as the
// app uses.
function accel(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

test.skip("editor-activity-bar: clicking Info pins the panel and persists across reopen", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "activitybar", sourceAppName: "Activity Bar Spec" });

    // FIRST OPEN: click Info → panel pins → Info content shows.
    {
      const editorWindow = await openEditor(app, captureId);
      // First-click is always pinned (per EditorChrome spec).
      await editorWindow
        .locator('[data-testid="editor-activity-bar-icon-info"]')
        .click();

      // Pinned panel appears.
      await editorWindow
        .locator('[data-testid="pse-panel-pinned"]')
        .waitFor({ state: "visible", timeout: 5_000 });
      // Info panel content — the panel renders an "Info" heading
      // (see InfoPanel.tsx).
      await expect(
        editorWindow.locator(
          '[data-testid="pse-panel-pinned"] .pse-info-title'
        )
      ).toContainText("Info");

      // Give Settings substrate time to debounce-write.
      await editorWindow.waitForTimeout(300);
      await closeEditorWindow(app, editorWindow);
    }

    // Sanity: settings.editor.sidebar reflects {pinned:true,
    // lastSelectedPanel:"info"}.
    const readResult = await app.dispatch("settings:read", {});
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.editor.sidebar.pinned).toBe(true);
      expect(readResult.value.editor.sidebar.lastSelectedPanel).toBe("info");
    }

    // SECOND OPEN: panel should be auto-pinned on Info.
    {
      const editorWindow = await openEditor(app, captureId);
      await editorWindow
        .locator('[data-testid="pse-panel-pinned"]')
        .waitFor({ state: "visible", timeout: 5_000 });
      await expect(
        editorWindow.locator(
          '[data-testid="pse-panel-pinned"] .pse-info-title'
        )
      ).toContainText("Info");
    }
  } finally {
    await app.close();
  }
});

test.skip("editor-activity-bar: accel+backslash toggles sidebar pin", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "activitybar", sourceAppName: "Activity Bar Spec" });
    const editorWindow = await openEditor(app, captureId);

    // Pin via a click first to establish the panel.
    await editorWindow
      .locator('[data-testid="editor-activity-bar-icon-info"]')
      .click();
    await editorWindow
      .locator('[data-testid="pse-panel-pinned"]')
      .waitFor({ state: "visible", timeout: 5_000 });

    // Toggle off via the shortcut.
    await editorWindow.keyboard.press(`${accel()}+\\`);
    await expect(
      editorWindow.locator('[data-testid="pse-panel-pinned"]')
    ).toHaveCount(0);

    // Toggle back on.
    await editorWindow.keyboard.press(`${accel()}+\\`);
    await editorWindow
      .locator('[data-testid="pse-panel-pinned"]')
      .waitFor({ state: "visible", timeout: 5_000 });
  } finally {
    await app.close();
  }
});

test.skip("editor-activity-bar: accel+1/2/3 select panels", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "activitybar", sourceAppName: "Activity Bar Spec" });
    const editorWindow = await openEditor(app, captureId);

    // ⌘2 — Chat. EditorChrome auto-pins on the first numeric press.
    await editorWindow.keyboard.press(`${accel()}+2`);
    await editorWindow
      .locator('[data-testid="pse-panel-pinned"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    await expect(
      editorWindow.locator('[data-testid="chat-panel"]')
    ).toHaveCount(1);
    // ChatPanel renders its title.
    await expect(
      editorWindow.locator('[data-testid="chat-panel"] .pse-chat-title')
    ).toContainText("Chat with Codex");
    // And the context chip surfaces dims + layer count.
    await expect(
      editorWindow.locator('[data-testid="chat-context"]')
    ).toContainText("capture");

    // ⌘3 — Tool Config.
    await editorWindow.keyboard.press(`${accel()}+3`);
    await expect(
      editorWindow.locator('[data-testid="tool-config-panel"]')
    ).toHaveCount(1);

    // ⌘1 — Info.
    await editorWindow.keyboard.press(`${accel()}+1`);
    await expect(
      editorWindow.locator(
        '[data-testid="pse-panel-pinned"] .pse-info-title'
      )
    ).toContainText("Info");
  } finally {
    await app.close();
  }
});

test.skip("editor-activity-bar: hover-pop opens overlay after first session click", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "activitybar", sourceAppName: "Activity Bar Spec" });
    const editorWindow = await openEditor(app, captureId);

    // First-click pins.
    const infoIcon = editorWindow.locator(
      '[data-testid="editor-activity-bar-icon-info"]'
    );
    await infoIcon.click();
    await editorWindow
      .locator('[data-testid="pse-panel-pinned"]')
      .waitFor({ state: "visible", timeout: 5_000 });

    // Click again to unpin — the panel transitions to a hover-pop
    // (visible until mouseout per the EditorChrome spec).
    await infoIcon.click();
    // The pinned panel disappears; the hover panel appears.
    await expect(
      editorWindow.locator('[data-testid="pse-panel-pinned"]')
    ).toHaveCount(0);
    await editorWindow
      .locator('[data-testid="pse-panel-hover"]')
      .waitFor({ state: "visible", timeout: 5_000 });

    // Move mouse off the panel + icon so it dismisses.
    await editorWindow.mouse.move(10, 10);
    // Grace window is 500ms; wait a bit more.
    await editorWindow.waitForTimeout(800);
    await expect(
      editorWindow.locator('[data-testid="pse-panel-hover"]')
    ).toHaveCount(0);

    // Now hover the Info icon — after the 300ms enter delay the
    // overlay should pop. Give it 600ms for slow CI.
    await infoIcon.hover();
    await editorWindow.waitForTimeout(600);
    await editorWindow
      .locator('[data-testid="pse-panel-hover"]')
      .waitFor({ state: "visible", timeout: 5_000 });
  } finally {
    await app.close();
  }
});

test.skip("editor-activity-bar: stoplight coachmark shows once then hides forever", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "activitybar", sourceAppName: "Activity Bar Spec" });
    const editorWindow = await openEditor(app, captureId);

    // First open of the popover should show the coachmark.
    await editorWindow
      .locator('.psl__edit-toolbar button[data-tool="arrow"]')
      .click();
    await editorWindow
      .locator('[data-testid="tool-caret-arrow"]')
      .click();
    await editorWindow
      .locator('[data-testid="tool-style-popover"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    const coachmark = editorWindow.locator(
      '[data-testid="coachmark-strip"]'
    );
    await coachmark.waitFor({ state: "visible", timeout: 2_000 });

    // 3s auto-dismiss + slack.
    await coachmark.waitFor({ state: "detached", timeout: 6_000 });

    // Allow settings:write debounce + broadcast to land.
    await editorWindow.waitForTimeout(400);

    // Close + reopen popover — coachmark should NOT show this time.
    await editorWindow.keyboard.press("Escape");
    await expect(
      editorWindow.locator('[data-testid="tool-style-popover"]')
    ).toHaveCount(0);

    await editorWindow
      .locator('[data-testid="tool-caret-arrow"]')
      .click();
    await editorWindow
      .locator('[data-testid="tool-style-popover"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    // No coachmark this time.
    await expect(
      editorWindow.locator('[data-testid="coachmark-strip"]')
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// ---- Shared helpers --------------------------------------------------

async function closeEditorWindow(app: LaunchedApp, win: Page): Promise<void> {
  void app;
  await win.locator(".psl__focus-close").click();
  await expect(win.locator(".psl__focus")).toHaveCount(0);
}
