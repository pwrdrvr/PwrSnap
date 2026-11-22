import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import type { CaptureEnrichment } from "@pwrsnap/shared";
import {
  COPY_LEAVE_CLOSE_MS,
  FADE_EXIT_MS,
  FloatOver,
  TUCK_EXIT_MS
} from "../FloatOver";
import { DOCK_TUCK_COUNTDOWN_MS } from "../float-over-dock-model";

// The rule: a successful click on one of the toast's own copy cards (or a
// card's FILE chip) arms the toast, and from then on every stretch with
// the pointer outside the window closes it after COPY_LEAVE_CLOSE_MS
// instead of resuming the countdown. Nothing else arms it: a failed copy,
// a ⌘1–3 shortcut, hovering. Dragging a card's file out holds it like
// hovering does. Unarmed, the countdown is exactly what it
// always was: DOCK_TUCK_COUNTDOWN_MS of pointer-outside time.

beforeEach(() => {
  // jsdom has no layout: after a drop the pointer is over nothing here.
  document.elementFromPoint = () => null;
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

// Answered and empty: nothing in flight, nothing to accept, so the only
// holds on the countdown are the pointer and whatever the steps do.
const answered: CaptureEnrichment = {
  captureId: "copy-close-capture",
  latestRunId: "copy-close-run",
  status: "completed",
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

type Step =
  | { readonly kind: "enter" }
  | { readonly kind: "leave" }
  | { readonly kind: "copy"; readonly ok: boolean; readonly via: "card" | "file" }
  | { readonly kind: "shortcut" }
  | { readonly kind: "drag" }
  | { readonly kind: "drop" }
  | { readonly kind: "wait"; readonly ms: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.constant<Step>({ kind: "enter" }),
  fc.constant<Step>({ kind: "leave" }),
  fc.record({ kind: fc.constant("copy" as const), ok: fc.boolean(), via: fc.constantFrom("card" as const, "file" as const) }),
  fc.constant<Step>({ kind: "shortcut" }),
  fc.constant<Step>({ kind: "drag" }),
  fc.constant<Step>({ kind: "drop" }),
  // Short waits land inside the 400 ms drain; long ones cross the countdown.
  fc.record({ kind: fc.constant("wait" as const), ms: fc.oneof(fc.integer({ min: 1, max: COPY_LEAVE_CLOSE_MS - 1 }), fc.integer({ min: 1, max: 3000 })) })
);

/**
 * The model, in continuous time. `deadline` is when the bar reaches zero
 * if nothing else happens, or null while the pointer holds it.
 */
type Model = {
  t: number;
  inside: boolean;
  /** A card's FILE chip is being dragged out: a hold, like hovering. */
  dragging: boolean;
  armed: boolean;
  /** Unarmed countdown time already spent outside, banked at each enter. */
  spent: number;
  runStart: number;
  deadline: number | null;
};

/** Apply a change to what holds the bar, starting or stopping a run. */
function hold(m: Model, change: Partial<Pick<Model, "inside" | "dragging">>): void {
  const wasRunning = !m.inside && !m.dragging;
  Object.assign(m, change);
  const running = !m.inside && !m.dragging;
  if (wasRunning && !running) {
    if (!m.armed) m.spent += m.t - m.runStart;
    m.deadline = null;
  } else if (!wasRunning && running) {
    m.runStart = m.t;
    m.deadline = m.armed ? m.t + COPY_LEAVE_CLOSE_MS : m.t + (DOCK_TUCK_COUNTDOWN_MS - m.spent);
  }
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

test("only a successful copy click arms it, and armed, each leave closes in COPY_LEAVE_CLOSE_MS", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(stepArb, { minLength: 1, maxLength: 14 }),
    fc.boolean(),
    async (steps, sidebarVisible) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root: Root = createRoot(container);
      const onTimeout = vi.fn();
      const onDismiss = vi.fn();
      let nextOk = true;
      const answer = () => Promise.resolve(
        nextOk ? { ok: true as const } : { ok: false as const, error: { message: "fixture failure" } }
      );
      const onCopy = vi.fn(answer);
      const onCopyPath = vi.fn(answer);
      const onDragPreset = vi.fn();
      let pulses = { low: 0, med: 0, high: 0 };
      const props = () => ({
        src: "data:image/png;base64,",
        aiEnabled: true,
        aiConsentAccepted: true,
        providerAvailable: true,
        startCountdown: true,
        dockable: true,
        sidebarVisible,
        enrichment: answered,
        copyPulses: pulses,
        onTimeout,
        onDismiss,
        onCopy,
        onCopyPath,
        onDragPreset
      });
      const exitMs = sidebarVisible ? TUCK_EXIT_MS : FADE_EXIT_MS;
      const m: Model = { t: 0, inside: false, dragging: false, armed: false, spent: 0, runStart: 0, deadline: DOCK_TUCK_COUNTDOWN_MS };
      const fo = (): HTMLElement => container.querySelector<HTMLElement>(".fo")!;
      const enter = async (): Promise<void> => {
        await act(async () => {
          fo().dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
        });
        hold(m, { inside: true });
      };
      // `buttons` is 1 while a drag holds the button down: a leave with
      // the button up is how the toast learns a drag ended.
      const leave = async (buttons = 0): Promise<void> => {
        await act(async () => {
          fo().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body, buttons }));
          window.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null, buttons }));
        });
        hold(m, { inside: false });
      };
      try {
        await act(async () => {
          root.render(createElement(FloatOver, props()));
        });
        for (const step of steps) {
          // Mid-drag the pointer is out with the file; only time and the
          // drop happen.
          if (m.dragging && step.kind !== "wait" && step.kind !== "drop") continue;
          if (step.kind === "enter") {
            await enter();
          } else if (step.kind === "leave") {
            await leave();
          } else if (step.kind === "drag") {
            // Press on a FILE chip, drag it out of the window.
            await enter();
            const chip = container.querySelector<HTMLElement>(".fo__copy-file")!;
            await act(async () => {
              chip.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
            });
            hold(m, { dragging: true });
            await leave(1);
          } else if (step.kind === "drop") {
            if (!m.dragging) continue;
            await act(async () => {
              window.dispatchEvent(new MouseEvent("dragend", { clientX: -10, clientY: -10 }));
            });
            hold(m, { dragging: false });
          } else if (step.kind === "copy") {
            // A click needs the pointer on the card.
            await enter();
            nextOk = step.ok;
            const target = container.querySelector<HTMLElement>(
              step.via === "card" ? ".fo__copy-btn" : ".fo__copy-file"
            )!;
            await act(async () => {
              target.click();
            });
            if (step.ok) m.armed = true;
          } else if (step.kind === "shortcut") {
            // Main copies on ⌘1–3; the toast only replays the card's flash.
            pulses = { ...pulses, med: pulses.med + 1 };
            await act(async () => {
              root.render(createElement(FloatOver, props()));
            });
          } else {
            const end = m.t + step.ms;
            if (m.deadline !== null && end >= m.deadline) {
              // The bar reaches zero in this wait: it closes within one
              // frame of the deadline, after the exit animation.
              await settle(step.ms);
              const deadline = m.deadline;
              if (end < deadline + exitMs) expect(onTimeout).not.toHaveBeenCalled();
              await settle(Math.max(0, deadline + 16 + exitMs + 1 - end));
              expect(onTimeout).toHaveBeenCalledTimes(1);
              expect(onDismiss).not.toHaveBeenCalled();
              return;
            }
            await settle(step.ms);
            m.t = end;
          }
          expect(onTimeout).not.toHaveBeenCalled();
        }
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  ), { numRuns: 120 });
}, 60_000);

