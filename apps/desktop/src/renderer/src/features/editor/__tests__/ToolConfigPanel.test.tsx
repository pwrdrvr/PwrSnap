// Unit tests for ToolConfigPanel — the right-sidebar mirror of the
// inline ToolStylePopover body. Drives the panel directly with
// (activeTool, activeStyle, onStyleFieldChange) props since task #9
// hasn't wired the parent Editor.tsx yet; the panel doesn't own
// `useEditorToolState` (parent does, single source of truth).
//
// Test harness mirrors ToolStylePopover.test.tsx: bare React +
// createRoot + act, with `useSettings` mocked because <ToolStyleBody>
// pulls it transitively through the ToolStylePopover module's
// ColorRow children. dispatch is mocked too — the panel itself
// doesn't dispatch, but the shared body module imports it.

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
import type {
  ArrowToolStyle,
  BlurToolStyle,
  HighlightToolStyle,
  ShapeToolStyle,
  Settings,
  TextToolStyle
} from "@pwrsnap/shared";

// ---- Mocks (mirror ToolStylePopover.test.tsx) -----------------------

const dispatchMock = vi.fn();
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args)
}));

const useSettingsMock = vi.fn();
vi.mock("../../settings/useSettings", () => ({
  useSettings: () => useSettingsMock()
}));

import { ToolConfigPanel } from "../panels/ToolConfigPanel";
import type { ActiveStyle } from "../useEditorToolState";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // jsdom does not implement HTMLDialogElement.showModal — stub so
  // the Custom… affordance in ColorRow doesn't crash a test that
  // happens to click it. Mirrors ToolStylePopover.test.tsx.
  const proto = (
    globalThis as unknown as { HTMLDialogElement?: { prototype: HTMLDialogElement } }
  ).HTMLDialogElement?.prototype;
  if (proto !== undefined) {
    if (
      typeof (proto as unknown as { showModal?: unknown }).showModal !==
      "function"
    ) {
      (proto as unknown as { showModal: () => void }).showModal = function () {
        (this as HTMLDialogElement).setAttribute("open", "");
      };
    }
    if (typeof (proto as unknown as { show?: unknown }).show !== "function") {
      (proto as unknown as { show: () => void }).show = function () {
        (this as HTMLDialogElement).setAttribute("open", "");
      };
    }
    if (typeof (proto as unknown as { close?: unknown }).close !== "function") {
      (proto as unknown as { close: () => void }).close = function () {
        (this as HTMLDialogElement).removeAttribute("open");
      };
    }
  }
});

// ---- Fixtures -------------------------------------------------------

function makeSettings(): Settings {
  return {
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
      coachmarks: { stoplightSeen: true },
      matchingText: { enabled: true },
      sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
    },
    library: { detailRail: { pinned: true, lastSelectedTab: "info" } }
  };
}

function installSettingsMock(): void {
  useSettingsMock.mockReturnValue({
    settings: makeSettings(),
    secrets: null,
    loading: false,
    error: null,
    patch: vi.fn(),
    refreshCodex: vi.fn(),
    testCodex: vi.fn(),
    replaceSecret: vi.fn(),
    clearSecret: vi.fn()
  });
}

const ARROW: ArrowToolStyle = {
  color: "accent",
  thickness: "auto",
  endStyle: "filled-triangle",
  stemStyle: "solid",
  doubleEnded: false
};
const TEXT: TextToolStyle = { color: "accent", fontSize: "auto", weight: "regular" };
const RECT: ShapeToolStyle = { color: "accent", thickness: "auto", filled: false, shape: "rect", skewDeg: 15 };
const BLUR: BlurToolStyle = { mode: "gaussian", radius: { mode: "auto" } };
const HIGHLIGHT: HighlightToolStyle = {
  color: "yellow",
  opacity: 0.3,
  blend: "multiply"
};

// ---- Render harness -------------------------------------------------

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: ReactElement): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

function fireClick(el: Element): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
  });
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, value: undefined });
  useSettingsMock.mockReset();
  installSettingsMock();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  if (host !== null) {
    document.body.removeChild(host);
    host = null;
  }
  root = null;
});

function q(selector: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(selector) ?? null;
}

// ---- Tests ----------------------------------------------------------

