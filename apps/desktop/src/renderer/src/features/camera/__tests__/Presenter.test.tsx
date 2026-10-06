import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  defaultPresenterStyle,
  presenterHeight,
  presenterLook,
  type AvatarStyle,
  type CameraTrackMetadata,
  type CaptureRecord
} from "@pwrsnap/shared";
import { CameraLane, type CameraLaneModel } from "../CameraLane";
import { PresenterLayer, type PresenterEditing } from "../PresenterLayer";
import { applyPresenterAction, presenterKeyAction } from "../usePresenter";
import { ScenePresenterField } from "../ScenePresenterField";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const camera: CameraTrackMetadata = {
  version: 1,
  durationSec: 10,
  width: 1280,
  height: 720,
  offsetSec: 1,
  sha256: "a".repeat(64),
  mimeType: "video/mp4"
};
const geometry = { cameraAspect: 16 / 9, canvasAspect: 16 / 10 };
const capture = {
  id: "presenter000001",
  kind: "video",
  width_px: 1600,
  height_px: 1000,
  video: { camera, avatar: null }
} as unknown as CaptureRecord;

// The stage frame is exactly the recording's 16:10, so the picture fills it.
const FRAME = { width: 800, height: 500 };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(FRAME.width);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(FRAME.height);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ x: 0, y: 0, left: 0, top: 0, right: FRAME.width, bottom: FRAME.height, width: FRAME.width, height: FRAME.height, toJSON: () => ({}) }) as DOMRect
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    }
  );
  Element.prototype.setPointerCapture = () => undefined;
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(node: ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function pointer(el: Element, type: string, clientX: number, clientY: number): void {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 }));
  });
}

function editing(overrides: Partial<PresenterEditing> = {}): PresenterEditing {
  return {
    selected: false,
    onSelect: vi.fn(),
    onChange: vi.fn(),
    onAction: vi.fn(),
    ...overrides
  };
}

