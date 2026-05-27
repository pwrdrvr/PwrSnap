// Unit-level coverage for the reusable RightActivityBar primitive.
// Verifies tab switching, pin lifecycle, keyboard shortcuts, and the
// hover-pop / safe-triangle behavior the editor + Library rails both
// depend on.

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
import {
  RightActivityBar,
  type RightActivityTab
} from "../RightActivityBar";

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

type TabId = "info" | "ocr" | "chat";

const TABS: ReadonlyArray<RightActivityTab<TabId>> = [
  { id: "info", label: "Info", icon: <span data-testid="ico-info" /> },
  { id: "ocr", label: "OCR", icon: <span data-testid="ico-ocr" /> },
  { id: "chat", label: "Chat", icon: <span data-testid="ico-chat" /> }
];

interface RenderParams {
  active?: TabId;
  pinned?: boolean;
  badges?: Partial<Record<TabId, boolean>>;
}

interface RenderResult {
  el: HTMLDivElement;
  onTabChange: ReturnType<typeof vi.fn>;
  onPinChange: ReturnType<typeof vi.fn>;
  renderPanel: ReturnType<typeof vi.fn>;
  setProps: (next: Partial<RenderParams>) => Promise<void>;
}

async function renderBar(params: RenderParams = {}): Promise<RenderResult> {
  const onTabChange = vi.fn();
  const onPinChange = vi.fn();
  const renderPanel = vi.fn((id: TabId) =>
    createElement("div", { "data-testid": `body-${id}` }, `panel:${id}`)
  );

  let current: Required<RenderParams> = {
    active: params.active ?? "info",
    pinned: params.pinned ?? true,
    badges: params.badges ?? {}
  };

  function paint(next: Required<RenderParams>): ReactElement {
    const tabs = TABS.map((t) =>
      next.badges[t.id] === true ? { ...t, badge: true } : t
    );
    return createElement(RightActivityBar<TabId>, {
      tabs,
      activeTab: next.active,
      pinned: next.pinned,
      onTabChange: (id) => {
        current = { ...current, active: id };
        onTabChange(id);
        void rerender();
      },
      onPinChange: (p) => {
        current = { ...current, pinned: p };
        onPinChange(p);
        void rerender();
      },
      renderPanel,
      testIdPrefix: "rab-test"
    });
  }

  async function rerender(): Promise<void> {
    await act(async () => {
      root?.render(paint(current));
      await Promise.resolve();
    });
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(paint(current));
    await Promise.resolve();
  });

  return {
    el: container,
    onTabChange,
    onPinChange,
    renderPanel,
    setProps: async (patch) => {
      current = { ...current, ...patch, badges: patch.badges ?? current.badges };
      await rerender();
    }
  };
}

function getTab(el: HTMLElement, id: TabId): HTMLButtonElement {
  const btn = el.querySelector<HTMLButtonElement>(
    `[data-testid="rab-test-tab-${id}"]`
  );
  if (btn === null) throw new Error(`tab ${id} not found`);
  return btn;
}

