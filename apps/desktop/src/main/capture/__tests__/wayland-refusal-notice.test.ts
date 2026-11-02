// The refusal has to reach the screen, and it has to leave the user
// somewhere to go.
//
// Both halves are regressions, not hypotheticals. The first version of the
// Wayland refusal explained itself from `capture-trigger.ts`, which only the
// global hotkeys and the native tray menu route through — so the Library's
// Quick Capture button, which dispatches over IPC and voids the promise,
// became a button that did nothing at all on Ubuntu. And a modal that says
// "use Full Screen instead" and then makes the user go find Full Screen is
// the same dead end wearing a hat.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  dispatch: vi.fn(),
  warn: vi.fn()
}));

vi.mock("electron", () => ({ dialog: { showMessageBox: mocks.showMessageBox } }));
vi.mock("../../command-bus", () => ({ bus: { dispatch: mocks.dispatch } }));
vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: () => undefined,
    warn: mocks.warn,
    error: () => undefined,
    debug: () => undefined
  })
}));

const { showWaylandRefusalNotice } = await import("../wayland-refusal-notice");

/** The notice is fire-and-forget by design, so tests have to wait out its
 *  own promise chain — including the compositor settle before the grab. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue({ ok: true, value: {} });
});

afterEach(async () => {
  // Let any in-flight notice release its re-entrancy guard before the next
  // test, or a later `expect(showMessageBox).toHaveBeenCalled()` fails for
  // reasons that have nothing to do with what it is testing.
  await settle();
});

describe("Wayland refusal notice", () => {
  test("explains the refusal and offers the capture that works here", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    showWaylandRefusalNotice();
    await settle();

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    const [options] = mocks.showMessageBox.mock.calls[0] as [Electron.MessageBoxOptions];
    expect(options.buttons?.[0]).toBe("Capture Full Screen");
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(1);
    // The headline is the part everyone reads. It must name the condition
    // actually refused — a single-display Wayland session is NOT refused, so
    // "needs an X11 session" (an earlier draft) would be false for it.
    expect(options.message).toContain("more than one display");
    // The detail is the only place the user is told WHY, so it must carry
    // the way out rather than only the refusal.
    expect(options.detail).toContain("Full Screen");
    expect(options.detail).toContain("X11");
    // Only measured claims: the probe disproved the overlay-placement one.
    expect(options.detail).not.toContain("overlay");
  });

  test("Cancel captures nothing", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    showWaylandRefusalNotice();
    await settle();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  test("Capture Full Screen runs the capture that Wayland does support", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    showWaylandRefusalNotice();
    await settle();

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch.mock.calls[0]?.[0]).toBe("capture:fullScreen");
  });

  test("a failed Full Screen capture is reported on screen, not only in the log", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    mocks.dispatch.mockResolvedValue({
      ok: false,
      error: { kind: "capture", code: "failed", message: "grab is of something else" }
    });
    showWaylandRefusalNotice();
    await settle();

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
    const [options] = mocks.showMessageBox.mock.calls[1] as [Electron.MessageBoxOptions];
    expect(options.detail).toBe("grab is of something else");
  });

  test("a repeated trigger does not stack alerts", async () => {
    // A held-down hotkey would otherwise queue one modal per repeat, and the
    // user would have to dismiss every one of them.
    let release: (value: { response: number }) => void = () => undefined;
    mocks.showMessageBox.mockReturnValue(
      new Promise<{ response: number }>((resolve) => {
        release = resolve;
      })
    );

    showWaylandRefusalNotice();
    showWaylandRefusalNotice();
    showWaylandRefusalNotice();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);

    release({ response: 1 });
    await settle();

    // ...and the guard reopens once the user has answered.
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    showWaylandRefusalNotice();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });

  test("a dialog that fails to show does not wedge the guard shut", async () => {
    mocks.showMessageBox.mockRejectedValue(new Error("no display"));
    showWaylandRefusalNotice();
    await settle();
    expect(mocks.warn).toHaveBeenCalled();

    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    showWaylandRefusalNotice();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });
});
