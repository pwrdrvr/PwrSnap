import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from "vitest";
import type { ShortcutPlatform } from "@pwrsnap/shared";
import {
  HotkeyCapture,
  accelFromKeyboardEvent,
  interpretHotkeyEvent
} from "../HotkeyCapture";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

async function successfulLeaseDispatch(
  name: string,
  req: Record<string, unknown>
): Promise<{
  ok: true;
  value: Record<string, unknown>;
}> {
  return {
    ok: true as const,
    value:
      name === "settings:beginHotkeyRecording"
        ? {
            sessionId: req.sessionId,
            generation: req.generation,
            accepted: true,
            expiresAt: Date.now() + 120_000
          }
        : { ended: true }
  };
}

const leaseDispatch = vi.fn(successfulLeaseDispatch);

beforeEach(() => {
  leaseDispatch.mockReset();
  leaseDispatch.mockImplementation(successfulLeaseDispatch);
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: { platform: "win32", dispatch: leaseDispatch }
  });
});

function keyEvent(
  type: "keydown" | "keyup",
  init: KeyboardEventInit & { key: string },
  altGraph = false
): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  if (altGraph) {
    Object.defineProperty(event, "getModifierState", {
      configurable: true,
      value: (modifier: string): boolean => modifier === "AltGraph"
    });
  }
  return event;
}

describe("interpretHotkeyEvent", () => {
  test("uses explicit macOS Command and Windows Control semantics", () => {
    expect(
      accelFromKeyboardEvent(
        keyEvent("keydown", { key: "c", code: "KeyC", metaKey: true, shiftKey: true }),
        "darwin"
      )
    ).toBe("Command+Shift+C");
    expect(
      accelFromKeyboardEvent(
        keyEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true }),
        "win32"
      )
    ).toBe("Control+Shift+C");
  });

  test.each(["MetaLeft", "MetaRight"])("Windows %s records Super/Windows", (code) => {
    expect(
      accelFromKeyboardEvent(
        keyEvent("keydown", { key: "c", code: "KeyC", metaKey: true, shiftKey: true }),
        "win32"
      )
    ).toBe("Super+Shift+C");
    expect(
      interpretHotkeyEvent(
        keyEvent("keydown", { key: "Meta", code, metaKey: true }),
        "win32"
      )
    ).toEqual({ kind: "intermediate", accelerator: "Super" });
  });

  test("does not collapse Control plus Windows into one modifier", () => {
    expect(
      accelFromKeyboardEvent(
        keyEvent("keydown", {
          key: "c",
          code: "KeyC",
          ctrlKey: true,
          metaKey: true
        }),
        "win32"
      )
    ).toBe("Control+Super+C");
  });

  test("normalizes AltGr explicitly instead of saving bogus Control+Alt", () => {
    expect(
      accelFromKeyboardEvent(
        keyEvent(
          "keydown",
          { key: "@", code: "KeyQ", ctrlKey: true, altKey: true },
          true
        ),
        "win32"
      )
    ).toBe("AltGr+Q");
    expect(
      interpretHotkeyEvent(
        keyEvent("keydown", {
          key: "AltGraph",
          code: "AltRight",
          ctrlKey: true,
          altKey: true
        }),
        "win32"
      )
    ).toEqual({ kind: "intermediate", accelerator: "AltGr" });
  });

  test("the physical AltRight fallback carries AltGr into the character event", () => {
    const final = keyEvent("keydown", {
      key: "@",
      code: "KeyQ",
      ctrlKey: true,
      altKey: true
    });
    expect(accelFromKeyboardEvent(final, "win32", true)).toBe("AltGr+Q");
  });

  test.each(["ControlLeft", "ControlRight"])(
    "accepts modifier-only intermediate state from %s",
    (code) => {
      expect(
        interpretHotkeyEvent(
          keyEvent("keydown", { key: "Control", code, ctrlKey: true }),
          "win32"
        )
      ).toEqual({ kind: "intermediate", accelerator: "Control" });
    }
  );

  test("ignores repeats and composition, and Escape always cancels", () => {
    expect(
      interpretHotkeyEvent(
        keyEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, repeat: true }),
        "win32"
      )
    ).toEqual({ kind: "ignore" });
    expect(
      interpretHotkeyEvent(
        keyEvent("keydown", {
          key: "Process",
          code: "KeyC",
          ctrlKey: true,
          isComposing: true
        }),
        "win32"
      ).kind
    ).toBe("reject");
    expect(
      interpretHotkeyEvent(
        keyEvent("keydown", {
          key: "Escape",
          code: "Escape",
          ctrlKey: true,
          altKey: true,
          metaKey: true,
          repeat: true
        }),
        "win32"
      )
    ).toEqual({ kind: "cancel" });
  });

  test.each(["Backspace", "Delete"])("bare %s guides to explicit Clear", (key) => {
    const decision = interpretHotkeyEvent(keyEvent("keydown", { key, code: key }), "win32");
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.message).toMatch(/Clear button/);
  });

  test("normalizes Plus without creating an ambiguous ++ accelerator", () => {
    expect(
      accelFromKeyboardEvent(
        keyEvent("keydown", {
          key: "+",
          code: "Equal",
          ctrlKey: true,
          shiftKey: true
        }),
        "win32"
      )
    ).toBe("Control+Shift+Plus");
  });

  test("uses physical code for Option-modified non-ASCII characters", () => {
    expect(
      accelFromKeyboardEvent(
        keyEvent("keydown", {
          key: "ç",
          code: "KeyC",
          metaKey: true,
          altKey: true
        }),
        "darwin"
      )
    ).toBe("Command+Alt+C");
  });

  test.each([
    { layout: "QWERTZ", key: "z", code: "KeyY", expected: "Control+Z" },
    { layout: "AZERTY", key: "a", code: "KeyQ", expected: "Control+A" }
  ])("uses layout-aware event.key on $layout", ({ key, code, expected }) => {
    expect(
      accelFromKeyboardEvent(
        keyEvent("keydown", { key, code, ctrlKey: true }),
        "win32"
      )
    ).toBe(expected);
  });

  test("translates named keys and rejects unmodified or unsupported keys", () => {
    expect(
      accelFromKeyboardEvent(
        keyEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true }),
        "win32"
      )
    ).toBe("Control+Return");
    expect(
      accelFromKeyboardEvent(
        keyEvent("keydown", { key: "ArrowUp", code: "ArrowUp", metaKey: true }),
        "win32"
      )
    ).toBe("Super+Up");
    expect(
      interpretHotkeyEvent(keyEvent("keydown", { key: "c", code: "KeyC" }), "win32")
        .kind
    ).toBe("reject");
    expect(
      interpretHotkeyEvent(
        keyEvent("keydown", { key: "Dead", code: "", ctrlKey: true }),
        "win32"
      ).kind
    ).toBe("reject");
  });
});

