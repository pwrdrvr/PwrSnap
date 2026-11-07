import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import type { CaptureEnrichment } from "@pwrsnap/shared";
import { FloatOver } from "../FloatOver";
import { DOCK_TUCK_COUNTDOWN_MS } from "../float-over-dock-model";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "Date"]
  });
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const running: CaptureEnrichment = {
  captureId: "countdown-capture",
  latestRunId: "countdown-run",
  status: "running",
  error: null,
  ocrText: null,
  suggestedTitle: null,
  acceptedTitle: null,
  titleAcceptedAt: null,
  suggestedFilenameStem: null,
  acceptedFilenameStem: null,
  filenameAcceptedAt: null,
  suggestedDescription: null,
  acceptedDescription: null,
  descriptionAcceptedAt: null,
  suggestedTags: [],
  acceptedTags: []
};

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

// Promise: enrichment can update the contents, but cannot replenish the
// countdown. The oracle is the deadline established before the answer.
test("enrichment settlement preserves progress and the original deadline", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 64, max: DOCK_TUCK_COUNTDOWN_MS - 64 }),
    fc.constantFrom("completed", "failed", "cancelled"),
    fc.boolean(),
    fc.boolean(),
    async (arrivalMs, status, autoAccept, sidebarVisible) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const onTimeout = vi.fn();
      const props = {
        src: "data:image/png;base64,",
        aiEnabled: true,
        aiConsentAccepted: true,
        providerAvailable: true,
        startCountdown: true,
        dockable: true,
        autoAcceptSuggestions: autoAccept,
        sidebarVisible,
        onTimeout
      };
      const progress = () => container.querySelector<HTMLElement>(".fo__progress-fill")?.style.transform;
      try {
        await act(async () => {
          root.render(createElement(FloatOver, { ...props, enrichment: running }));
        });
        await advance(arrivalMs);
        const before = progress();
        expect(before).toBeDefined();
        const completed = status === "completed";
        const accepted = completed && autoAccept;
        await act(async () => {
          root.render(createElement(FloatOver, {
            ...props,
            enrichment: {
              ...running,
              status,
              suggestedTitle: completed ? "Fixture title" : null,
              suggestedDescription: completed ? "Fixture description" : null,
              acceptedTitle: accepted ? "Fixture title" : null,
              acceptedDescription: accepted ? "Fixture description" : null,
              titleAcceptedAt: accepted ? new Date().toISOString() : null,
              descriptionAcceptedAt: accepted ? new Date().toISOString() : null,
              acceptedTags: accepted ? ["fixture"] : []
            }
          }));
        });
        expect(progress()).toBe(before);
        await advance(DOCK_TUCK_COUNTDOWN_MS - arrivalMs - 32);
        expect(onTimeout).not.toHaveBeenCalled();
        // Allow one animation frame and the existing 220ms exit animation.
        await advance(300);
        expect(onTimeout).toHaveBeenCalledExactlyOnceWith({ inFlight: false });
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  ), { numRuns: 50 });
});