describe("ToolConfigPanel", () => {
  test("1. activeTool='pointer' → empty state rendered", () => {
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "pointer",
        activeStyle: { tool: "pointer" } as ActiveStyle,
        onStyleFieldChange: vi.fn()
      })
    );
    const empty = q(".pse-tool-config-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("Select a tool");
  });

  test("2. activeTool='crop' → empty state rendered", () => {
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "crop",
        activeStyle: { tool: "crop" } as ActiveStyle,
        onStyleFieldChange: vi.fn()
      })
    );
    const empty = q(".pse-tool-config-empty");
    expect(empty).not.toBeNull();
  });

  test("3. activeTool='arrow' renders arrow controls (color + thickness + endStyle + stemStyle + doubleEnded)", () => {
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "arrow",
        activeStyle: { tool: "arrow", style: ARROW } as ActiveStyle,
        onStyleFieldChange: vi.fn()
      })
    );
    expect(q('[data-testid="color-row"]')).not.toBeNull();
    expect(q('[data-testid="arrow-thickness"]')).not.toBeNull();
    expect(q('[data-testid="arrow-end-style"]')).not.toBeNull();
    expect(q('[data-testid="arrow-stem-style"]')).not.toBeNull();
    expect(q('[data-testid="arrow-double-ended"]')).not.toBeNull();
  });

  test("4. activeTool='text' renders text controls (color + fontSize + weight)", () => {
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "text",
        activeStyle: { tool: "text", style: TEXT } as ActiveStyle,
        onStyleFieldChange: vi.fn()
      })
    );
    expect(q('[data-testid="color-row"]')).not.toBeNull();
    expect(q('[data-testid="text-font-size"]')).not.toBeNull();
    expect(q('[data-testid="text-weight"]')).not.toBeNull();
  });

  test("5. activeTool='shape' renders shape controls (color + kind picker + thickness + filled)", () => {
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "shape",
        activeStyle: { tool: "shape", style: RECT } as ActiveStyle,
        onStyleFieldChange: vi.fn()
      })
    );
    expect(q('[data-testid="color-row"]')).not.toBeNull();
    expect(q('[data-testid="shape-kind"]')).not.toBeNull();
    expect(q('[data-testid="shape-thickness"]')).not.toBeNull();
    expect(q('[data-testid="shape-filled"]')).not.toBeNull();
  });

  test("6. activeTool='blur' renders blur controls — no color row", () => {
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "blur",
        activeStyle: { tool: "blur", style: BLUR } as ActiveStyle,
        onStyleFieldChange: vi.fn()
      })
    );
    expect(q('[data-testid="blur-mode"]')).not.toBeNull();
    expect(q('[data-testid="blur-radius"]')).not.toBeNull();
    // Blur has no color field.
    expect(q('[data-testid="color-row"]')).toBeNull();
  });

  test("7. activeTool='highlight' renders highlight controls including opacity slider", () => {
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "highlight",
        activeStyle: { tool: "highlight", style: HIGHLIGHT } as ActiveStyle,
        onStyleFieldChange: vi.fn()
      })
    );
    expect(q('[data-testid="color-row"]')).not.toBeNull();
    expect(q('[data-testid="highlight-opacity"]')).not.toBeNull();
    expect(q('[data-testid="highlight-opacity-input"]')).not.toBeNull();
    expect(q('[data-testid="highlight-blend"]')).not.toBeNull();
  });

  test("8. swatch click → onStyleFieldChange('arrow', 'color', 'green')", () => {
    const onChange = vi.fn();
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "arrow",
        activeStyle: { tool: "arrow", style: ARROW } as ActiveStyle,
        onStyleFieldChange: onChange
      })
    );
    const green = q('[data-testid="swatch-green"]');
    expect(green).not.toBeNull();
    fireClick(green!);
    expect(onChange).toHaveBeenCalledWith("arrow", "color", "green");
  });

  test("9. thickness preset click → onStyleFieldChange('arrow', 'thickness', 'medium')", () => {
    const onChange = vi.fn();
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "arrow",
        activeStyle: { tool: "arrow", style: ARROW } as ActiveStyle,
        onStyleFieldChange: onChange
      })
    );
    const group = q('[data-testid="arrow-thickness"]');
    expect(group).not.toBeNull();
    const mediumBtn = group!.querySelector<HTMLElement>('[aria-label="M"]');
    expect(mediumBtn).not.toBeNull();
    fireClick(mediumBtn!);
    expect(onChange).toHaveBeenCalledWith("arrow", "thickness", "medium");
  });

  test("10. title reads '{Tool} style' (e.g., 'Arrow style')", () => {
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "arrow",
        activeStyle: { tool: "arrow", style: ARROW } as ActiveStyle,
        onStyleFieldChange: vi.fn()
      })
    );
    const title = q(".pse-tool-config-title");
    expect(title?.tagName.toLowerCase()).toBe("h3");
    expect(title?.textContent).toBe("Arrow style");
  });

  test("11. blur tool title reads 'Blur style'", () => {
    render(
      createElement(ToolConfigPanel, {
        captureId: "cap_1",
        activeTool: "blur",
        activeStyle: { tool: "blur", style: BLUR } as ActiveStyle,
        onStyleFieldChange: vi.fn()
      })
    );
    expect(q(".pse-tool-config-title")?.textContent).toBe("Blur style");
  });
});
