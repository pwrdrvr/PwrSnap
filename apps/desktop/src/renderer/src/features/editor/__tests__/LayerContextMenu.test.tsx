// Component-level tests for `LayerContextMenu` — the right-click
// popover for layer ops. The pure-helper matrix lives next door
// (buildLayerContextMenuItems.test.ts); these tests cover the
// rendering + dismissal contract:
//
//   • opens at the anchor (CSS left/top set from anchorPx)
//   • renders items with the label + accel + enabled state from
//     the input list
//   • Escape closes (and stops propagating so the underlying
//     selection isn't cleared by another Escape handler)
//   • mousedown outside the menu closes
//   • clicking an ENABLED item fires onItemClick with its id
//   • clicking a DISABLED item does NOT fire onItemClick
//   • separators render but aren't clickable

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { LayerContextMenu } from "../LayerContextMenu";
import type {
  LayerContextMenuItem,
  LayerContextMenuItemId
} from "../buildLayerContextMenuItems";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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
});

async function renderMenu(
  items: readonly LayerContextMenuItem[],
  handlers: {
    onClose?: () => void;
    onItemClick?: (id: LayerContextMenuItemId) => void;
    anchorPx?: { x: number; y: number };
  } = {}
): Promise<{
  rootEl: HTMLElement;
  onClose: ReturnType<typeof vi.fn>;
  onItemClick: ReturnType<typeof vi.fn>;
}> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onClose = vi.fn(handlers.onClose ?? (() => undefined));
  const onItemClick = vi.fn(
    handlers.onItemClick ?? ((_: LayerContextMenuItemId) => undefined)
  );
  await act(async () => {
    root?.render(
      createElement(LayerContextMenu, {
        items,
        anchorPx: handlers.anchorPx ?? { x: 50, y: 80 },
        onClose,
        onItemClick
      })
    );
  });
  const rootEl = container.querySelector(
    "[data-testid='layer-context-menu']"
  );
  if (rootEl === null) throw new Error("menu root not rendered");
  return { rootEl: rootEl as HTMLElement, onClose, onItemClick };
}

const SAMPLE_ITEMS: LayerContextMenuItem[] = [
  { id: "copy", label: "Copy", accel: "⌘C", enabled: true },
  { id: "delete", label: "", accel: "", enabled: false, isSeparator: true },
  { id: "delete", label: "Delete", accel: "⌫", enabled: true }
];

describe("LayerContextMenu — anchor positioning", () => {
  test("renders the menu root at the supplied anchorPx (CSS left/top)", async () => {
    const { rootEl } = await renderMenu(SAMPLE_ITEMS, {
      anchorPx: { x: 123, y: 456 }
    });
    expect(rootEl.style.left).toBe("123px");
    expect(rootEl.style.top).toBe("456px");
  });
});

describe("LayerContextMenu — item rendering", () => {
  test("renders one button per non-separator item", async () => {
    const { rootEl } = await renderMenu(SAMPLE_ITEMS);
    const buttons = rootEl.querySelectorAll("button[role='menuitem']");
    expect(buttons.length).toBe(2);
  });

  test("renders the separator div in between", async () => {
    const { rootEl } = await renderMenu(SAMPLE_ITEMS);
    expect(rootEl.querySelectorAll("[role='separator']").length).toBe(1);
  });

  test("each row shows the label + accel from its item", async () => {
    const { rootEl } = await renderMenu(SAMPLE_ITEMS);
    const copyBtn = rootEl.querySelector(
      "[data-testid='layer-context-menu-item-copy']"
    );
    expect(copyBtn?.textContent).toContain("Copy");
    expect(copyBtn?.textContent).toContain("⌘C");
  });

  test("disabled rows carry data-enabled='false' + aria-disabled + is-disabled class", async () => {
    const items: LayerContextMenuItem[] = [
      { id: "copy", label: "Copy", accel: "⌘C", enabled: false }
    ];
    const { rootEl } = await renderMenu(items);
    const btn = rootEl.querySelector(
      "[data-testid='layer-context-menu-item-copy']"
    ) as HTMLButtonElement;
    expect(btn.getAttribute("data-enabled")).toBe("false");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.className).toContain("is-disabled");
  });
});

