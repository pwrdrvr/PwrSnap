// Concurrency contract for the HTML text bake's pool window.
//
// The pool BrowserWindow is a SINGLETON — one shared instance reused
// across bakes for performance (window construction is ~50-200ms).
// When the bake pipeline runs serially (one capture at a time) that's
// fine, but the renderer fans out across captures:
//
//   • Library grid: thumbnails for every visible capture render in
//     parallel as the user scrolls.
//   • Capture flow: the new capture's thumbnail + flat composite +
//     paste-format render kick off together.
//
// `BrowserWindow.loadURL` cancels any in-flight load on the same
// webContents — the cancelled promise rejects with
// `ERR_ABORTED (-3)`. Two parallel `rasterizeTextHtmlForV2` calls on
// the singleton therefore race: one wins, the other's `loadURL`
// promise rejects, and the bake fails.
//
// User-visible symptom (logged on PR #129 after the highlight fix):
//   01:32:50.486 (pwrsnap:protocols) cache handler threw {
//     captureId, width, format,
//     message: "ERR_ABORTED (-3) loading 'data:text/html;...'"
//   }
//   01:32:50.721 (pwrsnap:compose-tree) rendered v2  ← a parallel
//                                                       bake that
//                                                       won the race
//
// Fix: serialize all pool-window operations through a module-level
// promise queue. This test pins both the SERIALIZATION (no two
// `loadURL` calls in flight at once on the pool) and the OUTCOME
// (every parallel bake call resolves, no ERR_ABORTED).
//
// We can't exercise a real Electron BrowserWindow under vitest, so
// this test mocks `electron` with a BrowserWindow stub that:
//   1. Tracks how many `loadURL` calls are in flight.
//   2. If a second loadURL arrives while one is in flight, it
//      simulates Chromium's behavior — rejects the FIRST call's
//      promise with the literal `ERR_ABORTED (-3)` message and
//      starts the SECOND. Mirrors `webContents.loadURL` semantics.
//
// Pre-fix this stub catches the race: parallel callers see
// `Promise.allSettled` with at least one rejection. Post-fix the
// queue eliminates the race entirely; the in-flight counter never
// exceeds 1 and every promise resolves.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Overlay } from "@pwrsnap/shared";

// ---------------------------------------------------------------------
// Electron mock — a minimal BrowserWindow that races loadURL like the
// real one does.
// ---------------------------------------------------------------------

interface LoadInFlight {
  url: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

let activeLoad: LoadInFlight | null = null;
let maxConcurrentLoads = 0;
const completedLoadUrls: string[] = [];

// A valid 1×1 transparent PNG so `capturePage().toPNG()` returns
// something sharp can decode without complaint. Bytes generated via
// `sharp({create:{width:1,height:1,channels:4,background:transparent}}).png().toBuffer()`
// and hardcoded so the test stays sync-readable.
const TINY_PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000970485973000003e8000003e801b57b526b" +
    "0000000d49444154789c6360606060000000050001a5f64540" +
    "0000000049454e44ae426082",
  "hex"
);

vi.mock("electron", () => {
  class FakeBrowserWindow {
    public webContents: {
      executeJavaScript: (js: string) => Promise<unknown>;
      capturePage: () => Promise<{ toPNG: () => Buffer }>;
    };
    private destroyed = false;
    constructor(_opts: unknown) {
      this.webContents = {
        executeJavaScript: vi.fn(async (_js: string) => true as unknown),
        capturePage: vi.fn(async () => ({
          toPNG: () => TINY_PNG_BYTES
        }))
      };
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    setContentSize(_w: number, _h: number): void {
      // No-op — only the URL races matter for this test.
    }
    async loadURL(url: string): Promise<void> {
      // Mirror Chromium's behavior: a second loadURL kills the first.
      // The first call's promise rejects with ERR_ABORTED, the second
      // proceeds. We use a microtask-deferred resolve so the test can
      // schedule another loadURL before this one completes.
      if (activeLoad !== null) {
        activeLoad.reject(
          new Error(`ERR_ABORTED (-3) loading '${activeLoad.url}'`)
        );
      }
      maxConcurrentLoads = Math.max(maxConcurrentLoads, 1);
      const self: LoadInFlight = {
        url,
        resolve: () => undefined,
        reject: () => undefined
      };
      activeLoad = self;
      return new Promise<void>((resolve, reject) => {
        self.resolve = resolve;
        self.reject = reject;
        // Defer resolution to the next macrotask so concurrent callers
        // have a chance to interfere via setTimeout(0).
        setTimeout(() => {
          if (activeLoad === self) {
            activeLoad = null;
            completedLoadUrls.push(url);
            resolve();
          }
        }, 5);
      });
    }
    close(): void {
      this.destroyed = true;
    }
  }
  return { BrowserWindow: FakeBrowserWindow };
});

// Imported AFTER the mock so it picks up the stub BrowserWindow.
const { rasterizeTextHtmlForV2, destroyTextBakePool } = await import(
  "../text-html-bake"
);

function textOverlay(body: string): Extract<Overlay, { kind: "text" }> {
  return {
    kind: "text",
    point: { x: 0.5, y: 0.5 },
    body,
    size: "medium",
    color: "#000000"
  };
}

beforeEach(() => {
  activeLoad = null;
  maxConcurrentLoads = 0;
  completedLoadUrls.length = 0;
});

afterEach(() => {
  destroyTextBakePool();
});

describe("text-html-bake concurrency: parallel rasterize calls share the pool safely", () => {
  test("8 parallel rasterize calls all resolve (none ERR_ABORTED)", async () => {
    // 8 captures rendering text overlays in parallel — well above the
    // realistic library-grid fan-out, comfortably catches the race.
    // Pre-fix: 7 of the 8 (all but the last to call loadURL) reject
    // with ERR_ABORTED -3.
    const calls = Array.from({ length: 8 }, (_unused, i) =>
      rasterizeTextHtmlForV2(textOverlay(`row ${i}`), 100, 50, 100, 50, 100, 50)
    );
    const results = await Promise.allSettled(calls);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(
      rejected,
      `Parallel rasterizeTextHtmlForV2 calls must all resolve. Pre-fix ` +
        `the singleton pool window's setContentSize/loadURL/capturePage ` +
        `isn't serialized, so the second concurrent call's loadURL ` +
        `cancels the first with ERR_ABORTED -3. Got ${rejected.length} ` +
        `rejections: ${rejected
          .map((r) => (r.status === "rejected" ? String(r.reason) : ""))
          .join("; ")}`
    ).toHaveLength(0);
  });

  test("pool loadURL never has more than one call in flight at a time", async () => {
    // The serialization contract: even at high parallelism, only one
    // bake at a time uses the pool window's webContents. Tracks the
    // FakeBrowserWindow.maxConcurrentLoads counter — pre-fix it goes
    // to 2+ (every parallel caller fires its loadURL immediately).
    await Promise.all(
      Array.from({ length: 6 }, (_unused, i) =>
        rasterizeTextHtmlForV2(textOverlay(`x${i}`), 80, 40, 80, 40, 80, 40)
      )
    );
    expect(
      maxConcurrentLoads,
      `Pool window's loadURL must be serialized — only one bake at a ` +
        `time. Saw ${maxConcurrentLoads} concurrent loadURL calls.`
    ).toBe(1);
    expect(completedLoadUrls).toHaveLength(6);
  });
});
