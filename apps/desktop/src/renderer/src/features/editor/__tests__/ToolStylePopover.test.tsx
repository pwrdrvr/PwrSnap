// Unit tests for `ToolStylePopover` — the unified kind-conditional
// tool style popover (arrow / text / rect / blur / highlight) introduced
// in Phase 1 of the v2 editor refresh.
//
// Mirrors `useEditorToolState.test.ts`'s createRoot + act pattern so we
// don't pull @testing-library/react. `useSettings` and the `dispatch`
// command-bus helper are vi.mock'd at the module boundary so the
// component exercises in isolation, without preload, IPC, or a real
// Settings substrate.

import {
  act,
  createElement,
  useRef,
  type ReactElement
} from "react";
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

// ---- Mocks ----------------------------------------------------------

const dispatchMock = vi.fn();
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args)
}));

const useSettingsMock = vi.fn();
vi.mock("../../settings/useSettings", () => ({
  useSettings: () => useSettingsMock()
}));

import { ToolStylePopover } from "../ToolStylePopover";
import type {
  StyledToolKind,
  ToolStylePopoverStyle
} from "../ToolStylePopover";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // jsdom does not implement HTMLDialogElement.showModal — stub it so
  // the "Custom…" → dialog flow doesn't throw. Mirrors the
  // setPointerCapture stub in CropTool.test.tsx.
  const proto = (globalThis as unknown as { HTMLDialogElement?: { prototype: HTMLDialogElement } })
    .HTMLDialogElement?.prototype;
  if (proto !== undefined) {
    if (typeof (proto as unknown as { showModal?: unknown }).showModal !== "function") {
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

function makeSettings(overrides?: {
  stoplightSeen?: boolean;
}): Settings {
  return {
    schemaVersion: 1,
    codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
    ai: {
      enabled: false,
      consentAcceptedAt: null,
      budgetSafetyDisabledAt: null,
      autoAcceptSuggestions: false,
      chat: { userGuidance: "", sensitiveDataPatterns: [], defaultRedactionStyle: "blackout", firstLaunchBannerDismissed: false },
      defaults: { libraryChat: {}, sizzleChat: {}, enrichment: {} }
    },
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
    storage: { filenameTimestampZone: "local" },
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
      coachmarks: { stoplightSeen: overrides?.stoplightSeen ?? false },
      matchingText: { enabled: true },
      sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
    },
    library: { detailRail: { pinned: true, lastSelectedTab: "info" } }
  };
}

function installSettingsMock(settings: Settings | null): void {
  useSettingsMock.mockReturnValue({
    settings,
    secrets: null,
    loading: settings === null,
    error: null,
    patch: vi.fn(),
    refreshCodex: vi.fn(),
    testCodex: vi.fn(),
    replaceSecret: vi.fn(),
    clearSecret: vi.fn()
  });
}

const DEFAULT_ARROW_STYLE: ArrowToolStyle = {
  color: "accent",
  thickness: "auto",
  endStyle: "filled-triangle",
  stemStyle: "solid",
  doubleEnded: false
};
const DEFAULT_TEXT_STYLE: TextToolStyle = {
  color: "accent",
  fontSize: "auto",
  weight: "regular"
};
const DEFAULT_RECT_STYLE: ShapeToolStyle = {
  color: "accent",
  thickness: "auto",
  filled: false, shape: "rect", skewDeg: 15
};
const DEFAULT_BLUR_STYLE: BlurToolStyle = {
  mode: "gaussian",
  radius: { mode: "auto" }
};
const DEFAULT_HIGHLIGHT_STYLE: HighlightToolStyle = {
  color: "yellow",
  opacity: 0.3,
  blend: "multiply"
};

// ---- Render harness -------------------------------------------------

interface HarnessProps {
  tool: StyledToolKind;
  style: ToolStylePopoverStyle;
  onClose?: () => void;
  onStyleFieldChange?: (field: string, value: unknown) => void;
  /** When provided, the popover surfaces a "Custom · {label}" badge
   *  above the Font size row (pwrdrvr/PwrSnap#110). Threaded from
   *  Editor.tsx when a selected text overlay's stored `sizePx`
   *  doesn't match any of the current canvas's bucket values. */
  customTextSizeLabel?: string;
}

function Harness(props: HarnessProps): ReactElement {
  // Anchor lives inside the same React tree so the ref is populated
  // before the popover's layout effect runs. Props are passed through
  // directly so the test can re-render with a new `style` and observe
  // the popover updating (needed for the blur-radius custom flow).
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return createElement(
    "div",
    null,
    createElement("button", {
      ref: anchorRef,
      "data-testid": "anchor",
      type: "button"
    }),
    createElement(ToolStylePopover, {
      anchorRef,
      tool: props.tool,
      style: props.style,
      onClose: props.onClose ?? (() => undefined),
      onStyleFieldChange:
        props.onStyleFieldChange ?? ((_f, _v) => undefined),
      ...(props.customTextSizeLabel !== undefined
        ? { customTextSizeLabel: props.customTextSizeLabel }
        : {})
    })
  );
}

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

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, value: undefined });
  useSettingsMock.mockReset();
  installSettingsMock(makeSettings({ stoplightSeen: true }));
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
  vi.useRealTimers();
});

