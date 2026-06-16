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
  BundleLayerNode,
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
import { useEditorToolState } from "../../editor/useEditorToolState";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // jsdom doesn't implement these — the ToolStylePopover uses
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
    codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
    ai: { enabled: false, consentAcceptedAt: null, budgetSafetyDisabledAt: null, autoAcceptSuggestions: false, chat: { userGuidance: "", sensitiveDataPatterns: [], defaultRedactionStyle: "blackout", firstLaunchBannerDismissed: false }, defaults: { libraryChat: {}, sizzleChat: {}, enrichment: {} }, acp: { enabledAgentIds: [] } },
    hotkeys: {
      quickCapture: "CommandOrControl+Shift+C",
      region: "",
      window: "",
      fullScreen: "",
      allScreens: "",
      timed: "",
      videoCapture: "CommandOrControl+Alt+C",
      reshowFloatOver: "CommandOrControl+Alt+Shift+F"
    },
    general: { developerMode: false, launchAtLogin: false },
    experimental: { processSplit: true, dpiAwareExport: false, allowRetinaExport: true },
    appearance: { theme: "system" },
    updates: { channel: "latest" },
    storage: { filenameTimestampZone: "local" },
    recording: {
      includeSystemAudio: false,
      includeMicrophone: false,
      videoCaptureCursor: true,
      imageCaptureCursor: true,
      lastRoutedPermissionFingerprint: "",
      screenCapturePrompted: false
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
      matchingText: { enabled: matchingTextEnabled },
      sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
    },
    library: { detailRail: { pinned: true, lastSelectedTab: "info" }, confirmBeforeTrash: true, gridZoom: 180 }
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

/** Wrap an OverlayRow into a vector BundleLayerNode. EditToolbar reads
 *  the layer tree (v2) via useCaptureModel and projects vector layers
 *  back to OverlayRow shape for placement detection — this is the
 *  inverse, so tests can keep authoring overlay rows. */
