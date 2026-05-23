// Behavior tests for the v2-refresh of Library's EditToolbar. Verifies
// that the chromeless inline editor (Library Focus / Reel) wires up
// useEditorToolState the same way the standalone Editor window does
// (per docs/plans/2026-05-23-001-feat-v2-editor-plan.md task #10):
//
//   • All 7 tool buttons render (pointer / arrow / rect / highlight /
//     blur / text / crop).
//   • Click a tool → hook activates that tool, parent's `onChange`
//     fires with the same id (controlled-prop contract preserved).
//   • Place an arrow → broadcast handler calls
//     `useEditorToolState.onAnnotationPlaced`, matching-text affordance
//     pops near the arrow's tail.
//   • Click "+ Add label" → tool flips to text (matching-text armed).
//   • ⌥-click a tool → single-shot mode; one placement returns to
//     pointer.
//
// Test harness mirrors `useEditorToolState.test.ts` + `DetailRail.test.tsx`:
// plain React `createRoot` + `act` so we don't pull
// @testing-library/react for one suite. dispatch / subscribe /
// useSettings are vi.mock'd so the toolbar runs without IPC.

import {
  act,
  createElement,
  useState,
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
  OverlayRow,
  Settings
} from "@pwrsnap/shared";

// ---- Mocks (module boundary) ---------------------------------------

const dispatchMock = vi.fn();
let subscribeHandlers: Array<(payload: unknown) => void> = [];
const subscribeMock = vi.fn(
  (_channel: string, handler: (payload: unknown) => void) => {
    subscribeHandlers.push(handler);
    return () => {
      subscribeHandlers = subscribeHandlers.filter((h) => h !== handler);
    };
  }
);

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
  subscribe: (...args: unknown[]) =>
    subscribeMock(
      args[0] as string,
      args[1] as (payload: unknown) => void
    )
}));

const useSettingsMock = vi.fn();
vi.mock("../../settings/useSettings", () => ({
  useSettings: () => useSettingsMock()
}));

import { EditToolbar } from "../EditToolbar";
import type { Tool } from "../../editor/editor-tools";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // jsdom doesn't implement these — the BlurMenu + ToolStylePopover use
  // dialog.showModal + ResizeObserver indirectly. Light stubs keep the
  // module load + initial render from throwing.
  const proto = (globalThis as unknown as { HTMLDialogElement?: { prototype: HTMLDialogElement } })
    .HTMLDialogElement?.prototype;
  if (proto !== undefined) {
    if (typeof (proto as unknown as { showModal?: unknown }).showModal !== "function") {
      (proto as unknown as { showModal: () => void }).showModal = function () {
        (this as HTMLDialogElement).setAttribute("open", "");
      };
    }
  }
  if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver !== "function") {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {
        /* no-op */
      }
      unobserve(): void {
        /* no-op */
      }
      disconnect(): void {
        /* no-op */
      }
    };
  }
});

// ---- Fixtures ------------------------------------------------------

function makeSettings(matchingTextEnabled = true): Settings {
  return {
    schemaVersion: 1,
    codex: { mode: "auto", pinnedPath: "", profile: "" },
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
        rect: { color: "accent", thickness: "auto", filled: false },
        blur: { mode: "gaussian", radius: { mode: "auto" } },
        highlight: { color: "yellow", opacity: 0.3, blend: "multiply" }
      },
      coachmarks: { stoplightSeen: true },
      matchingText: { enabled: matchingTextEnabled },
      sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
    }
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

function makeArrowRow(
  id: string,
  fromXY: { x: number; y: number },
  toXY: { x: number; y: number } = { x: 0.5, y: 0.5 }
): OverlayRow {
  return {
    id,
    capture_id: "cap-1",
    data: {
      kind: "arrow",
      from: fromXY,
      to: toXY,
      color: "auto"
    },
    schema_version: 1,
    created_at: new Date().toISOString(),
    applied_at: null,
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 0
  };
}

// ---- Render harness -------------------------------------------------

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface HarnessProps {
  initialTool?: Tool;
  captureId?: string;
  /** Hook back into the parent's setTool so a test can observe
   *  controlled-prop transitions. */
  onToolChange?: (next: Tool) => void;
}

function Harness(props: HarnessProps): ReactElement {
  const [tool, setTool] = useState<Tool>(props.initialTool ?? "pointer");
  return createElement(EditToolbar, {
    tool,
    onChange: (next: Tool) => {
      setTool(next);
      props.onToolChange?.(next);
    },
    captureId: props.captureId ?? "cap-1",
    sourceWidth: 800,
    sourceHeight: 600,
    blurStyle: "gaussian",
    onBlurStyleChange: () => undefined
  });
}