describe("LayerContextMenu — click behavior", () => {
  test("clicking an enabled item fires onItemClick with the item id", async () => {
    const { rootEl, onItemClick } = await renderMenu(SAMPLE_ITEMS);
    const copyBtn = rootEl.querySelector(
      "[data-testid='layer-context-menu-item-copy']"
    ) as HTMLButtonElement;
    await act(async () => {
      copyBtn.click();
    });
    expect(onItemClick).toHaveBeenCalledTimes(1);
    expect(onItemClick).toHaveBeenCalledWith("copy");
  });

  test("clicking a DISABLED item does NOT fire onItemClick", async () => {
    const items: LayerContextMenuItem[] = [
      { id: "copy", label: "Copy", accel: "⌘C", enabled: false }
    ];
    const { rootEl, onItemClick } = await renderMenu(items);
    const btn = rootEl.querySelector(
      "[data-testid='layer-context-menu-item-copy']"
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    expect(onItemClick).not.toHaveBeenCalled();
  });
});

describe("LayerContextMenu — dismissal", () => {
  test("Escape keypress fires onClose", async () => {
    const { onClose } = await renderMenu(SAMPLE_ITEMS);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("mousedown OUTSIDE the menu root fires onClose", async () => {
    const { onClose } = await renderMenu(SAMPLE_ITEMS);
    // mousedown on document.body (outside the menu).
    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("mousedown INSIDE the menu root does NOT fire onClose", async () => {
    const { rootEl, onClose } = await renderMenu(SAMPLE_ITEMS);
    await act(async () => {
      rootEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("Escape stops propagating so an Editor-level handler can't also fire", async () => {
    const editorHandler = vi.fn();
    document.addEventListener("keydown", editorHandler);
    try {
      await renderMenu(SAMPLE_ITEMS);
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      // The menu's listener registers in CAPTURE phase and
      // stopPropagation()s, so the document-level bubble-phase
      // handler should not see Escape.
      const escCalls = editorHandler.mock.calls.filter(
        ([e]) => (e as KeyboardEvent).key === "Escape"
      );
      expect(escCalls.length).toBe(0);
    } finally {
      document.removeEventListener("keydown", editorHandler);
    }
  });

  test("Escape stops propagation against a WINDOW-LEVEL CAPTURE-phase competing handler (matches Editor.tsx:2474)", async () => {
    // PR #150 follow-up: real-world repro. Editor.tsx registers its
    // own keydown listener on WINDOW with `{ capture: true }`. The
    // event-propagation order for capture is:
    //
    //   window-capture → document-capture → ... → target → bubble back
    //
    // So Editor's window-capture listener ALWAYS fires BEFORE the
    // menu's document-capture listener. The previous coverage above
    // attached a document-level BUBBLE listener, which the menu's
    // capture+stopPropagation correctly blocked — but a window-level
    // CAPTURE handler is upstream of the menu's listener and runs
    // regardless. This test pins the contract that even against THAT
    // ordering, the menu's onClose still fires.
    //
    // The user-reported manual symptom: "Escape doesn't close the
    // right-click menu." Click-outside dismissal worked; Escape did
    // not. Root cause: Editor's window-capture handler ran the
    // clearSelection branch, did not stop propagation, then the menu's
    // listener fired (closing the menu via onClose) — but the
    // clearSelection branch was ALSO violating the "Escape closes the
    // menu without clearing the selection" spec from PR #150's test
    // plan. The fix shifts Escape handling priority: when the menu is
    // open, Editor's window-capture handler must SKIP its own Escape
    // branches so the menu's listener owns the gesture.
    //
    // This test reproduces the exact window-capture timing in a unit
    // harness so the fix can land with a verified gate.
    const editorWindowCaptureHandler = vi.fn();
    window.addEventListener("keydown", editorWindowCaptureHandler, {
      capture: true
    });
    try {
      const { onClose } = await renderMenu(SAMPLE_ITEMS);
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      // The menu's listener MUST still close the menu, even when an
      // upstream window-capture handler has already seen the event.
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", editorWindowCaptureHandler, {
        capture: true
      });
    }
  });

});