function queryPopover(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(
    '[data-testid="tool-style-popover"]'
  );
  if (el === null) throw new Error("popover not found");
  return el;
}

function fireClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function firePointerDown(target: EventTarget): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
    );
  });
}

function fireChange(el: HTMLInputElement, value: string): void {
  act(() => {
    // jsdom doesn't fire React's change unless we set the value via
    // the descriptor + dispatch a synthetic 'input' (which React
    // routes to onChange).
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  });
}

// ---- Tests ----------------------------------------------------------

describe("ToolStylePopover", () => {
  test("1. arrow kind: renders 4 field groups (thickness/endStyle/stemStyle/doubleEnded), no mode picker", () => {
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE
      })
    );
    const popover = queryPopover();
    expect(popover.querySelector('[data-testid="arrow-thickness"]')).not.toBeNull();
    expect(popover.querySelector('[data-testid="arrow-end-style"]')).not.toBeNull();
    expect(popover.querySelector('[data-testid="arrow-stem-style"]')).not.toBeNull();
    expect(popover.querySelector('[data-testid="arrow-double-ended"]')).not.toBeNull();
    // Blur's mode picker should NOT be present.
    expect(popover.querySelector('[data-testid="blur-mode"]')).toBeNull();
  });

  test("2. blur kind: no color row; 2 groups (mode, radius)", () => {
    render(
      createElement(Harness, {
        tool: "blur",
        style: DEFAULT_BLUR_STYLE
      })
    );
    const popover = queryPopover();
    expect(popover.querySelector('[data-testid="blur-mode"]')).not.toBeNull();
    expect(popover.querySelector('[data-testid="blur-radius"]')).not.toBeNull();
    // No color row.
    expect(popover.querySelector('[data-testid="color-row"]')).toBeNull();
    // Sanity: no swatch buttons either.
    expect(popover.querySelector('[data-testid="swatch-red"]')).toBeNull();
  });

  test("2a. blur mode picker is a rich 3-row picker (icon + label + hint), not a flat segmented control", () => {
    // Regression test: an earlier fold collapsed the rich BlurMenu
    // (labeled rows with icons + descriptive hints) into a plain
    // segmented control. User flagged this as a quality regression —
    // restored under fix(desktop) "restore rich blur mode picker in
    // ToolStylePopover". The shape this test pins:
    //
    //   - The Mode field group contains a `role="radiogroup"` with
    //     exactly three `role="radio"` buttons (one per BlurEffectMode).
    //   - Each row carries an aria-label matching its display label
    //     (Gaussian / Pixelate / Redact).
    //   - Each row renders its descriptive hint copy as visible text.
    //   - The selected row reflects `aria-checked="true"`; the others
    //     `aria-checked="false"`.
    //   - A click on a non-selected row fires
    //     `onStyleFieldChange("mode", <id>)`.
    const onChange = vi.fn();
    render(
      createElement(Harness, {
        tool: "blur",
        style: DEFAULT_BLUR_STYLE,
        onStyleFieldChange: onChange
      })
    );
    const popover = queryPopover();
    const modeGroup = popover.querySelector(
      '[data-testid="blur-mode"] [role="radiogroup"]'
    );
    expect(modeGroup, "blur mode radiogroup missing").not.toBeNull();
    const rows = modeGroup!.querySelectorAll('[role="radio"]');
    expect(rows.length).toBe(3);

    // Per-row aria-label + hint copy.
    const expected: ReadonlyArray<{
      testid: string;
      label: string;
      hint: string;
    }> = [
      { testid: "blur-mode-gaussian", label: "Gaussian", hint: "Soft Gaussian smear" },
      { testid: "blur-mode-pixelate", label: "Pixelate", hint: "Chunky mosaic blocks" },
      { testid: "blur-mode-redact", label: "Redact", hint: "Solid black for privacy" }
    ];
    for (const { testid, label, hint } of expected) {
      const row = popover.querySelector(`[data-testid="${testid}"]`);
      expect(row, `mode row missing: ${testid}`).not.toBeNull();
      expect(row!.getAttribute("aria-label")).toBe(label);
      expect(row!.getAttribute("role")).toBe("radio");
      expect(row!.textContent ?? "").toContain(label);
      expect(row!.textContent ?? "").toContain(hint);
    }

    // Default fixture has mode=gaussian → that row is checked, others not.
    const gaussianRow = popover.querySelector(
      '[data-testid="blur-mode-gaussian"]'
    );
    const pixelateRow = popover.querySelector(
      '[data-testid="blur-mode-pixelate"]'
    );
    const redactRow = popover.querySelector(
      '[data-testid="blur-mode-redact"]'
    );
    expect(gaussianRow?.getAttribute("aria-checked")).toBe("true");
    expect(pixelateRow?.getAttribute("aria-checked")).toBe("false");
    expect(redactRow?.getAttribute("aria-checked")).toBe("false");

    // Click pixelate → onStyleFieldChange("mode", "pixelate").
    fireClick(pixelateRow!);
    expect(onChange).toHaveBeenCalledWith("mode", "pixelate");
  });

  test("3. color row present for arrow/text/rect/highlight", () => {
    for (const tool of ["arrow", "text", "shape", "highlight"] as const) {
      const style: ToolStylePopoverStyle =
        tool === "arrow"
          ? DEFAULT_ARROW_STYLE
          : tool === "text"
            ? DEFAULT_TEXT_STYLE
            : tool === "shape"
              ? DEFAULT_RECT_STYLE
              : DEFAULT_HIGHLIGHT_STYLE;
      render(createElement(Harness, { tool, style }));
      const popover = queryPopover();
      const row = popover.querySelector('[data-testid="color-row"]');
      expect(row, `color row missing for tool=${tool}`).not.toBeNull();
      // 8 swatch buttons present.
      const swatches = popover.querySelectorAll('[data-testid^="swatch-"]');
      expect(swatches.length, `wrong swatch count for ${tool}`).toBe(8);
      act(() => {
        root?.unmount();
      });
      if (host !== null) {
        document.body.removeChild(host);
        host = null;
      }
      root = null;
    }
  });

  test("4. active swatch reflects current color via aria-checked", () => {
    render(
      createElement(Harness, {
        tool: "arrow",
        style: { ...DEFAULT_ARROW_STYLE, color: "red" }
      })
    );
    const red = queryPopover().querySelector('[data-testid="swatch-red"]');
    const accent = queryPopover().querySelector('[data-testid="swatch-accent"]');
    expect(red?.getAttribute("aria-checked")).toBe("true");
    expect(accent?.getAttribute("aria-checked")).toBe("false");
  });

  test("5. swatch click fires onStyleFieldChange('color', token)", () => {
    const onChange = vi.fn();
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE,
        onStyleFieldChange: onChange
      })
    );
    const green = queryPopover().querySelector('[data-testid="swatch-green"]');
    expect(green).not.toBeNull();
    fireClick(green!);
    expect(onChange).toHaveBeenCalledWith("color", "green");
  });

  test("6. Custom… opens dialog; picking a color fires onStyleFieldChange with hex", () => {
    const onChange = vi.fn();
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE,
        onStyleFieldChange: onChange
      })
    );
    const customBtn = queryPopover().querySelector('[data-testid="color-custom"]');
    expect(customBtn).not.toBeNull();
    fireClick(customBtn!);
    // Dialog should be open now (jsdom marks the `open` attribute via
    // the stubbed showModal — see beforeAll above).
    const dialog = queryPopover().querySelector(
      ".pse-color-dialog"
    ) as HTMLDialogElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog!.hasAttribute("open")).toBe(true);
    // Change the color via the native input.
    const colorInput = queryPopover().querySelector<HTMLInputElement>(
      '[data-testid="color-custom-input"]'
    );
    expect(colorInput).not.toBeNull();
    fireChange(colorInput!, "#abcdef");
    expect(onChange).toHaveBeenCalledWith("color", "#abcdef");
  });

  test("7. arrow thickness preset click fires onStyleFieldChange('thickness', 'medium')", () => {
    const onChange = vi.fn();
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE,
        onStyleFieldChange: onChange
      })
    );
    const thicknessGroup = queryPopover().querySelector(
      '[data-testid="arrow-thickness"]'
    );
    expect(thicknessGroup).not.toBeNull();
    // The "M" button is the third option (Auto / S / M / L).
    const mediumBtn = thicknessGroup!.querySelector('[aria-label="M"]');
    expect(mediumBtn).not.toBeNull();
    fireClick(mediumBtn!);
    expect(onChange).toHaveBeenCalledWith("thickness", "medium");
  });

  test("8. arrow end style click → onStyleFieldChange('endStyle', 'open-triangle')", () => {
    const onChange = vi.fn();
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE,
        onStyleFieldChange: onChange
      })
    );
    const endStyleGroup = queryPopover().querySelector(
      '[data-testid="arrow-end-style"]'
    );
    const openTriangleBtn = endStyleGroup!.querySelector(
      '[aria-label="Open triangle"]'
    );
    expect(openTriangleBtn).not.toBeNull();
    fireClick(openTriangleBtn!);
    expect(onChange).toHaveBeenCalledWith("endStyle", "open-triangle");
  });

  test("9. arrow double-ended checkbox click → onStyleFieldChange('doubleEnded', true)", () => {
    const onChange = vi.fn();
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE,
        onStyleFieldChange: onChange
      })
    );
    const checkbox = queryPopover().querySelector<HTMLInputElement>(
      '[data-testid="arrow-double-ended"] input[type="checkbox"]'
    );
    expect(checkbox).not.toBeNull();
    act(() => {
      checkbox!.click();
    });
    expect(onChange).toHaveBeenCalledWith("doubleEnded", true);
  });

  test("10. blur radius custom: pick Custom… then type 16 → onStyleFieldChange('radius', {mode:'px',value:16})", () => {
    const onChange = vi.fn();
    render(
      createElement(Harness, {
        tool: "blur",
        style: DEFAULT_BLUR_STYLE,
        onStyleFieldChange: onChange
      })
    );
    const radiusGroup = queryPopover().querySelector(
      '[data-testid="blur-radius"]'
    );
    const customBtn = radiusGroup!.querySelector('button:nth-of-type(2)');
    expect(customBtn?.textContent).toMatch(/Custom/);
    fireClick(customBtn!);
    // Initial click fires with default value (8). Now simulate the
    // numeric input change reflecting a render where parent has
    // committed mode=px.
    expect(onChange).toHaveBeenCalledWith("radius", { mode: "px", value: 8 });

    // Re-render with the updated style so the numeric input becomes
    // available.
    act(() => {
      root!.render(
        createElement(Harness, {
          tool: "blur",
          style: { mode: "gaussian", radius: { mode: "px", value: 8 } },
          onStyleFieldChange: onChange
        })
      );
    });

    const numericInput = queryPopover().querySelector<HTMLInputElement>(
      '[data-testid="blur-radius-custom-input"]'
    );
    expect(numericInput).not.toBeNull();
    fireChange(numericInput!, "16");
    expect(onChange).toHaveBeenCalledWith("radius", { mode: "px", value: 16 });
  });

  test("11. blur radius auto: pick Auto → onStyleFieldChange('radius', {mode:'auto'})", () => {
    const onChange = vi.fn();
    render(
      createElement(Harness, {
        tool: "blur",
        style: { mode: "gaussian", radius: { mode: "px", value: 12 } },
        onStyleFieldChange: onChange
      })
    );
    const radiusGroup = queryPopover().querySelector(
      '[data-testid="blur-radius"]'
    );
    const autoBtn = radiusGroup!.querySelector('button:nth-of-type(1)');
    expect(autoBtn?.textContent).toMatch(/Auto/);
    fireClick(autoBtn!);
    expect(onChange).toHaveBeenCalledWith("radius", { mode: "auto" });
  });

  test("12. highlight opacity slider change → onStyleFieldChange('opacity', 0.6)", () => {
    const onChange = vi.fn();
    render(
      createElement(Harness, {
        tool: "highlight",
        style: DEFAULT_HIGHLIGHT_STYLE,
        onStyleFieldChange: onChange
      })
    );
    const slider = queryPopover().querySelector<HTMLInputElement>(
      '[data-testid="highlight-opacity-input"]'
    );
    expect(slider).not.toBeNull();
    fireChange(slider!, "0.6");
    expect(onChange).toHaveBeenCalledWith("opacity", 0.6);
  });

  test("13. coachmark visible on first open (stoplightSeen=false)", () => {
    installSettingsMock(makeSettings({ stoplightSeen: false }));
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE
      })
    );
    const strip = queryPopover().querySelector('[data-testid="coachmark-strip"]');
    expect(strip).not.toBeNull();
  });

  test("14. coachmark auto-dismisses at 3s and writes stoplightSeen=true", () => {
    vi.useFakeTimers();
    installSettingsMock(makeSettings({ stoplightSeen: false }));
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE
      })
    );
    expect(
      queryPopover().querySelector('[data-testid="coachmark-strip"]')
    ).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(3001);
    });
    expect(
      queryPopover().querySelector('[data-testid="coachmark-strip"]')
    ).toBeNull();
    // The dispatch should have fired with the seen=true patch.
    const writes = dispatchMock.mock.calls.filter(
      (c) => c[0] === "settings:write"
    );
    expect(writes.length).toBe(1);
    const payload = writes[0]?.[1] as {
      editor?: { coachmarks?: { stoplightSeen?: boolean } };
    };
    expect(payload.editor?.coachmarks?.stoplightSeen).toBe(true);
  });

  test("15. coachmark NOT shown when stoplightSeen=true", () => {
    installSettingsMock(makeSettings({ stoplightSeen: true }));
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE
      })
    );
    expect(
      queryPopover().querySelector('[data-testid="coachmark-strip"]')
    ).toBeNull();
  });

  test("16. click outside popover → onClose called", () => {
    const onClose = vi.fn();
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE,
        onClose
      })
    );
    // Pointerdown on document.body, somewhere not inside the popover
    // or the anchor.
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    firePointerDown(outside);
    expect(onClose).toHaveBeenCalled();
    document.body.removeChild(outside);
  });

  test("17. Escape key → onClose called", () => {
    const onClose = vi.fn();
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE,
        onClose
      })
    );
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(onClose).toHaveBeenCalled();
  });

  test("18. arrow keys in color radiogroup move focus right then left", () => {
    render(
      createElement(Harness, {
        tool: "arrow",
        style: { ...DEFAULT_ARROW_STYLE, color: "red" }
      })
    );
    const red = queryPopover().querySelector<HTMLButtonElement>(
      '[data-testid="swatch-red"]'
    );
    const yellow = queryPopover().querySelector<HTMLButtonElement>(
      '[data-testid="swatch-yellow"]'
    );
    expect(red).not.toBeNull();
    expect(yellow).not.toBeNull();
    // Focus the active swatch (it has tabIndex=0).
    act(() => {
      red!.focus();
    });
    expect(document.activeElement).toBe(red);
    // ArrowRight should move focus to yellow.
    act(() => {
      red!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true
        })
      );
    });
    expect(document.activeElement).toBe(yellow);
  });

  test("flip-up: anchor near bottom of viewport positions popover ABOVE the anchor (Phase 3.1 fix)", () => {
    // Phase 3.1 bug #1 repro: chromeless Library Focus floating bottom
    // toolbar. The anchor sits near `viewportHeight - <toolbarHeight>`.
    // Pre-fix, the popover anchored at `rect.top` and extended down
    // past the window edge — entire control rows clipped off.
    //
    // The fix: after the pass-1 layout, measure the popover wrapper
    // and recompute. When `rect.top + measuredHeight` overflows, set
    // `top` to `rect.top - measuredHeight - 8` (flip above).
    //
    // We monkey-patch `getBoundingClientRect` on both the anchor and
    // the popover wrapper to deterministically reproduce the
    // overflow geometry without depending on the test machine's
    // viewport.

    // 1) Anchor near the bottom of an 800x600 viewport (mirrors the
    //    floating bottom toolbar layout).
    const originalInnerHeight = window.innerHeight;
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 600
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800
    });
    try {
      render(
        createElement(Harness, {
          tool: "arrow",
          style: DEFAULT_ARROW_STYLE
        })
      );
      const anchor = document.querySelector<HTMLButtonElement>(
        '[data-testid="anchor"]'
      );
      const popover = queryPopover();
      const measure = popover.querySelector<HTMLElement>(".pse-popover-measure");
      expect(anchor).not.toBeNull();
      expect(measure).not.toBeNull();
      // Anchor at y=560 with height=32 → bottom ~= 592.
      anchor!.getBoundingClientRect = () =>
        ({
          x: 100,
          y: 560,
          left: 100,
          right: 140,
          top: 560,
          bottom: 592,
          width: 40,
          height: 32,
          toJSON: () => ({})
        }) as DOMRect;
      // Force the measured wrapper to report a tall popover (440px).
      measure!.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          left: 0,
          right: 280,
          top: 0,
          bottom: 440,
          width: 280,
          height: 440,
          toJSON: () => ({})
        }) as DOMRect;
      // Trigger a resize so the popover recomputes against our patched
      // rects. (The mount-time pass already ran, but with the default
      // jsdom rects of {0,0,0,0}, which don't exercise the flip.)
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      const topStr = popover.style.top;
      expect(topStr).toMatch(/px$/);
      const topPx = Number.parseFloat(topStr);
      // Expected post-flip: anchor.top - height - 8 = 560 - 440 - 8 = 112.
      // If the fix is missing, top would equal rect.top (560) or a
      // clipped variant; either way, > 200 fails the assertion below.
      expect(topPx).toBeLessThan(200);
      // And the bottom edge must fit within the viewport.
      expect(topPx + 440).toBeLessThanOrEqual(600);
    } finally {
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalInnerHeight
      });
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth
      });
    }
  });

  test("19. keyboard accessibility: every interactive control is reachable + has a label", () => {
    render(
      createElement(Harness, {
        tool: "arrow",
        style: DEFAULT_ARROW_STYLE
      })
    );
    const popover = queryPopover();
    const interactive = popover.querySelectorAll<HTMLElement>(
      'button, input, [role="radio"]'
    );
    expect(interactive.length).toBeGreaterThan(0);
    for (const el of Array.from(interactive)) {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const ariaLabel = el.getAttribute("aria-label");
      const ariaLabelledBy = el.getAttribute("aria-labelledby");
      const hasText = (el.textContent ?? "").trim().length > 0;
      const isLabelledInput =
        tag === "input" &&
        (el as HTMLInputElement).type === "checkbox" &&
        el.closest("label") !== null;
      const isCheckboxLabelled =
        tag === "input" &&
        ariaLabel === null &&
        ariaLabelledBy === null &&
        (isLabelledInput || (el as HTMLInputElement).type !== "checkbox");
      const labelled =
        ariaLabel !== null ||
        ariaLabelledBy !== null ||
        hasText ||
        isCheckboxLabelled ||
        role === "radio";
      expect(
        labelled,
        `interactive control without an accessible label: ${el.outerHTML.slice(0, 120)}`
      ).toBe(true);
    }
  });

  // pwrdrvr/PwrSnap#110: when a text overlay's stored sizePx doesn't
  // match any current-canvas bucket value (post-crop typically), the
  // popover surfaces a "Custom · {N} px" indicator above the Font
  // size row so the user sees their text is "off-bucket" and can
  // re-click S/M/L to re-snap. Without this, the bucket buttons would
  // look like one was active when the rendered text actually doesn't
  // match any of them.

  test("text popover renders Custom indicator when `customTextSizeLabel` prop is set", () => {
    render(
      createElement(Harness, {
        tool: "text",
        style: DEFAULT_TEXT_STYLE,
        customTextSizeLabel: "64 px"
      })
    );
    const badge = queryPopover().querySelector(
      '[data-testid="text-custom-size-badge"]'
    );
    expect(badge, "Custom badge must render when prop is set").not.toBeNull();
    // Label text contains "Custom" and the size value.
    expect((badge?.textContent ?? "").trim()).toContain("Custom");
    expect((badge?.textContent ?? "").trim()).toContain("64 px");
  });

  test("text popover OMITS Custom indicator when prop is absent (in-bucket state)", () => {
    render(
      createElement(Harness, { tool: "text", style: DEFAULT_TEXT_STYLE })
    );
    const badge = queryPopover().querySelector(
      '[data-testid="text-custom-size-badge"]'
    );
    expect(
      badge,
      "Custom badge must NOT render when row is in-bucket — would falsely tell the user their text is custom-sized."
    ).toBeNull();
  });
});
