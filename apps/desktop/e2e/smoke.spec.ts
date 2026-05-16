// Smoke test — boots the packaged main entry against an isolated
// HOME, opens the library window, asserts the masthead renders and
// the command bus is reachable.
//
// This is the cheapest possible "did anything regress" test — if the
// app fails to boot at all (preload misconfig, bad IPC channel, native
// module ABI mismatch), every other E2E spec falls over too. So we
// run this first; the rest are gated implicitly on the fixture's
// launch succeeding.

import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

test("library window boots and renders the brand mark", async () => {
  const app = await launchPwrSnap();
  try {
    // The wordmark splits "Pwr" + "Snap" across two spans (so the
    // accent on "Snap" survives any flex gap). Match by the SVG mark's
    // aria-label, which is a single accessible token.
    await expect(app.window.getByRole("img", { name: "PwrSnap" }).first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("library storage popover exposes cache controls", async () => {
  const app = await launchPwrSnap();
  try {
    await app.window.locator(".psl__storage-trigger").click();
    const popover = app.window.getByRole("dialog", { name: "Storage usage" });
    await expect(popover).toBeVisible();
    await expect(popover.getByText("App Cache")).toBeVisible();
    await expect(popover.getByText("Render Sizes Cache")).toBeVisible();
    await expect(popover.getByRole("button", { name: "Trim" })).toBeVisible();
    await expect(popover.getByText("Documents/PwrSnap")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("library:list returns an empty head page on a fresh HOME", async () => {
  // Exercises the command bus end-to-end through the E2E bridge —
  // proves the dispatcher, the library handler, and the Result envelope
  // are wired correctly without depending on any platform-specific
  // subsystem (TCC, screencapture, etc.).
  //
  // `library:list` returns a keyset-paginated head page:
  //   { rows, nextCursor, appStats?, totalLive? }
  // On a clean HOME `rows` is empty, `nextCursor` is null, and the
  // head-only fields report zero live captures.
  const app = await launchPwrSnap();
  try {
    const result = await app.dispatch("library:list", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value.rows)).toBe(true);
      expect(result.value.rows).toHaveLength(0);
      expect(result.value.nextCursor).toBeNull();
      expect(result.value.totalLive ?? 0).toBe(0);
    }
  } finally {
    await app.close();
  }
});

test("dispatching an unknown command surfaces a typed error", async () => {
  // The command bus' contract is "always return a Result envelope" —
  // even a typo in the channel name should land as `result.ok=false`,
  // not a thrown exception, so renderer callers don't need defensive
  // try/catch around every dispatch.
  const app = await launchPwrSnap();
  try {
    const result = await app.dispatch(
      "definitely:not:a:command" as never,
      {} as never
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.code).toBe("string");
      expect(typeof result.error.message).toBe("string");
    }
  } finally {
    await app.close();
  }
});
