// EditorChrome behaviour suite. Verifies the activity-bar + collapsible/
// poppable right-panel shell against the 13 user-visible cases called
// out in docs/plans/2026-05-23-001-feat-v2-editor-plan.md Phase 1.
//
// Test rig deliberately mirrors `features/settings/__tests__/SettingsContext.test.tsx`
// — plain React `createRoot` + `act` rather than @testing-library/react,
// since the repo doesn't pull that dependency. Synthetic events go via
// the DOM (`dispatchEvent`) so React's synthetic-event layer handles
// them just like a real user interaction.

import { act, createElement, type ReactElement } from "react";
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
import type { Settings } from "@pwrsnap/shared";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

import { EditorChrome, type EditorPanel } from "../EditorChrome";

// ---------------------------------------------------------------- fixtures

const baseSettings: Settings = {
  schemaVersion: 1,
  codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
  ai: { enabled: false, consentAcceptedAt: null, autoAcceptSuggestions: false },
  hotkeys: {
    quickCapture: "CommandOrControl+Shift+C",
    region: "",
    window: "",
    videoCapture: "CommandOrControl+Alt+C"
  },
  experimental: { v2FileFormat: false },
  general: { developerMode: false },
  appearance: { theme: "system" },
  updates: { channel: "latest" },
  recording: {
    includeSystemAudio: false,
    includeMicrophone: false,
    lastRoutedPermissionFingerprint: ""
  },
  editor: {
    toolStyles: {
      arrow: {
        color: "accent",
        thickness: "auto",
        endStyle: "filled-triangle",
        stemStyle: "solid",
        doubleEnded: false
      },
      text: { color: "accent", fontSize: "auto", weight: "regular" },
      shape: { color: "accent", thickness: "auto", filled: false, shape: "rect", skewDeg: 15 },
      blur: { mode: "gaussian", radius: { mode: "auto" } },
      highlight: { color: "yellow", opacity: 0.3, blend: "multiply" }
    },
    coachmarks: { stoplightSeen: false },
    matchingText: { enabled: true },
    sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
  },
  library: { detailRail: { pinned: true, lastSelectedTab: "info" } }
};

type AnyResult = { ok: true; value: unknown } | { ok: false; error: unknown };

interface FakeApi {
  dispatch: ReturnType<typeof vi.fn>;
  writes: { name: string; req: unknown }[];
}

function installFakeApi(opts?: { settings?: Settings }): FakeApi {
  const settings = opts?.settings ?? baseSettings;
  const writes: { name: string; req: unknown }[] = [];
  const dispatch = vi.fn(async (name: string, req: unknown): Promise<AnyResult> => {
    if (name === "settings:read") return { ok: true, value: settings };
    if (name === "settings:secretStatus") return { ok: true, value: {} };
    if (name === "settings:write") {
      writes.push({ name, req });
      return { ok: true, value: settings };
    }
    return { ok: true, value: undefined };
  });
  (globalThis as unknown as { window: Window }).window = (globalThis as unknown as {
    window: Window;
  }).window ?? ({} as Window);
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on: () => () => undefined,
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return { dispatch, writes };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderChrome(props?: { className?: string }): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  const panels: Record<EditorPanel, ReactElement> = {
    info: createElement(
      "div",
      { "data-testid": "panel-info" },
      "INFO PANEL CONTENT"
    ),
    chat: createElement(
      "div",
      { "data-testid": "panel-chat" },
      "CHAT PANEL CONTENT"
    ),
    toolConfig: createElement(
      "div",
      { "data-testid": "panel-toolConfig" },
      "TOOLCONFIG PANEL CONTENT"
    ),
    help: createElement(
      "div",
      { "data-testid": "panel-help" },
      "HELP PANEL CONTENT"
    )
  };

  await act(async () => {
    root?.render(
      createElement(
        EditorChrome,
        {
          panels,
          children: createElement(
            "div",
            { "data-testid": "viewport" },
            "VIEWPORT"
          ),
          ...(props?.className !== undefined ? { className: props.className } : {})
        }
      )
    );
  });
  // Resolve the initial `settings:read` microtask.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
}

function findButton(id: EditorPanel): HTMLButtonElement {
  const el = container?.querySelector(`button[data-panel="${id}"]`);
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`button[data-panel="${id}"] not found`);
  }
  return el;
}

function findPinnedPanel(): HTMLElement | null {
  return container?.querySelector('[data-testid="pse-panel-pinned"]') ?? null;
}

function findHoverPanel(): HTMLElement | null {
  return container?.querySelector('[data-testid="pse-panel-hover"]') ?? null;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
  });
}

async function mouseEnter(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
  });
}

async function mouseLeave(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
  });
}

async function mouseMove(
  el: HTMLElement,
  clientX: number,
  clientY: number
): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX, clientY })
    );
  });
}