async function render(node: ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  // Inject a stub `.editor-canvas` element so EditToolbar's
  // matching-text positioning + CropTool's canvas-rect resolution
  // find a target. The chromeless Editor renders this in production;
  // the test harness omits the Editor entirely so we stub it.
  const stubCanvas = document.createElement("div");
  stubCanvas.className = "editor-canvas";
  // jsdom's gBCR returns all zeros by default — replace with a
  // realistic non-zero rect so the matching-text affordance's
  // viewport translation produces sane coords.
  stubCanvas.getBoundingClientRect = () =>
    ({
      x: 40,
      y: 80,
      left: 40,
      top: 80,
      right: 840,
      bottom: 680,
      width: 800,
      height: 600,
      toJSON() {
        return this;
      }
    }) as DOMRect;
  document.body.appendChild(stubCanvas);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  // Drain microtasks for the initial library:byId + overlays:list
  // dispatch chain (useCaptureModel runs them sequentially before
  // resolving out of `kind: "loading"`).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findToolButton(id: Tool): HTMLButtonElement {
  // Blur renders through BlurMenu (no data-tool attribute on the
  // root button); fall back to the title attribute for it.
  const el = host?.querySelector<HTMLButtonElement>(
    `button[data-tool="${id}"]`
  );
  if (el !== null && el !== undefined) return el;
  // Blur fallback — its inner button uses class ed-blur-btn.
  if (id === "blur") {
    const blur = host?.querySelector<HTMLButtonElement>(".ed-blur-btn");
    if (blur !== null && blur !== undefined) return blur;
  }
  throw new Error(`tool button not found: ${id}`);
}

async function fireClick(
  el: HTMLElement,
  init: { altKey?: boolean } = {}
): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        altKey: init.altKey === true
      })
    );
  });
}

/** v1 CaptureRecord stub used by both initial-load and broadcast
 *  refetch paths. Tests don't care about the record fields beyond
 *  what useCaptureModel + the renderer touch — bundle_format_version
 *  matters most (must be 1 so the model resolves to the v1 branch). */
function makeStubRecord() {
  return {
    id: "cap-1",
    kind: "image" as const,
    captured_at: "2026-05-23T12:00:00.000Z",
    legacy_src_path: null,
    bundle_path: "/tmp/cap-1.pwrsnap",
    flat_png_path: null,
    bundle_modified_at: "2026-05-23T12:00:00.000Z",
    bundle_format_version: 1,
    bundle_edits_version: 0,
    width_px: 800,
    height_px: 600,
    device_pixel_ratio: 2,
    byte_size: 0,
    sha256: "0".repeat(64),
    source_app_bundle_id: null,
    source_app_name: null,
    edits_version: 0,
    deleted_at: null
  };
}

async function fireBroadcast(rows: OverlayRow[]): Promise<void> {
  // Configure the mock so the subscribe handler's awaited library:byId
  // + overlays:list refetch returns fresh data. useCaptureModel's
  // events:overlays:changed handler does ONE library:byId + ONE
  // overlays:list per broadcast for v1 captures, so both verbs need
  // to resolve.
  dispatchMock.mockImplementation(async (name: string) => {
    if (name === "library:byId") {
      return { ok: true, value: makeStubRecord() };
    }
    if (name === "overlays:list") return { ok: true, value: rows };
    return { ok: true, value: undefined };
  });
  await act(async () => {
    for (const h of subscribeHandlers) {
      h({ captureId: "cap-1" });
    }
  });
  // Drain the microtasks that the listener kicks off (the inner
  // async iife awaits dispatch + setState). One extra tick for the
  // library:byId + overlays:list chain useCaptureModel runs.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  dispatchMock.mockReset();
  // Default dispatch: library:byId returns a v1 capture; overlays:list
  // returns empty; settings:write OK. Phase 2 EditToolbar reads through
  // useCaptureModel which dispatches library:byId before overlays:list,
  // so both verbs must respond for the model to resolve out of
  // `kind: "loading"`.
  dispatchMock.mockImplementation(async (name: string) => {
    if (name === "library:byId") {
      return { ok: true, value: makeStubRecord() };
    }
    if (name === "overlays:list") return { ok: true, value: [] };
    return { ok: true, value: undefined };
  });
  subscribeMock.mockClear();
  subscribeHandlers = [];
  useSettingsMock.mockReset();
  installSettingsMock(makeSettings(true));
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  if (host !== null) {
    document.body.removeChild(host);
    host = null;
  }
  // Remove any stub canvases injected by render().
  document.querySelectorAll(".editor-canvas").forEach((el) => el.remove());
  root = null;
  vi.useRealTimers();
});

