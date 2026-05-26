// Coverage for LayoutToggleButtons — VS Code-style title-bar layout
// chips. Pins down:
//
//   • Open/closed visual state via aria-pressed + .is-open class.
//   • Click fires onTogglePrimary / onToggleSecondary.
//   • Keyboard chords: ⌘B = primary, ⌘⌥B = secondary (Mac); Ctrl
//     equivalents on non-Mac.
//   • Editable-target bail: chord must not fire when an input/
//     textarea has focus.
//   • disableHotkeys prop suppresses the window-level listener.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi
} from "vitest";
import { LayoutToggleButtons } from "../LayoutToggleButtons";

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
});

interface RenderArgs {
  primaryOpen?: boolean;
  secondaryOpen?: boolean;
  disableHotkeys?: boolean;
}

async function renderToggles(args: RenderArgs = {}): Promise<{
  el: HTMLDivElement;
  onTogglePrimary: ReturnType<typeof vi.fn>;
  onToggleSecondary: ReturnType<typeof vi.fn>;
}> {
  const onTogglePrimary = vi.fn();
  const onToggleSecondary = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(LayoutToggleButtons, {
        primaryOpen: args.primaryOpen ?? true,
        secondaryOpen: args.secondaryOpen ?? true,
        onTogglePrimary,
        onToggleSecondary,
        disableHotkeys: args.disableHotkeys ?? false
      })
    );
    await Promise.resolve();
  });
  return { el: container, onTogglePrimary, onToggleSecondary };
}

describe("LayoutToggleButtons", () => {
  test("renders both chips with role=group + accessible label", async () => {
    const { el } = await renderToggles();
    const group = el.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute("aria-label")).toBe("Window layout");
    expect(
      el.querySelector('[data-testid="layout-toggle-primary"]')
    ).not.toBeNull();
    expect(
      el.querySelector('[data-testid="layout-toggle-secondary"]')
    ).not.toBeNull();
  });

  test("open chip carries aria-pressed=true + .is-open; closed chip is the inverse", async () => {
    const { el } = await renderToggles({
      primaryOpen: true,
      secondaryOpen: false
    });
    const primary = el.querySelector<HTMLButtonElement>(
      '[data-testid="layout-toggle-primary"]'
    );
    const secondary = el.querySelector<HTMLButtonElement>(
      '[data-testid="layout-toggle-secondary"]'
    );
    expect(primary?.getAttribute("aria-pressed")).toBe("true");
    expect(primary?.classList.contains("is-open")).toBe(true);
    expect(primary?.classList.contains("is-closed")).toBe(false);
    expect(primary?.getAttribute("data-open")).toBe("true");

    expect(secondary?.getAttribute("aria-pressed")).toBe("false");
    expect(secondary?.classList.contains("is-closed")).toBe(true);
    expect(secondary?.classList.contains("is-open")).toBe(false);
    expect(secondary?.getAttribute("data-open")).toBe("false");
  });

  test("clicking primary chip fires onTogglePrimary; secondary clicks are independent", async () => {
    const { el, onTogglePrimary, onToggleSecondary } = await renderToggles();
    await act(async () => {
      el.querySelector<HTMLButtonElement>(
        '[data-testid="layout-toggle-primary"]'
      )?.click();
      await Promise.resolve();
    });
    expect(onTogglePrimary).toHaveBeenCalledTimes(1);
    expect(onToggleSecondary).not.toHaveBeenCalled();

    await act(async () => {
      el.querySelector<HTMLButtonElement>(
        '[data-testid="layout-toggle-secondary"]'
      )?.click();
      await Promise.resolve();
    });
    expect(onToggleSecondary).toHaveBeenCalledTimes(1);
    expect(onTogglePrimary).toHaveBeenCalledTimes(1); // unchanged
  });

  test("⌘B (Mac) fires onTogglePrimary", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
    const { onTogglePrimary, onToggleSecondary } = await renderToggles();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", metaKey: true })
      );
      await Promise.resolve();
    });
    expect(onTogglePrimary).toHaveBeenCalledTimes(1);
    expect(onToggleSecondary).not.toHaveBeenCalled();
  });

  test("⌘⌥B (Mac) fires onToggleSecondary", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
    const { onTogglePrimary, onToggleSecondary } = await renderToggles();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "b",
          metaKey: true,
          altKey: true
        })
      );
      await Promise.resolve();
    });
    expect(onToggleSecondary).toHaveBeenCalledTimes(1);
    expect(onTogglePrimary).not.toHaveBeenCalled();
  });

  test("Ctrl+B (non-Mac) fires onTogglePrimary", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "Linux x86_64",
      configurable: true
    });
    const { onTogglePrimary } = await renderToggles();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", ctrlKey: true })
      );
      await Promise.resolve();
    });
    expect(onTogglePrimary).toHaveBeenCalledTimes(1);
  });

  test("typing 'b' into an input does not fire the chord", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
    const { onTogglePrimary } = await renderToggles();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "b",
          metaKey: true,
          bubbles: true
        })
      );
      await Promise.resolve();
    });
    expect(onTogglePrimary).not.toHaveBeenCalled();
    input.remove();
  });

  test("disableHotkeys=true skips the window listener entirely", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
    const { onTogglePrimary, onToggleSecondary } = await renderToggles({
      disableHotkeys: true
    });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", metaKey: true })
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "b",
          metaKey: true,
          altKey: true
        })
      );
      await Promise.resolve();
    });
    expect(onTogglePrimary).not.toHaveBeenCalled();
    expect(onToggleSecondary).not.toHaveBeenCalled();
  });

  test("modifier-less 'b' keypress does not toggle (must include ⌘ or Ctrl)", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
    const { onTogglePrimary, onToggleSecondary } = await renderToggles();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
      await Promise.resolve();
    });
    expect(onTogglePrimary).not.toHaveBeenCalled();
    expect(onToggleSecondary).not.toHaveBeenCalled();
  });

  test("tooltip text reflects the open/closed state for accessibility", async () => {
    const { el } = await renderToggles({
      primaryOpen: true,
      secondaryOpen: false
    });
    const primary = el.querySelector<HTMLButtonElement>(
      '[data-testid="layout-toggle-primary"]'
    );
    const secondary = el.querySelector<HTMLButtonElement>(
      '[data-testid="layout-toggle-secondary"]'
    );
    // VS Code uses "Hide" when open / "Show" when closed; we match.
    expect(primary?.getAttribute("title")).toContain("Hide primary");
    expect(primary?.getAttribute("aria-label")).toBe("Hide primary side bar");
    expect(secondary?.getAttribute("title")).toContain("Show secondary");
    expect(secondary?.getAttribute("aria-label")).toBe(
      "Show secondary side bar"
    );
  });

  test("Glyph fills the appropriate column based on the chip's kind", async () => {
    const { el } = await renderToggles({
      primaryOpen: true,
      secondaryOpen: false
    });
    const primarySvg = el
      .querySelector('[data-testid="layout-toggle-primary"]')
      ?.querySelector("svg");
    const secondarySvg = el
      .querySelector('[data-testid="layout-toggle-secondary"]')
      ?.querySelector("svg");
    // The filled column is a <rect> with `fill="currentColor"` and
    // no stroke. Count those in each glyph.
    const filledRectsPrimary = primarySvg?.querySelectorAll(
      'rect[fill="currentColor"]'
    );
    const filledRectsSecondary = secondarySvg?.querySelectorAll(
      'rect[fill="currentColor"]'
    );
    expect(filledRectsPrimary?.length).toBe(1);
    expect(filledRectsSecondary?.length).toBe(0);
  });
});