describe("PresenterLayer", () => {
  const style = defaultPresenterStyle(geometry);

  test("places the presenter where the export will, in the picture's coordinates", () => {
    const el = mount(createElement(PresenterLayer, { capture, style }));
    const obj = el.querySelector<HTMLElement>("[data-testid=presenter-object]")!;
    expect(parseFloat(obj.style.left)).toBeCloseTo(style.x * FRAME.width, 1);
    expect(parseFloat(obj.style.width)).toBeCloseTo(style.width * FRAME.width, 1);
    expect(parseFloat(obj.style.height)).toBeCloseTo(presenterHeight(style, geometry) * FRAME.height, 1);
    // Flush on the bottom edge, as a cut-out should be.
    expect(parseFloat(obj.style.top) + parseFloat(obj.style.height)).toBeCloseTo(FRAME.height, 1);
    // Read-only: nothing to grab.
    expect(obj.classList.contains("is-editable")).toBe(false);
  });

  test("a hidden presenter draws nothing", () => {
    const el = mount(createElement(PresenterLayer, { capture, style: { ...style, visible: false } }));
    expect(el.querySelector("[data-testid=presenter-object]")).toBeNull();
  });

  test("pressing it selects it; a toolbar appears only while selected", () => {
    const onSelect = vi.fn();
    const el = mount(createElement(PresenterLayer, { capture, style, editing: editing({ onSelect }) }));
    expect(el.querySelector("[data-testid=presenter-toolbar]")).toBeNull();
    const obj = el.querySelector("[data-testid=presenter-object]")!;
    pointer(obj, "pointerdown", 700, 450);
    pointer(obj, "pointerup", 700, 450);
    expect(onSelect).toHaveBeenCalledWith(true);
    act(() => root!.render(createElement(PresenterLayer, { capture, style, editing: editing({ selected: true }) })));
    expect(el.querySelector("[data-testid=presenter-toolbar]")).not.toBeNull();
    expect(el.querySelector(".pres-sel__tag")?.textContent).toBe("Presenter");
  });

  test("a click that does not move does not save", () => {
    const onChange = vi.fn();
    const el = mount(createElement(PresenterLayer, { capture, style, editing: editing({ onChange }) }));
    const obj = el.querySelector("[data-testid=presenter-object]")!;
    pointer(obj, "pointerdown", 700, 450);
    pointer(obj, "pointermove", 701, 450);
    pointer(obj, "pointerup", 701, 450);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("a drag snaps to the left margin and saves once, on release", () => {
    const onChange = vi.fn();
    const el = mount(createElement(PresenterLayer, { capture, style, editing: editing({ onChange, selected: true }) }));
    const obj = el.querySelector("[data-testid=presenter-object]")!;
    const startX = style.x * FRAME.width + 10;
    pointer(obj, "pointerdown", startX, 450);
    // Within the snap threshold of the left margin (0.025 of the width).
    pointer(obj, "pointermove", startX - (style.x - 0.03) * FRAME.width, 450);
    expect(onChange).not.toHaveBeenCalled();
    expect(el.querySelector(".pres-guide--v")).not.toBeNull();
    expect(el.querySelector("[data-testid=presenter-toolbar]")).toBeNull();
    pointer(obj, "pointerup", 0, 450);
    expect(onChange).toHaveBeenCalledTimes(1);
    const saved = onChange.mock.calls[0]![0] as AvatarStyle;
    expect(saved.x).toBeCloseTo(0.025, 3);
    expect(saved.y + presenterHeight(saved, geometry)).toBeCloseTo(1, 3);
  });

  test("a corner drag resizes about the opposite corner", () => {
    const onChange = vi.fn();
    const el = mount(createElement(PresenterLayer, { capture, style, editing: editing({ onChange, selected: true }) }));
    const nw = el.querySelector(".pres-sel__h.is-nw")!;
    const obj = el.querySelector("[data-testid=presenter-object]")!;
    pointer(nw, "pointerdown", style.x * FRAME.width, style.y * FRAME.height);
    pointer(obj, "pointermove", (style.x - 0.1) * FRAME.width, style.y * FRAME.height);
    pointer(obj, "pointerup", (style.x - 0.1) * FRAME.width, style.y * FRAME.height);
    const saved = onChange.mock.calls[0]![0] as AvatarStyle;
    expect(saved.width).toBeCloseTo(style.width + 0.1, 2);
    expect(saved.x + saved.width).toBeCloseTo(style.x + style.width, 3);
    expect(saved.y + presenterHeight(saved, geometry)).toBeCloseTo(1, 3);
  });

  test("toolbar buttons report actions", () => {
    const onAction = vi.fn();
    const el = mount(createElement(PresenterLayer, { capture, style, editing: editing({ onAction, selected: true }) }));
    act(() => el.querySelector<HTMLButtonElement>("[data-testid=presenter-look-circle]")!.click());
    act(() => el.querySelector<HTMLButtonElement>("[data-testid=presenter-sync-later]")!.click());
    act(() => el.querySelector<HTMLButtonElement>("[data-testid=presenter-mirror]")!.click());
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([
      { type: "look", look: "circle" },
      { type: "sync", frames: 1 },
      { type: "mirror" }
    ]);
    expect(el.querySelector("[data-testid=presenter-look-cut]")?.getAttribute("aria-checked")).toBe("true");
    expect(el.querySelector("[data-testid=presenter-sync-value]")?.textContent).toBe("±0.00 s");
  });
});

describe("presenter actions and keys", () => {
  const style = defaultPresenterStyle(geometry);

  test("H toggles visibility whether or not the presenter is selected", () => {
    const key = (k: string, extra: Partial<{ altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({
      key: k,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      ...extra
    });
    expect(presenterKeyAction(key("h"), false)).toEqual({ type: "toggleVisible" });
    expect(presenterKeyAction(key("h", { metaKey: true }), false)).toBeNull();
    // Sync and Escape belong to the selection; unselected they fall through
    // to the transport (⌥ arrows) and the Library (Escape).
    expect(presenterKeyAction(key("ArrowRight", { altKey: true }), false)).toBeNull();
    expect(presenterKeyAction(key("ArrowRight", { altKey: true }), true)).toEqual({ type: "sync", frames: 1 });
    expect(presenterKeyAction(key("ArrowLeft", { altKey: true, shiftKey: true }), true)).toEqual({ type: "sync", frames: -10 });
    expect(presenterKeyAction(key("Escape"), true)).toBe("deselect");
    expect(presenterKeyAction(key("ArrowRight"), true)).toBeNull();
  });

  test("reset keeps visibility; inherit is not a style change", () => {
    const moved = { ...style, x: 0.1, mirror: true, visible: false };
    const reset = applyPresenterAction(moved, { type: "reset" }, geometry)!;
    expect(reset.x).toBeCloseTo(style.x, 3);
    expect(reset.mirror).toBe(false);
    expect(reset.visible).toBe(false);
    expect(applyPresenterAction(style, { type: "inherit" }, geometry)).toBeNull();
  });
});

describe("CameraLane", () => {
  const style = defaultPresenterStyle(geometry);
  const lane = (overrides: Partial<CameraLaneModel> = {}): CameraLaneModel => ({
    track: camera,
    style,
    selected: false,
    stripUrl: null,
    missing: false,
    onSelect: vi.fn(),
    onSyncChange: vi.fn(),
    ...overrides
  });

  test("the span sits where the camera ran", () => {
    const el = mount(createElement(CameraLane, { lane: lane(), durationSec: 20, width: 800 }));
    const span = el.querySelector<HTMLElement>("[data-testid=video-timeline-camera-span]")!;
    expect(span.style.left).toBe("5%");
    expect(span.style.right).toBe("45%");
    expect(el.textContent).toContain("Camera");
  });

  test("dragging it selects the presenter and saves a whole-frame sync offset on release", () => {
    const model = lane();
    const el = mount(createElement(CameraLane, { lane: model, durationSec: 20, width: 800 }));
    const span = el.querySelector("[data-testid=video-timeline-camera-span]")!;
    pointer(span, "pointerdown", 300, 10);
    expect(model.onSelect).toHaveBeenCalled();
    pointer(span, "pointermove", 320, 10);
    expect(el.querySelector(".vtl__camera-ghost")).not.toBeNull();
    expect(el.querySelector(".vtl__camera-tip")?.textContent).toBe("+0.50 s");
    pointer(span, "pointerup", 320, 10);
    expect(model.onSyncChange).toHaveBeenCalledWith(0.5);
  });

  test("says when the file is missing, timing is estimated, or the presenter is hidden", () => {
    const el = mount(createElement(CameraLane, { lane: lane({ missing: true }), durationSec: 20, width: 800 }));
    expect(el.querySelector("[data-testid=video-timeline-camera-span]")).toBeNull();
    expect(el.textContent).toContain("Camera file missing");
    act(() => root!.render(createElement(CameraLane, { lane: lane({ track: { ...camera, timing: "estimated" } }), durationSec: 20, width: 800 })));
    expect(el.textContent).toContain("timing estimated");
    act(() => root!.render(createElement(CameraLane, { lane: lane({ style: { ...style, visible: false } }), durationSec: 20, width: 800 })));
    expect(el.textContent).toContain("Camera · hidden");
  });
});

describe("ScenePresenterField", () => {
  test("inherits the recording's presenter until edited, then can go back", () => {
    const onChange = vi.fn();
    const el = mount(
      createElement(ScenePresenterField, { capture, sceneAvatar: undefined, canvas: { width: 1920, height: 1080 }, onChange })
    );
    expect(el.querySelector(".pres-badge")?.textContent).toBe("Recording’s");
    expect(el.querySelector("[data-testid=scene-presenter-inherit]")).toBeNull();
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Circle"]')!.click());
    const own = onChange.mock.calls[0]![0] as AvatarStyle;
    expect(presenterLook(own)).toBe("circle");
    act(() =>
      root!.render(
        createElement(ScenePresenterField, { capture, sceneAvatar: own, canvas: { width: 1920, height: 1080 }, onChange })
      )
    );
    expect(el.querySelector(".pres-badge")?.textContent).toBe("This scene");
    act(() => el.querySelector<HTMLButtonElement>("[data-testid=scene-presenter-inherit]")!.click());
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