// ---- Tests ----------------------------------------------------------

describe("EditToolbar (Library Focus, v2 refresh)", () => {
  test("1. renders all 7 tool buttons (pointer/arrow/rect/highlight/blur/text/crop)", async () => {
    await render(createElement(Harness));

    // 6 of 7 carry data-tool — pointer/arrow/rect/highlight/text/crop.
    // Blur renders through BlurMenu (its own button class).
    const dataTooled = host?.querySelectorAll("button[data-tool]");
    expect(dataTooled?.length).toBe(6);
    for (const id of ["pointer", "arrow", "rect", "highlight", "text", "crop"] as const) {
      expect(findToolButton(id)).toBeTruthy();
    }
    // Blur button exists too — via BlurMenu.
    expect(findToolButton("blur")).toBeTruthy();
  });

  test("2. click arrow → activeTool = arrow, parent onChange fires with 'arrow'", async () => {
    const onToolChange = vi.fn<(t: Tool) => void>();
    await render(createElement(Harness, { onToolChange }));

    await fireClick(findToolButton("arrow"));

    // The arrow button reads is-active.
    expect(findToolButton("arrow").className).toContain("is-active");
    // Parent observed the controlled-prop change.
    expect(onToolChange).toHaveBeenCalledWith("arrow");
  });

  test("3. place an arrow (overlay broadcast) → onAnnotationPlaced fires; matching-text affordance appears", async () => {
    await render(createElement(Harness, { initialTool: "arrow" }));

    // Sanity: arrow button is active after the prop sync settles.
    expect(findToolButton("arrow").className).toContain("is-active");

    // Simulate the chromeless Editor persisting a new user-source
    // arrow overlay. The broadcast triggers EditToolbar's
    // overlays:list refetch; the listener picks up the new row
    // (not seen before in the seeded empty set) and feeds it to
    // onAnnotationPlaced. matchingText then transitions to
    // "available".
    const arrow = makeArrowRow("ov-1", { x: 0.25, y: 0.4 });
    await fireBroadcast([arrow]);

    const affordance = host?.querySelector(
      '[data-testid="matching-text-affordance"]'
    );
    expect(affordance).not.toBeNull();
  });

  test("4. click '+ Add label' → tool flips to text", async () => {
    const onToolChange = vi.fn<(t: Tool) => void>();
    await render(
      createElement(Harness, { initialTool: "arrow", onToolChange })
    );

    const arrow = makeArrowRow("ov-1", { x: 0.5, y: 0.5 });
    await fireBroadcast([arrow]);

    const affordance = host?.querySelector<HTMLButtonElement>(
      '[data-testid="matching-text-affordance"]'
    );
    expect(affordance).not.toBeNull();
    onToolChange.mockClear();
    await fireClick(affordance as HTMLButtonElement);

    // Hook transitions activeTool from arrow → text on
    // clickMatchingTextAffordance; the prop-sync effect then fires
    // onChange with "text".
    expect(onToolChange).toHaveBeenCalledWith("text");
    expect(findToolButton("text").className).toContain("is-active");
  });

  test("5. ⌥-click arrow → single-shot; placing one arrow returns to pointer", async () => {
    const onToolChange = vi.fn<(t: Tool) => void>();
    await render(createElement(Harness, { onToolChange }));

    // ⌥-click arrow → activates with singleShot=true.
    await fireClick(findToolButton("arrow"), { altKey: true });
    expect(findToolButton("arrow").className).toContain("is-active");

    onToolChange.mockClear();
    // Place an arrow — onAnnotationPlaced sees singleShot and flips
    // back to pointer.
    const arrow = makeArrowRow("ov-1", { x: 0.5, y: 0.5 });
    await fireBroadcast([arrow]);

    // Tool returned to pointer; parent saw the transition.
    expect(onToolChange).toHaveBeenCalledWith("pointer");
    expect(findToolButton("pointer").className).toContain("is-active");
    // No matching-text affordance in single-shot mode — the hook
    // suppresses it.
    expect(
      host?.querySelector('[data-testid="matching-text-affordance"]')
    ).toBeNull();
  });
});
