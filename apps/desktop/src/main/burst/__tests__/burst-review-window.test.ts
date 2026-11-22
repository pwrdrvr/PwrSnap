// Closing one Burst Review window decides for THAT burst only, and a quit
// that was called off leaves closing exactly as it was before the quit:
// with stills unkept, it asks first.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Guard = { needsConfirm: () => boolean; onClosed: () => void };

const h = vi.hoisted(() => ({
  appListeners: new Map<string, Array<() => void>>(),
  quitCancelled: [] as Array<() => void>,
  guards: new Map<string, Guard>()
}));

vi.mock("electron", () => ({
  app: {
    on: (event: string, listener: () => void) => {
      const list = h.appListeners.get(event) ?? [];
      list.push(listener);
      h.appListeners.set(event, list);
    }
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) }
}));

vi.mock("../../window", () => ({
  showBurstReviewWindow: (burstId: string, guard: Guard) => {
    h.guards.set(burstId, guard);
  },
  closeBurstReviewWindow: () => undefined
}));

vi.mock("../../sizzle/sizzle-close-barrier", () => ({
  onSizzleQuitCancelled: (listener: () => void) => {
    h.quitCancelled.push(listener);
    return () => undefined;
  }
}));

const { openBurstReviewWindow } = await import("../burst-review-window");
const { BURST_TEMP_PREFIX, getBurstSessionView, openBurstSession } = await import("../burst-session");

const roots: string[] = [];

function burst(): { id: string; rootDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), BURST_TEMP_PREFIX));
  roots.push(rootDir);
  const framesDir = join(rootDir, "frames");
  mkdirSync(framesDir);
  const path = join(framesDir, "frame-000000.png");
  writeFileSync(path, "still");
  const id = openBurstSession({
    rootDir,
    framesDir,
    frames: [{ index: 0, path, utcMs: 1, width: 10, height: 10 }],
    evictedFrames: 0,
    droppedFrames: 0,
    sourceApp: null,
    sourceWindowTitle: null,
    devicePixelRatio: 1
  });
  openBurstReviewWindow(id);
  return { id, rootDir };
}

const fire = (event: string) => {
  for (const l of h.appListeners.get(event) ?? []) l();
};

beforeEach(() => h.guards.clear());

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("burst review window lifecycle", () => {
  test("a cancelled quit restores the confirm, and a close discards only its own burst", async () => {
    const a = burst();
    const b = burst();
    expect(h.guards.get(a.id)!.needsConfirm()).toBe(true);

    fire("before-quit");
    expect(h.guards.get(a.id)!.needsConfirm()).toBe(false);
    for (const l of h.quitCancelled) l();
    // Quit called off: an unkept close asks again.
    expect(h.guards.get(a.id)!.needsConfirm()).toBe(true);

    h.guards.get(a.id)!.onClosed();
    await vi.waitFor(() => expect(existsSync(a.rootDir)).toBe(false));
    expect(getBurstSessionView(b.id)).not.toBeNull();
    expect(existsSync(b.rootDir)).toBe(true);
  });

  test("during a real quit a close takes its own stills at once; will-quit takes the rest", () => {
    const a = burst();
    const b = burst();
    fire("before-quit");
    h.guards.get(a.id)!.onClosed();
    expect(existsSync(a.rootDir)).toBe(false);
    expect(existsSync(b.rootDir)).toBe(true);
    fire("will-quit");
    expect(existsSync(b.rootDir)).toBe(false);
    for (const l of h.quitCancelled) l();
  });
});