function rowToVectorLayer(row: OverlayRow): BundleLayerNode {
  return {
    id: row.id,
    parent_id: "ly_root",
    kind: "vector",
    shape: row.data,
    name: "Arrow",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: row.z_index,
    source: row.source,
    ai_run_id: row.ai_run_id,
    applied_at: row.applied_at,
    rejected_at: row.rejected_at,
    superseded_by: row.superseded_by,
    created_at: row.created_at
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
  // All tool buttons (blur included, post-BlurMenu-fold) carry a
  // `data-tool="<id>"` attribute. The bespoke `.ed-blur-btn`
  // selector that used to back blur is no longer needed.
  const el = host?.querySelector<HTMLButtonElement>(
    `button[data-tool="${id}"]`
  );
  if (el !== null && el !== undefined) return el;
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

/** CaptureRecord stub used by both initial-load and broadcast refetch
 *  paths. Tests don't care about the record fields beyond what
 *  useCaptureModel + the renderer touch — bundle_format_version
 *  matters most (must be 2 so the model resolves the v2 layer tree). */
function makeStubRecord() {
  return {
    id: "cap-1",
    kind: "image" as const,
    captured_at: "2026-05-23T12:00:00.000Z",
    legacy_src_path: null,
    bundle_path: "/tmp/cap-1.pwrsnap",
    flat_png_path: null,
    bundle_modified_at: "2026-05-23T12:00:00.000Z",
    bundle_format_version: 2,
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
  // + layers:list refetch returns fresh data. useCaptureModel's
  // events:overlays:changed handler does ONE library:byId + ONE
  // layers:list per broadcast, so both verbs need to resolve. The
  // authored OverlayRows are wrapped as vector layers; EditToolbar
  // projects them back to OverlayRow shape for placement detection.
  const layers = rows.map(rowToVectorLayer);
  dispatchMock.mockImplementation(async (name: string) => {
    if (name === "library:byId") {
      return { ok: true, value: makeStubRecord() };
    }
    if (name === "layers:list") return { ok: true, value: layers };
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
  // Default dispatch: library:byId returns a v2 capture; layers:list
  // returns empty; settings:write OK. EditToolbar reads through
  // useCaptureModel which dispatches library:byId before layers:list,
  // so both verbs must respond for the model to resolve out of
  // `kind: "loading"`.
  dispatchMock.mockImplementation(async (name: string) => {
    if (name === "library:byId") {
      return { ok: true, value: makeStubRecord() };
    }
    if (name === "layers:list") return { ok: true, value: [] };
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

    // Post-BlurMenu-fold: all 7 tool buttons carry the same
    // `data-tool` attribute. Earlier shape rendered blur through a
    // bespoke <BlurMenu>; we now use the unified ToolButton + caret
    // pattern for every styled tool.
    const dataTooled = host?.querySelectorAll("button[data-tool]");
    expect(dataTooled?.length).toBe(7);
    for (const id of [
      "pointer",
      "arrow",
      "shape",
      "highlight",
      "blur",
      "text",
      "crop"
    ] as const) {
      expect(findToolButton(id)).toBeTruthy();
    }
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

  test("Phase 3.2 lift: when parent passes `toolState`, EditToolbar reads from it instead of its own hook", async () => {
    // The Library lifts `useEditorToolState` to its level so the
    // chromeless Editor and the floating EditToolbar share ONE hook
    // instance. We mimic that here by instantiating the hook in a
    // wrapper component and threading it to EditToolbar via the new
    // `toolState` prop. Switching tools through the toolbar should
    // reflect in the parent-owned hook's `activeTool`, proving the
    // toolbar isn't shadowing into a private copy.
    const observedActiveTool: { value: Tool } = { value: "pointer" };

    function LiftedHarness(): ReactElement {
      const lifted = useEditorToolState({ captureId: "cap-1" });
      observedActiveTool.value = lifted.activeTool;
      return createElement(EditToolbar, {
        tool: lifted.activeTool,
        onChange: () => undefined,
        toolState: lifted,
        captureId: "cap-1",
        sourceWidth: 800,
        sourceHeight: 600,
        blurStyle: "gaussian",
        onBlurStyleChange: () => undefined
      });
    }

    await render(createElement(LiftedHarness));

    // Initial: pointer.
    expect(observedActiveTool.value).toBe("pointer");
    // Click arrow in the toolbar → lifted hook flips.
    await fireClick(findToolButton("arrow"));
    expect(observedActiveTool.value).toBe("arrow");
    // Click rect → lifted hook flips again.
    await fireClick(findToolButton("shape"));
    expect(observedActiveTool.value).toBe("shape");
  });

  test("6. v2 Reset on a previously off-origin-cropped capture restores raster transform to identity", async () => {
    // User-reported bug (pwrdrvr/PwrSnap#110):
    //
    //   1. Open a v2 capture (raster at identity transform).
    //   2. Drag a CENTER crop → useCaptureModel Step 0.5 translates
    //      the raster's transform by (-rect.x × oldW, -rect.y × oldH)
    //      so the new (smaller) canvas displays the chosen region.
    //   3. Click Reset.
    //
    // Pre-fix: Reset deleted user-facing layers + restored canvas
    // dims via bundle:updateCanvasDimensions, but left the raster
    // at its TRANSLATED transform. The full-dim canvas then showed
    // the raster offset from the top-left with empty space on the
    // opposite edges. The user reported "misaligned in its own
    // viewport / canvas and can't be fixed".
    //
    // Post-fix: Reset detects a non-identity raster transform and
    // delete-plus-inserts the raster with transform [1,0,0,1,0,0]
    // alongside the canvas-dim restore.
    const captureId = "cap-v2-cropped";
    const translatedRasterId = "ly_raster_translated";
    const v2Record = {
      ...makeStubRecord(),
      id: captureId,
      bundle_format_version: 2,
      // Cropped state — canvas smaller than the raster's natural dims.
      width_px: 2221,
      height_px: 1162
    };
    const v2Layers = [
      // Root group.
      {
        id: "ly_root",
        parent_id: null,
        name: "Root",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal" as const,
        transform: [1, 0, 0, 1, 0, 0] as const,
        z_index: 0,
        source: "user" as const,
        ai_run_id: null,
        applied_at: null,
        rejected_at: null,
        superseded_by: null,
        created_at: new Date().toISOString(),
        kind: "group" as const,
        collapsed: false
      },
      // Raster — TRANSLATED by a previous off-origin crop.
      // (-516.6, -167.4) matches the user's PR #110 diagnostic.
      {
        id: translatedRasterId,
        parent_id: "ly_root",
        name: "Source",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal" as const,
        transform: [1, 0, 0, 1, -516.6, -167.4] as const,
        z_index: 0,
        source: "user" as const,
        ai_run_id: null,
        applied_at: null,
        rejected_at: null,
        superseded_by: null,
        created_at: new Date().toISOString(),
        kind: "raster" as const,
        source_ref: { kind: "embedded" as const, sha256: "a".repeat(64) },
        natural_width_px: 2880,
        natural_height_px: 1920
      }
    ];

    dispatchMock.mockImplementation(async (name: string, req: unknown) => {
      if (name === "library:byId") return { ok: true, value: v2Record };
      if (name === "layers:list") return { ok: true, value: v2Layers };
      // overlays:list is gated by v1 — v2 captures should never hit it,
      // but be defensive in case useCaptureModel still probes.
      if (name === "overlays:list")
        return {
          ok: false,
          error: {
            kind: "validation" as const,
            code: "v2_capture_use_layers_ipc"
          }
        };
      if (name === "layers:delete")
        return { ok: true, value: undefined };
      if (name === "layers:upsert") {
        const r = req as { layer: unknown };
        return { ok: true, value: r.layer };
      }
      if (name === "bundle:updateCanvasDimensions") {
        return {
          ok: true,
          value: { previousWidthPx: 2221, previousHeightPx: 1162 }
        };
      }
      return { ok: true, value: undefined };
    });

    await render(createElement(Harness, { captureId }));

    // Reset is a 2-click sequence: arm + confirm. Find the button by
    // visible label (component is named ResetButton; aria label is
    // localized as plain text).
    const resetBtn = host?.querySelector<HTMLButtonElement>(
      "button.psl__et-btn--reset"
    );
    expect(resetBtn, "Reset button must be present").not.toBeNull();
    if (resetBtn === null || resetBtn === undefined) throw new Error("unreachable");
    // Reset enables when overlayCount > 0 OR isV2Cropped is true.
    // The fixture has a raster + a crop-layer-equivalent state, so
    // isV2Cropped should be true via the dim-comparison fallback
    // (width_px=2221 < natural_width_px=2880).
    expect(resetBtn.disabled, "Reset must be enabled on cropped capture").toBe(false);

    // First click arms.
    await fireClick(resetBtn);
    // Second click confirms.
    await fireClick(resetBtn);
    // Drain microtasks for the async onConfirm chain (library:byId,
    // layers:list, layers:delete, layers:upsert, bundle:updateCanvasDimensions).
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    const allCalls = dispatchMock.mock.calls;

    // Raster must be deleted-and-reinserted with identity transform.
    // Pre-fix this call was MISSING — Reset only deleted user
    // annotations + restored canvas dims; the translated raster
    // stayed translated.
    const rasterUpsert = allCalls.find((c) => {
      if (c[0] !== "layers:upsert") return false;
      const layer = (c[1] as { layer: { kind?: string } }).layer;
      return layer.kind === "raster";
    });
    expect(
      rasterUpsert,
      "Reset must reinsert the raster with identity transform when a prior off-origin crop translated it — otherwise the full-dim canvas shows the raster offset (user-reported bug)"
    ).toBeDefined();
    if (rasterUpsert !== undefined) {
      const layer = (rasterUpsert[1] as {
        layer: { kind: string; transform: readonly number[] };
      }).layer;
      expect(layer.kind).toBe("raster");
      expect(layer.transform[4]).toBe(0);
      expect(layer.transform[5]).toBe(0);
      // Scale + rotation untouched.
      expect(layer.transform[0]).toBe(1);
      expect(layer.transform[3]).toBe(1);
    }

    // Canvas dim restore still happens (independent of raster reset).
    const dimRestore = allCalls.find(
      (c) => c[0] === "bundle:updateCanvasDimensions"
    );
    expect(dimRestore?.[1]).toEqual({
      captureId,
      widthPx: 2880,
      heightPx: 1920
    });
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