test("a close onto the edge tabs folds; a dismiss and a close with the tabs hidden fade", async () => {
  for (const [sidebarVisible, expectFold] of [[true, true], [false, false]] as const) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onTimeout = vi.fn();
    try {
      await act(async () => {
        root.render(createElement(FloatOver, {
          src: "data:image/png;base64,",
          aiEnabled: true,
          aiConsentAccepted: true,
          providerAvailable: true,
          dockable: true,
          sidebarVisible,
          enrichment: answered,
          onTimeout,
          onCopy: () => Promise.resolve({ ok: true as const })
        }));
      });
      const fo = container.querySelector<HTMLElement>(".fo")!;
      await act(async () => {
        fo.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      });
      await act(async () => {
        container.querySelector<HTMLElement>(".fo__copy-btn")!.click();
      });
      await act(async () => {
        fo.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
        window.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null }));
      });
      await settle(COPY_LEAVE_CLOSE_MS + 16);
      expect(fo.classList.contains("is-exiting")).toBe(true);
      expect(fo.classList.contains("is-tucking")).toBe(expectFold);
      expect(onTimeout).not.toHaveBeenCalled();
      await settle(TUCK_EXIT_MS);
      expect(onTimeout).toHaveBeenCalledExactlyOnceWith({ inFlight: false });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }

  // ✕ removes the snap, so it fades even with the tabs showing.
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onDismiss = vi.fn();
  try {
    await act(async () => {
      root.render(createElement(FloatOver, {
        src: "data:image/png;base64,",
        dockable: true,
        sidebarVisible: true,
        enrichment: answered,
        onTimeout: vi.fn(),
        onDismiss
      }));
    });
    await act(async () => {
      container.querySelector<HTMLElement>('button[aria-label="Dismiss"]')!.click();
    });
    const fo = container.querySelector<HTMLElement>(".fo")!;
    expect(fo.classList.contains("is-exiting")).toBe(true);
    expect(fo.classList.contains("is-tucking")).toBe(false);
    await settle(FADE_EXIT_MS);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