type HarnessProps = {
  platform?: ShortcutPlatform;
  initialValue?: string;
  commit?: (next: string) => Promise<void>;
  unbind?: () => Promise<void>;
  onCancel?: () => void;
};

function Harness({
  platform = "win32",
  initialValue = "Control+Shift+C",
  commit = async () => undefined,
  unbind = async () => undefined,
  onCancel = () => undefined
}: HarnessProps): ReactElement {
  const [recording, setRecording] = useState(false);
  const [value, setValue] = useState(initialValue);
  return createElement(HotkeyCapture, {
    label: "Quick Capture",
    value,
    platform,
    recording,
    onStart: () => setRecording(true),
    onCancel: () => {
      onCancel();
      setRecording(false);
    },
    onCommit: async (next: string) => {
      await commit(next);
      setValue(next);
      setRecording(false);
    },
    onUnbind: async () => {
      await unbind();
      setValue("");
    }
  });
}

function TwoRecorderHarness({
  commitA,
  commitB
}: {
  commitA: (next: string) => Promise<void>;
  commitB: (next: string) => Promise<void>;
}): ReactElement {
  const [active, setActive] = useState<"a" | "b" | null>(null);
  const recorder = (
    id: "a" | "b",
    label: string,
    commit: (next: string) => Promise<void>
  ): ReactElement =>
    createElement(HotkeyCapture, {
      label,
      value: id === "a" ? "Control+Shift+C" : "Control+Shift+R",
      platform: "win32",
      recording: active === id,
      onStart: () => setActive(id),
      onCancel: () => setActive((current) => (current === id ? null : current)),
      onCommit: async (next: string) => {
        await commit(next);
        setActive((current) => (current === id ? null : current));
      },
      onUnbind: async () => undefined
    });

  return createElement(
    "div",
    null,
    recorder("a", "Quick Capture", commitA),
    recorder("b", "Region", commitB)
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderHarness(props: HarnessProps = {}): Promise<HTMLDivElement> {
  return renderElement(createElement(Harness, props));
}

async function renderElement(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

async function click(selector: string): Promise<void> {
  const button = container?.querySelector<HTMLButtonElement>(selector);
  if (button === null || button === undefined) throw new Error(`Missing ${selector}`);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function dispatch(event: KeyboardEvent): Promise<void> {
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  Reflect.deleteProperty(window, "pwrsnapApi");
  vi.useRealTimers();
});

describe("HotkeyCapture lifecycle", () => {
  test("does not arm or capture keys until native shortcut suspension resolves", async () => {
    const commit = vi.fn(async () => undefined);
    const pending: {
      request?: Record<string, unknown>;
      settle?: (value: Awaited<ReturnType<typeof successfulLeaseDispatch>>) => void;
    } = {};
    leaseDispatch.mockImplementation((name, req) => {
      if (name !== "settings:beginHotkeyRecording") {
        return successfulLeaseDispatch(name, req);
      }
      pending.request = req;
      return new Promise((resolve) => {
        pending.settle = resolve;
      });
    });
    const view = await renderHarness({ commit });

    await click(".pss__hk-capture-trigger");
    expect(view.textContent).toContain("Preparing recorder");
    await dispatch(
      keyEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true })
    );
    await dispatch(
      keyEvent("keyup", { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true })
    );
    expect(commit).not.toHaveBeenCalled();
    expect(view.querySelector(".pss__hk-capture.is-recording")).toBeNull();

    const request = pending.request;
    const settle = pending.settle;
    if (request === undefined || settle === undefined) {
      throw new Error("Missing pending native suspension request");
    }
    await act(async () => {
      settle({
        ok: true,
        value: {
          sessionId: request.sessionId,
          generation: request.generation,
          accepted: true,
          expiresAt: Date.now() + 120_000
        }
      });
      await Promise.resolve();
    });
    expect(view.querySelector(".pss__hk-capture.is-recording")).not.toBeNull();

    await dispatch(
      keyEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true })
    );
    await dispatch(
      keyEvent("keyup", { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true })
    );
    expect(commit).toHaveBeenCalledWith("Control+Shift+C");
  });

  test("records Ctrl+Shift+C on key release and displays Windows labels", async () => {
    const commit = vi.fn(async () => undefined);
    const view = await renderHarness({ initialValue: "", commit });
    await click(".pss__hk-capture-trigger");
    expect(view.textContent).toContain("Press a combination now");
    expect(view.textContent).toContain("Ctrl");
    expect(view.textContent).not.toContain("⌘");

    await dispatch(
      keyEvent("keydown", {
        key: "c",
        code: "KeyC",
        ctrlKey: true,
        shiftKey: true
      })
    );
    expect(commit).not.toHaveBeenCalled();
    expect(view.textContent).toContain("Release to save");
    await dispatch(
      keyEvent("keyup", {
        key: "c",
        code: "KeyC",
        ctrlKey: true,
        shiftKey: true
      })
    );
    expect(commit).toHaveBeenCalledWith("Control+Shift+C");
    expect(document.activeElement).toBe(view.querySelector(".pss__hk-capture-trigger"));
    expect(leaseDispatch.mock.calls.map(([name]) => name)).toEqual([
      "settings:beginHotkeyRecording",
      "settings:endHotkeyRecording"
    ]);
  });

  test("left/right modifier release keeps then clears live preview", async () => {
    const view = await renderHarness();
    await click(".pss__hk-capture-trigger");
    await dispatch(
      keyEvent("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true })
    );
    expect(view.querySelector(".pss__hk-capture-keys")?.className).toContain("is-live");
    expect(view.textContent).toContain("Keep holding and press another key");
    await dispatch(
      keyEvent("keydown", { key: "Control", code: "ControlRight", ctrlKey: true })
    );
    await dispatch(
      keyEvent("keyup", { key: "Control", code: "ControlRight", ctrlKey: true })
    );
    expect(view.querySelector(".pss__hk-capture-keys")?.className).toContain("is-live");
    await dispatch(
      keyEvent("keyup", { key: "Control", code: "ControlLeft", ctrlKey: false })
    );
    expect(view.querySelector(".pss__hk-capture-keys")?.className).toContain("is-example");
    expect(view.textContent).toContain("Press a combination now");
  });

  test("swallows recorder keydown and keyup before same-window listeners", async () => {
    await renderHarness();
    await click(".pss__hk-capture-trigger");
    const laterKeyDown = vi.fn();
    const laterKeyUp = vi.fn();
    window.addEventListener("keydown", laterKeyDown, { capture: true });
    window.addEventListener("keyup", laterKeyUp, { capture: true });
    try {
      await dispatch(
        keyEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true })
      );
      await dispatch(
        keyEvent("keyup", { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true })
      );
      expect(laterKeyDown).not.toHaveBeenCalled();
      expect(laterKeyUp).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", laterKeyDown, { capture: true });
      window.removeEventListener("keyup", laterKeyUp, { capture: true });
    }
  });

  test("starting row B supersedes row A so only B can save the chord", async () => {
    const commitA = vi.fn(async () => undefined);
    const commitB = vi.fn(async () => undefined);
    const view = await renderElement(createElement(TwoRecorderHarness, { commitA, commitB }));
    const triggers = view.querySelectorAll<HTMLButtonElement>(".pss__hk-capture-trigger");
    expect(triggers).toHaveLength(2);
    await act(async () => triggers[0]?.click());
    expect(view.querySelector('[aria-label="Cancel recording Quick Capture"]')).not.toBeNull();
    await act(async () => triggers[1]?.click());
    expect(view.querySelectorAll(".pss__hk-capture.is-recording")).toHaveLength(1);
    expect(view.querySelector('[aria-label="Cancel recording Region"]')).not.toBeNull();

    await dispatch(
      keyEvent("keydown", { key: "r", code: "KeyR", ctrlKey: true, shiftKey: true })
    );
    await dispatch(
      keyEvent("keyup", { key: "r", code: "KeyR", ctrlKey: true, shiftKey: true })
    );
    expect(commitA).not.toHaveBeenCalled();
    expect(commitB).toHaveBeenCalledWith("Control+Shift+R");
    const begins = leaseDispatch.mock.calls.filter(
      ([name]) => name === "settings:beginHotkeyRecording"
    );
    const ends = leaseDispatch.mock.calls.filter(
      ([name]) => name === "settings:endHotkeyRecording"
    );
    expect(begins).toHaveLength(2);
    expect(begins[0]?.[1].sessionId).not.toBe(begins[1]?.[1].sessionId);
    expect(ends.map(([, req]) => req.sessionId)).toContain(begins[0]?.[1].sessionId);
  });

  test("a delayed stale begin for row A cannot arm over row B", async () => {
    const commitA = vi.fn(async () => undefined);
    const commitB = vi.fn(async () => undefined);
    const delayed: {
      request?: Record<string, unknown>;
      settle?: (value: Awaited<ReturnType<typeof successfulLeaseDispatch>>) => void;
    } = {};
    leaseDispatch.mockImplementation((name, req) => {
      if (name !== "settings:beginHotkeyRecording") {
        return successfulLeaseDispatch(name, req);
      }
      if (delayed.request === undefined) {
        delayed.request = req;
        return new Promise((resolve) => {
          delayed.settle = resolve;
        });
      }
      return successfulLeaseDispatch(name, req);
    });
    const view = await renderElement(createElement(TwoRecorderHarness, { commitA, commitB }));
    const triggers = view.querySelectorAll<HTMLButtonElement>(".pss__hk-capture-trigger");

    await act(async () => {
      triggers[0]?.click();
      await Promise.resolve();
    });
    await act(async () => {
      triggers[1]?.click();
      await Promise.resolve();
    });
    expect(view.querySelector('[aria-label="Cancel recording Region"]')).not.toBeNull();

    const staleRequest = delayed.request;
    const settleFirst = delayed.settle;
    if (staleRequest === undefined || settleFirst === undefined) {
      throw new Error("Missing delayed recorder begin");
    }
    await act(async () => {
      settleFirst({
        ok: true,
        value: {
          sessionId: staleRequest.sessionId,
          generation: staleRequest.generation,
          accepted: false,
          expiresAt: Date.now() + 120_000
        }
      });
      await Promise.resolve();
    });
    expect(view.querySelectorAll(".pss__hk-capture.is-recording")).toHaveLength(1);
    expect(view.querySelector('[aria-label="Cancel recording Region"]')).not.toBeNull();

    await dispatch(
      keyEvent("keydown", { key: "r", code: "KeyR", ctrlKey: true, shiftKey: true })
    );
    await dispatch(
      keyEvent("keyup", { key: "r", code: "KeyR", ctrlKey: true, shiftKey: true })
    );
    expect(commitA).not.toHaveBeenCalled();
    expect(commitB).toHaveBeenCalledWith("Control+Shift+R");
    const endedSessions = leaseDispatch.mock.calls
      .filter(([name]) => name === "settings:endHotkeyRecording")
      .map(([, req]) => req.sessionId);
    expect(endedSessions).not.toContain(staleRequest.sessionId);
  });

  test("Escape cancels, preserves the value, and restores trigger focus", async () => {
    const commit = vi.fn(async () => undefined);
    const unbind = vi.fn(async () => undefined);
    const onCancel = vi.fn();
    const view = await renderHarness({ commit, unbind, onCancel });
    await click(".pss__hk-capture-trigger");
    await dispatch(
      keyEvent("keydown", { key: "Escape", code: "Escape", ctrlKey: true })
    );
    expect(onCancel).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(unbind).not.toHaveBeenCalled();
    expect(view.textContent).toContain("Ctrl");
    expect(document.activeElement).toBe(view.querySelector(".pss__hk-capture-trigger"));
    const begin = leaseDispatch.mock.calls.find(
      ([name]) => name === "settings:beginHotkeyRecording"
    );
    const end = leaseDispatch.mock.calls.find(
      ([name]) => name === "settings:endHotkeyRecording"
    );
    expect(end?.[1]).toEqual({
      sessionId: begin?.[1].sessionId,
      generation: begin?.[1].generation
    });
  });

  test("blur cancels without saving or stealing focus", async () => {
    const commit = vi.fn(async () => undefined);
    const onCancel = vi.fn();
    const view = await renderHarness({ commit, onCancel });
    await click(".pss__hk-capture-trigger");
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(view.querySelector(".pss__hk-capture-trigger")).not.toBe(document.activeElement);
    outside.remove();
  });

  test("document visibility loss cancels without changing the saved value", async () => {
    const commit = vi.fn(async () => undefined);
    const unbind = vi.fn(async () => undefined);
    const onCancel = vi.fn();
    const view = await renderHarness({ commit, unbind, onCancel });
    await click(".pss__hk-capture-trigger");
    const previous = Object.getOwnPropertyDescriptor(document, "visibilityState");
    try {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden"
      });
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    } finally {
      if (previous === undefined) Reflect.deleteProperty(document, "visibilityState");
      else Object.defineProperty(document, "visibilityState", previous);
    }
    expect(onCancel).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(unbind).not.toHaveBeenCalled();
    expect(view.textContent).toContain("Ctrl");
  });

  test("repeat does not commit and bare Delete does not clear", async () => {
    const commit = vi.fn(async () => undefined);
    const unbind = vi.fn(async () => undefined);
    const view = await renderHarness({ commit, unbind });
    await click(".pss__hk-capture-trigger");
    await dispatch(
      keyEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, repeat: true })
    );
    await dispatch(keyEvent("keydown", { key: "Delete", code: "Delete" }));
    expect(commit).not.toHaveBeenCalled();
    expect(unbind).not.toHaveBeenCalled();
    expect(view.querySelector("[role='alert']")?.textContent).toMatch(/Clear button/);
  });

  test("failed save stays open with actionable inline feedback", async () => {
    const commit = vi.fn(async () => {
      throw new Error("That shortcut is already used by another app.");
    });
    const view = await renderHarness({ commit });
    await click(".pss__hk-capture-trigger");
    await dispatch(
      keyEvent("keydown", { key: "r", code: "KeyR", ctrlKey: true, shiftKey: true })
    );
    await dispatch(
      keyEvent("keyup", { key: "r", code: "KeyR", ctrlKey: true, shiftKey: true })
    );
    expect(view.querySelector(".pss__hk-capture.is-recording")).not.toBeNull();
    expect(view.querySelector("[role='alert']")?.textContent).toContain("already used");
    expect(
      leaseDispatch.mock.calls.filter(([name]) => name === "settings:endHotkeyRecording")
    ).toHaveLength(0);
  });

  test("unmount releases the exact active recorder lease", async () => {
    await renderHarness();
    await click(".pss__hk-capture-trigger");
    const begin = leaseDispatch.mock.calls.find(
      ([name]) => name === "settings:beginHotkeyRecording"
    );
    await act(async () => root?.unmount());
    root = null;
    const end = leaseDispatch.mock.calls.find(
      ([name]) => name === "settings:endHotkeyRecording"
    );
    expect(end?.[1]).toEqual({
      sessionId: begin?.[1].sessionId,
      generation: begin?.[1].generation
    });
  });

  test("renews the active recorder guard with the same session and generation", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-23T12:00:00Z") });
    leaseDispatch.mockImplementation(async (name, req) => ({
      ok: true,
      value:
        name === "settings:beginHotkeyRecording"
          ? {
              sessionId: req.sessionId,
              generation: req.generation,
              accepted: true,
              expiresAt: Date.now() + 4_000
            }
          : { ended: true }
    }));
    const view = await renderHarness();
    await click(".pss__hk-capture-trigger");
    const initial = leaseDispatch.mock.calls.find(
      ([name]) => name === "settings:beginHotkeyRecording"
    )?.[1];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    const begins = leaseDispatch.mock.calls.filter(
      ([name]) => name === "settings:beginHotkeyRecording"
    );
    expect(begins).toHaveLength(2);
    expect(begins[1]?.[1]).toEqual(initial);
    expect(view.querySelector(".pss__hk-capture.is-recording")).not.toBeNull();
  });

  test("a rejected stale begin never arms the recorder or ends the current lease", async () => {
    leaseDispatch.mockImplementation(async (name, req) => ({
      ok: true,
      value:
        name === "settings:beginHotkeyRecording"
          ? {
              sessionId: req.sessionId,
              generation: req.generation,
              accepted: false,
              expiresAt: Date.now() + 120_000
            }
          : { ended: true }
    }));
    const view = await renderHarness();

    await click(".pss__hk-capture-trigger");

    expect(view.querySelector(".pss__hk-capture.is-recording")).toBeNull();
    expect(view.querySelector("[role='alert']")?.textContent).toMatch(
      /another shortcut recorder/i
    );
    expect(
      leaseDispatch.mock.calls.filter(([name]) => name === "settings:endHotkeyRecording")
    ).toHaveLength(0);
  });

  test("only the explicit Clear button unbinds; failure preserves old display", async () => {
    const unbind = vi.fn(async () => undefined);
    const view = await renderHarness({ unbind });
    await click(".pss__hk-capture-clear");
    expect(unbind).toHaveBeenCalledOnce();
    expect(view.textContent).toContain("Not set");

    await act(async () => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    const failing = vi.fn(async () => {
      throw new Error("Registration could not be changed.");
    });
    const failedView = await renderHarness({ unbind: failing });
    await click(".pss__hk-capture-clear");
    expect(failedView.textContent).toContain("Ctrl");
    expect(failedView.querySelector("[role='alert']")?.textContent).toContain(
      "could not be changed"
    );
  });
});