describe("RightActivityBar", () => {
  test("pinned + activeTab renders the pinned panel with the active body", async () => {
    const { el } = await renderBar({ active: "info", pinned: true });
    expect(
      el.querySelector('[data-testid="rab-test-panel-pinned"]')
    ).not.toBeNull();
    expect(el.querySelector('[data-testid="body-info"]')).not.toBeNull();
    // No hover-pop while pinned.
    expect(el.querySelector('[data-testid="rab-test-panel-hover"]')).toBeNull();
  });

  test("clicking a non-active tab fires onTabChange", async () => {
    const { el, onTabChange } = await renderBar({ active: "info" });
    const ocrTab = getTab(el, "ocr");
    await act(async () => {
      ocrTab.click();
      await Promise.resolve();
    });
    expect(onTabChange).toHaveBeenCalledWith("ocr");
  });

  test("clicking the active tab while pinned unpins and keeps a hover-pop", async () => {
    const { el, onPinChange } = await renderBar({
      active: "info",
      pinned: true
    });
    const infoTab = getTab(el, "info");
    await act(async () => {
      infoTab.click();
      await Promise.resolve();
    });
    expect(onPinChange).toHaveBeenCalledWith(false);
    // After the rerender, the hover-pop should be visible.
    const hover = el.querySelector('[data-testid="rab-test-panel-hover"]');
    expect(hover).not.toBeNull();
  });

  test("clicking a tab while unpinned pins and switches", async () => {
    const { el, onPinChange, onTabChange } = await renderBar({
      active: "info",
      pinned: false
    });
    const ocrTab = getTab(el, "ocr");
    await act(async () => {
      ocrTab.click();
      await Promise.resolve();
    });
    expect(onPinChange).toHaveBeenCalledWith(true);
    expect(onTabChange).toHaveBeenCalledWith("ocr");
  });

  test("tab with badge:true renders a notification dot", async () => {
    const { el } = await renderBar({
      badges: { ocr: true }
    });
    const ocrBtn = getTab(el, "ocr");
    expect(ocrBtn.querySelector(".rab__act-badge")).not.toBeNull();
    const infoBtn = getTab(el, "info");
    expect(infoBtn.querySelector(".rab__act-badge")).toBeNull();
  });

  test("activity bar has role=tablist with vertical orientation", async () => {
    const { el } = await renderBar();
    const tablist = el.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    expect(tablist?.getAttribute("aria-orientation")).toBe("vertical");
  });

  test("Cmd+\\ toggles the pin state", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
    const { onPinChange } = await renderBar({ pinned: true });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "\\", metaKey: true })
      );
      await Promise.resolve();
    });
    expect(onPinChange).toHaveBeenLastCalledWith(false);
  });

  test("Cmd+2 picks the second tab in render order", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
    const { onTabChange } = await renderBar({ active: "info" });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "2", metaKey: true })
      );
      await Promise.resolve();
    });
    expect(onTabChange).toHaveBeenLastCalledWith("ocr");
  });

  test("Cmd+N ignores numbers outside the tab range", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
    const { onTabChange } = await renderBar({ active: "info" });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "9", metaKey: true })
      );
      await Promise.resolve();
    });
    expect(onTabChange).not.toHaveBeenCalled();
  });

  test("Escape closes a hover-popped panel", async () => {
    // First click an icon to bring up the hover-pop (clicking the
    // active icon while pinned demotes to hover-pop).
    const { el } = await renderBar({ active: "info", pinned: true });
    await act(async () => {
      getTab(el, "info").click();
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="rab-test-panel-hover"]')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="rab-test-panel-hover"]')).toBeNull();
  });

  test("typing in an input does not consume Cmd+N shortcut handler's number key (only modifier-less editable check)", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
    const { onTabChange } = await renderBar({ active: "info" });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await act(async () => {
      // Dispatch a key event whose `target` is the input — the
      // handler should bail without firing onTabChange.
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "2",
          metaKey: true,
          bubbles: true
        })
      );
      await Promise.resolve();
    });
    expect(onTabChange).not.toHaveBeenCalled();
    input.remove();
  });

  test("renderPanel is invoked with the active tab id on pinned mode", async () => {
    const { renderPanel } = await renderBar({ active: "chat", pinned: true });
    // Render-prop is called at least once with the active id.
    expect(renderPanel).toHaveBeenCalledWith("chat");
  });

  test("clicking the active tab twice unpins then re-pins (toggle behavior)", async () => {
    const { el, onPinChange } = await renderBar({
      active: "info",
      pinned: true
    });
    const infoTab = getTab(el, "info");
    // First click: unpin (active+pinned demotes to hover-pop).
    await act(async () => {
      infoTab.click();
      await Promise.resolve();
    });
    expect(onPinChange).toHaveBeenLastCalledWith(false);
    // Second click: pin (unpinned + click = pin).
    await act(async () => {
      infoTab.click();
      await Promise.resolve();
    });
    expect(onPinChange).toHaveBeenLastCalledWith(true);
  });

  // ---- ARIA conformance (regression coverage) -----------------
  // Pre-fix the component used aria-pressed (a toggle-button
  // semantic) on role="tab", which breaks screen reader announcement
  // of the active tab. These tests lock the correct pattern in:
  // aria-selected on tabs + aria-controls linking to a tabpanel id,
  // and the corresponding aria-labelledby + role on the panel.

  test("active tab uses aria-selected (not aria-pressed)", async () => {
    const { el } = await renderBar({ active: "ocr", pinned: true });
    const ocr = getTab(el, "ocr");
    const info = getTab(el, "info");
    expect(ocr.getAttribute("aria-selected")).toBe("true");
    expect(info.getAttribute("aria-selected")).toBe("false");
    // aria-pressed must be absent — using it would imply toggle-button
    // semantics, which announces "pressed" instead of "selected".
    expect(ocr.getAttribute("aria-pressed")).toBeNull();
    expect(info.getAttribute("aria-pressed")).toBeNull();
  });

  test("inactive tabs follow the roving-tabindex pattern (tabindex=-1)", async () => {
    const { el } = await renderBar({ active: "info", pinned: true });
    expect(getTab(el, "info").getAttribute("tabindex")).toBe("0");
    expect(getTab(el, "ocr").getAttribute("tabindex")).toBe("-1");
    expect(getTab(el, "chat").getAttribute("tabindex")).toBe("-1");
  });

  test("aria-controls on tabs points at the rendered tabpanel id", async () => {
    const { el } = await renderBar({ active: "info", pinned: true });
    const panel = el.querySelector<HTMLDivElement>(
      '[data-testid="rab-test-panel-pinned"]'
    );
    expect(panel).not.toBeNull();
    const panelId = panel?.getAttribute("id") ?? "";
    expect(panelId.length).toBeGreaterThan(0);
    // Every tab's aria-controls must match the panel's id (single
    // shared id, because only one panel is mounted at a time).
    for (const id of ["info", "ocr", "chat"] as const) {
      expect(getTab(el, id).getAttribute("aria-controls")).toBe(panelId);
    }
  });

  test("tabpanel id reflects the visible tab so the link survives unpin", async () => {
    const { el } = await renderBar({ active: "info", pinned: true });
    const pinnedPanel = el.querySelector('[data-testid="rab-test-panel-pinned"]');
    const pinnedId = pinnedPanel?.getAttribute("id") ?? "";
    // Click active info icon → demotes to hover-pop, same panel id.
    await act(async () => {
      getTab(el, "info").click();
      await Promise.resolve();
    });
    const hoverPanel = el.querySelector('[data-testid="rab-test-panel-hover"]');
    expect(hoverPanel).not.toBeNull();
    const hoverId = hoverPanel?.querySelector('[role="tabpanel"]')?.getAttribute("id")
      ?? hoverPanel?.getAttribute("id")
      ?? "";
    // The rendered tabpanel inside the hover-wrap (the .rab__panel--hover
    // node) carries the matching id since `panelId` keys on the visible
    // tab. Both reads above account for the wrap-vs-panel container.
    expect([pinnedId, "rab-test-tabpanel-info"]).toContain(hoverId);
  });

  test("tabpanel carries role=tabpanel + aria-labelledby pointing at the active tab", async () => {
    const { el } = await renderBar({ active: "ocr", pinned: true });
    const panel = el.querySelector('[data-testid="rab-test-panel-pinned"]');
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    const ariaLabelledby = panel?.getAttribute("aria-labelledby") ?? "";
    const ocrTabId = getTab(el, "ocr").getAttribute("id") ?? "";
    expect(ariaLabelledby).toBe(ocrTabId);
    expect(ariaLabelledby.length).toBeGreaterThan(0);
  });
});