async function keyDown(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: opts.key,
        metaKey: opts.metaKey === true,
        ctrlKey: opts.ctrlKey === true,
        bubbles: true,
        cancelable: true
      })
    );
  });
}

// Force the navigator.platform to "MacIntel" so isPrimaryAccel uses
// metaKey — keeps the shortcuts deterministic across CI shapes.
function pinNavigatorAsMac(): void {
  Object.defineProperty(navigator, "platform", {
    value: "MacIntel",
    configurable: true
  });
}

beforeEach(() => {
  pinNavigatorAsMac();
});

afterEach(async () => {
  await unmount();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- tests

describe("EditorChrome", () => {
  test("default render (not pinned, first interaction) — activity bar visible, panel hidden", async () => {
    installFakeApi();
    await renderChrome();

    // Activity bar buttons render.
    expect(findButton("info")).toBeTruthy();
    expect(findButton("chat")).toBeTruthy();
    expect(findButton("toolConfig")).toBeTruthy();
    expect(findButton("help")).toBeTruthy();

    // Pinned panel area is NOT visible (no panel rendered) since
    // settings.editor.sidebar.pinned defaults to false.
    expect(findPinnedPanel()).toBeNull();
    expect(findHoverPanel()).toBeNull();

    // Viewport children render.
    expect(container?.querySelector('[data-testid="viewport"]')?.textContent).toBe(
      "VIEWPORT"
    );

    // Activity bar carries tablist semantics.
    const tablist = container?.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
  });

  test("click Info icon → panel area visible with Info panel content", async () => {
    installFakeApi();
    await renderChrome();

    await click(findButton("info"));
    const panel = findPinnedPanel();
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('[data-testid="panel-info"]')?.textContent).toBe(
      "INFO PANEL CONTENT"
    );
    // aria-pressed reflects active state.
    expect(findButton("info").getAttribute("aria-pressed")).toBe("true");
  });

  test("click Info icon again → unpins; settings dispatch records both writes", async () => {
    const { writes } = installFakeApi();
    await renderChrome();

    await click(findButton("info"));
    const writesAfterFirst = writes.length;
    // First click should have written pinned:true and lastSelectedPanel:info.
    expect(
      writes.some((w) => {
        const req = w.req as { editor?: { sidebar?: { pinned?: boolean } } };
        return req.editor?.sidebar?.pinned === true;
      })
    ).toBe(true);
    expect(
      writes.some((w) => {
        const req = w.req as {
          editor?: { sidebar?: { lastSelectedPanel?: string } };
        };
        return req.editor?.sidebar?.lastSelectedPanel === "info";
      })
    ).toBe(true);

    // Second click on the same icon → unpins.
    await click(findButton("info"));
    expect(writes.length).toBeGreaterThan(writesAfterFirst);
    const last = writes[writes.length - 1];
    const lastReq = last?.req as { editor?: { sidebar?: { pinned?: boolean } } };
    expect(lastReq.editor?.sidebar?.pinned).toBe(false);
    // is-active class drops off the button after unpin (panel still
    // visible as hover-pop, but icon is no longer "pinned-active").
    expect(findButton("info").getAttribute("aria-pressed")).toBe("false");
  });

  test("click Chat icon while Info is pinned → Chat panel renders (still pinned)", async () => {
    installFakeApi();
    await renderChrome();

    await click(findButton("info"));
    expect(findPinnedPanel()?.querySelector('[data-testid="panel-info"]')).not.toBeNull();

    await click(findButton("chat"));
    const pinned = findPinnedPanel();
    expect(pinned).not.toBeNull();
    expect(pinned?.querySelector('[data-testid="panel-chat"]')).not.toBeNull();
    expect(pinned?.querySelector('[data-testid="panel-info"]')).toBeNull();
    expect(findButton("chat").getAttribute("aria-pressed")).toBe("true");
  });

  test("hover Info icon after first click → 300ms → hover-pop overlay appears", async () => {
    vi.useFakeTimers();
    installFakeApi();
    await renderChrome();

    // First click pins (and arms hover-pop).
    await click(findButton("info"));
    // Unpin it so hover-pop is in play (clicking again unpins).
    await click(findButton("info"));
    // Mouse out so the hover-popped panel clears, simulating user
    // returning the cursor elsewhere.
    await mouseLeave(findButton("info"));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(findHoverPanel()).toBeNull();

    // Now hover the Info icon — within 300ms nothing happens.
    await mouseEnter(findButton("info"));
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(findHoverPanel()).toBeNull();
    // After the 300ms hover delay elapses, the overlay appears.
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(findHoverPanel()).not.toBeNull();
  });

  test("after hover-pop, mouse out → 500ms grace → overlay disappears", async () => {
    vi.useFakeTimers();
    installFakeApi();
    await renderChrome();

    await click(findButton("info"));
    await click(findButton("info"));
    await mouseLeave(findButton("info"));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    await mouseEnter(findButton("info"));
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(findHoverPanel()).not.toBeNull();

    await mouseLeave(findButton("info"));
    // Within the grace window, still visible.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(findHoverPanel()).not.toBeNull();
    // After the grace window elapses, gone.
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(findHoverPanel()).toBeNull();
  });

  test("mouse moves diagonally INTO panel rect → grace timer cancelled", async () => {
    vi.useFakeTimers();
    installFakeApi();
    await renderChrome();

    await click(findButton("info"));
    await click(findButton("info"));
    await mouseLeave(findButton("info"));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    await mouseEnter(findButton("info"));
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(findHoverPanel()).not.toBeNull();

    // Track two mouse positions moving LEFTWARD (toward the panel,
    // which sits to the left of the activity bar). The chrome root
    // listens to mousemove, so dispatch on `container`.
    const chrome = container?.querySelector(".pse-chrome") as HTMLElement;
    expect(chrome).not.toBeNull();
    // Stub the panel's getBoundingClientRect so the safe-triangle
    // calculation sees a target rect. The default jsdom rect is all
    // zeros, which would always fail the heading test.
    const hoverPanelEl = findHoverPanel();
    expect(hoverPanelEl).not.toBeNull();
    if (hoverPanelEl !== null) {
      const stubRect = {
        x: 100,
        y: 100,
        left: 100,
        right: 380,
        top: 100,
        bottom: 480,
        width: 280,
        height: 380,
        toJSON() {
          return this;
        }
      } as DOMRect;
      hoverPanelEl.getBoundingClientRect = () => stubRect;
    }
    // Establish two mouse positions heading leftward into the panel.
    await mouseMove(chrome, 600, 250);
    await mouseMove(chrome, 500, 250); // now heading left
    await mouseLeave(findButton("info"));

    // Grace timer should NOT have started because the motion vector
    // projects into the panel rect.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(findHoverPanel()).not.toBeNull();
  });

  test("⌘\\ toggles pinned state", async () => {
    const { writes } = installFakeApi();
    await renderChrome();

    expect(findPinnedPanel()).toBeNull();
    await keyDown({ key: "\\", metaKey: true });
    expect(findPinnedPanel()).not.toBeNull();
    const sidebarWrites = writes.filter((w) => {
      const req = w.req as { editor?: { sidebar?: { pinned?: boolean } } };
      return req.editor?.sidebar?.pinned !== undefined;
    });
    expect(sidebarWrites.length).toBeGreaterThan(0);
    expect(
      (sidebarWrites[sidebarWrites.length - 1]?.req as {
        editor: { sidebar: { pinned: boolean } };
      }).editor.sidebar.pinned
    ).toBe(true);

    await keyDown({ key: "\\", metaKey: true });
    expect(findPinnedPanel()).toBeNull();
  });

  test("⌘1 selects Info + pins", async () => {
    installFakeApi();
    await renderChrome();

    await keyDown({ key: "1", metaKey: true });
    const panel = findPinnedPanel();
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('[data-testid="panel-info"]')).not.toBeNull();
  });

  test("⌘2 selects Chat + pins", async () => {
    installFakeApi();
    await renderChrome();

    await keyDown({ key: "2", metaKey: true });
    const panel = findPinnedPanel();
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('[data-testid="panel-chat"]')).not.toBeNull();
  });

  test("⌘3 selects Tool Config + pins", async () => {
    installFakeApi();
    await renderChrome();

    await keyDown({ key: "3", metaKey: true });
    const panel = findPinnedPanel();
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('[data-testid="panel-toolConfig"]')).not.toBeNull();
  });

  test("Escape while hover-popped → overlay closes; pinned unaffected", async () => {
    vi.useFakeTimers();
    installFakeApi();
    await renderChrome();

    await click(findButton("info"));
    await click(findButton("info"));
    await mouseLeave(findButton("info"));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    await mouseEnter(findButton("info"));
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(findHoverPanel()).not.toBeNull();

    await keyDown({ key: "Escape" });
    expect(findHoverPanel()).toBeNull();

    // Pinned mode: Escape is a no-op.
    await keyDown({ key: "\\", metaKey: true }); // toggle pinned on
    expect(findPinnedPanel()).not.toBeNull();
    await keyDown({ key: "Escape" });
    expect(findPinnedPanel()).not.toBeNull();
  });

  test("prefers-reduced-motion: reduce → no transition styles applied", async () => {
    // Mock matchMedia so the EditorChrome reads reduced motion on
    // mount and stamps the `is-reduced-motion` opt-in class.
    const original = window.matchMedia;
    (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
      ((query: string) => {
        return {
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false
        } as unknown as MediaQueryList;
      }) as typeof window.matchMedia;

    installFakeApi();
    await renderChrome();

    const chrome = container?.querySelector(".pse-chrome") as HTMLElement;
    expect(chrome.classList.contains("is-reduced-motion")).toBe(true);

    // Restore the original implementation.
    (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia = original;
  });
});
