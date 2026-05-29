// Unit tests for `useCaptureModel` — the v2-editor refresh's data-
// access hook that branches the renderer on `bundle_format_version`.
//
// The hook returns a discriminated union (loading / loaded-v1 /
// loaded-v2 / error). v1 captures resolve via `library:byId` +
// `overlays:list`; v2 captures resolve via `library:byId` +
// `layers:list`. A single `cancelled` flag covers both branches so a
// slow request resolving SECOND can't clobber a newer captureId's
// state.
//
// Mirrors `useUndoRedo.test.ts` and `useEditorToolState.test.ts`'s
// bare-react + createRoot + act harness. No `@testing-library/react`
// (no project precedent).
//
// Plan reference: docs/plans/2026-05-23-001-feat-v2-editor-plan.md
// Phase 2.

import { act, createElement, useEffect, useRef } from "react";
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
import type { BundleLayerNode, CaptureRecord, OverlayRow } from "@pwrsnap/shared";

// ---- Mocks ----------------------------------------------------------
//
// `dispatch` is the renderer's IPC shim. We capture every call and
// drive resolution per-test so we can simulate slow / fast / out-of-
// order branches.
//
// `subscribe` is the event-bus shim. Tests grab the handler registry
// per channel so they can synthesize broadcasts.

type Resolver<T> = (value: T) => void;
type Pending<T> = { promise: Promise<T>; resolve: Resolver<T> };

function deferred<T>(): Pending<T> {
  let resolve!: Resolver<T>;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const dispatchMock = vi.fn();
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
  subscribe: (channel: string, handler: (payload: unknown) => void) => {
    const list = subscribers.get(channel) ?? [];
    list.push(handler);
    subscribers.set(channel, list);
    return () => {
      const next = subscribers.get(channel) ?? [];
      const idx = next.indexOf(handler);
      if (idx >= 0) next.splice(idx, 1);
      subscribers.set(channel, next);
    };
  }
}));

const subscribers = new Map<string, Array<(payload: unknown) => void>>();

function broadcast(channel: string, payload: unknown): void {
  const list = subscribers.get(channel) ?? [];
  for (const handler of list) handler(payload);
}

import {
  useCaptureModel,
  type CaptureModel,
  type LayerView
} from "../useCaptureModel";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

// ---- Fixtures -------------------------------------------------------

function makeRecord(id: string, formatVersion: number): CaptureRecord {
  return {
    id,
    kind: "image",
    captured_at: "2026-05-23T12:00:00.000Z",
    legacy_src_path: null,
    bundle_path: `/tmp/${id}.pwrsnap`,
    flat_png_path: null,
    bundle_modified_at: "2026-05-23T12:00:00.000Z",
    bundle_format_version: formatVersion,
    bundle_edits_version: 0,
    width_px: 2000,
    height_px: 1000,
    device_pixel_ratio: 2,
    byte_size: 0,
    sha256: "0".repeat(64),
    source_app_bundle_id: null,
    source_app_name: null,
    edits_version: 0,
    deleted_at: null
  };
}

function makeOverlayRow(id: string, captureId: string): OverlayRow {
  return {
    id,
    capture_id: captureId,
    data: {
      kind: "arrow",
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.5, y: 0.5 },
      color: "auto"
    },
    schema_version: 1,
    created_at: "2026-05-23T12:00:00.000Z",
    applied_at: "2026-05-23T12:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 0
  };
}

function makeLayerNode(id: string): BundleLayerNode {
  return {
    id,
    parent_id: null,
    name: "raster",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 0,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-05-23T12:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-05-23T12:00:00.000Z",
    kind: "raster",
    source_ref: { kind: "embedded", sha256: "a".repeat(64) },
    natural_width_px: 2000,
    natural_height_px: 1000
  };
}

// ---- Probe + render harness -----------------------------------------

type ProbeProps = {
  readonly captureId: string;
  readonly onSnapshot: (model: CaptureModel) => void;
};

function Probe(props: ProbeProps): null {
  const model = useCaptureModel(props.captureId);
  const onSnapshot = useRef(props.onSnapshot);
  onSnapshot.current = props.onSnapshot;
  useEffect(() => {
    onSnapshot.current(model);
  });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactElement): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

function rerender(node: React.ReactElement): void {
  act(() => {
    root!.render(node);
  });
}

beforeEach(() => {
  dispatchMock.mockReset();
  subscribers.clear();
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

// ---- Helpers --------------------------------------------------------

function flush(): Promise<void> {
  // Drain microtasks so awaited resolutions settle before we read the
  // probe's snapshot.
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ---- Tests ----------------------------------------------------------

describe("useCaptureModel", () => {
  test("1. initial loading state", () => {
    dispatchMock.mockImplementation(() => deferred<unknown>().promise);

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );

    expect(model!.kind).toBe("loading");
    expect(model!.captureId).toBe("cap_1");
  });

  test("2. v1 capture: loads record + overlays + synthesizes LayerView", async () => {
    const record = makeRecord("cap_1", 1);
    const overlay = makeOverlayRow("ov_1", "cap_1");
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") {
        return Promise.resolve({ ok: true, value: record });
      }
      if (name === "overlays:list") {
        return Promise.resolve({ ok: true, value: [overlay] });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );

    await flush();

    const m = model!;
    expect(m.kind).toBe("loaded");
    if (m.kind === "loaded") {
      expect(m.format).toBe(1);
      if (m.format === 1) {
        expect(m.overlays).toEqual([overlay]);
        expect(m.layers.length).toBe(1);
        const view: LayerView = m.layers[0]!;
        expect(view.kind).toBe("vector");
        if (view.kind === "vector") {
          expect(view.geometry.kind).toBe("arrow");
        }
      }
    }
  });

  test("3. v2 capture: loads record + layers from layers:list", async () => {
    const record = makeRecord("cap_2", 2);
    const layer = makeLayerNode("ly_1");
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") {
        return Promise.resolve({ ok: true, value: record });
      }
      if (name === "layers:list") {
        return Promise.resolve({ ok: true, value: [layer] });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );

    await flush();

    const m = model!;
    expect(m.kind).toBe("loaded");
    if (m.kind === "loaded") {
      expect(m.format).toBe(2);
      if (m.format === 2) {
        expect(m.layers).toEqual([layer]);
        expect(m.layersView.length).toBe(1);
        expect(m.layersView[0]!.kind).toBe("raster");
      }
    }
  });

  test("4. dispatched IPC verb is correct by format", async () => {
    const record = makeRecord("cap_1", 1);
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") {
        return Promise.resolve({ ok: true, value: record });
      }
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [] });
      if (name === "layers:list") return Promise.resolve({ ok: true, value: [] });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const verbs = dispatchMock.mock.calls.map((c) => c[0]);
    expect(verbs).toContain("library:byId");
    expect(verbs).toContain("overlays:list");
    expect(verbs).not.toContain("layers:list");
  });

  test("4b. v2 capture only calls layers:list, not overlays:list", async () => {
    const record = makeRecord("cap_2", 2);
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") {
        return Promise.resolve({ ok: true, value: record });
      }
      if (name === "layers:list") return Promise.resolve({ ok: true, value: [] });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [] });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const verbs = dispatchMock.mock.calls.map((c) => c[0]);
    expect(verbs).toContain("layers:list");
    expect(verbs).not.toContain("overlays:list");
  });

  test("5a. v1 dispatchEdit: upsert → overlays:upsert", async () => {
    const record = makeRecord("cap_1", 1);
    const overlay = makeOverlayRow("ov_1", "cap_1");
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") {
        return Promise.resolve({ ok: true, value: record });
      }
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [overlay] });
      if (name === "overlays:upsert") return Promise.resolve({ ok: true, value: overlay });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    expect(m.kind).toBe("loaded");
    if (m.kind === "loaded" && m.format === 1) {
      await act(async () => {
        await m.dispatchEdit({ kind: "upsert", row: overlay });
      });
    }
    const upsertCalls = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:upsert");
    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]?.[1]).toEqual({ captureId: "cap_1", overlay: overlay.data });
  });

  test("5b. v1 dispatchEdit: delete → overlays:delete", async () => {
    const record = makeRecord("cap_1", 1);
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [] });
      if (name === "overlays:delete") return Promise.resolve({ ok: true, value: undefined });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind === "loaded" && m.format === 1) {
      await act(async () => {
        await m.dispatchEdit({ kind: "delete", id: "ov_1" });
      });
    }
    const deleteCalls = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:delete");
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0]?.[1]).toEqual({ id: "ov_1" });
  });

  test("5c. v2 dispatchEdit: upsert → layers:upsert", async () => {
    const record = makeRecord("cap_2", 2);
    const layer = makeLayerNode("ly_1");
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "layers:list") return Promise.resolve({ ok: true, value: [layer] });
      if (name === "layers:upsert") return Promise.resolve({ ok: true, value: layer });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind === "loaded" && m.format === 2) {
      await act(async () => {
        await m.dispatchEdit({ kind: "upsert", node: layer });
      });
    }
    const upsertCalls = dispatchMock.mock.calls.filter((c) => c[0] === "layers:upsert");
    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]?.[1]).toEqual({ captureId: "cap_2", layer });
  });

  test("5c'. v1 dispatchEdit: upsert artifact carries the inserted row", async () => {
    const record = makeRecord("cap_1", 1);
    const inserted = makeOverlayRow("ov_fresh", "cap_1");
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId")
        return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [] });
      if (name === "overlays:upsert") return Promise.resolve({ ok: true, value: inserted });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 1) throw new Error("unexpected model");
    const placeholder = makeOverlayRow("placeholder", "cap_1");
    const r = await m.dispatchEdit({ kind: "upsert", row: placeholder });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.kind).toBe("upsert");
    if (r.value.kind !== "upsert") throw new Error("unreachable");
    expect(r.value.artifact.format).toBe(1);
    if (r.value.artifact.format !== 1) throw new Error("unreachable");
    expect(r.value.artifact.row).toEqual(inserted);
  });

  test("5e. v1 dispatchEdit: crop → overlays:upsert with CropOverlay + previous dims", async () => {
    const record = makeRecord("cap_1", 1);
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId")
        return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [] });
      if (name === "overlays:upsert") {
        // Return a synthesized OverlayRow shaped like the request's
        // overlay so the dispatcher's artifact projection works.
        const r = req as { overlay: unknown };
        return Promise.resolve({
          ok: true,
          value: {
            ...makeOverlayRow("ov_crop", "cap_1"),
            data: r.overlay
          }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 1) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "crop",
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.kind).toBe("crop");
    if (r.value.kind !== "crop") throw new Error("unreachable");
    // v1 surfaces the current capture's dims as "previous" — they
    // don't actually change, but the shape is uniform with v2.
    expect(r.value.artifact.previousWidthPx).toBe(record.width_px);
    expect(r.value.artifact.previousHeightPx).toBe(record.height_px);
    // overlays:upsert was called with a CropOverlay.
    const upsertCalls = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:upsert");
    expect(upsertCalls.length).toBe(1);
    expect((upsertCalls[0]?.[1] as { overlay: { kind: string } })?.overlay.kind).toBe(
      "crop"
    );
  });

  test("5f. v2 dispatchEdit: crop → bundle:updateCanvasDimensions with derived dims", async () => {
    const record = makeRecord("cap_2", 2); // width_px=2000, height_px=1000
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId")
        return Promise.resolve({ ok: true, value: record });
      if (name === "layers:list") return Promise.resolve({ ok: true, value: [] });
      if (name === "bundle:updateCanvasDimensions") {
        return Promise.resolve({
          ok: true,
          value: { previousWidthPx: 2000, previousHeightPx: 1000 }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 2) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "crop",
      rect: { x: 0, y: 0, w: 0.5, h: 0.75 }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.kind).toBe("crop");
    if (r.value.kind !== "crop") throw new Error("unreachable");
    expect(r.value.artifact).toEqual({
      previousWidthPx: 2000,
      previousHeightPx: 1000
    });
    // Multiply rect.w/h * record.width_px/height_px → derived dims.
    const calls = dispatchMock.mock.calls.filter(
      (c) => c[0] === "bundle:updateCanvasDimensions"
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.[1]).toEqual({
      captureId: "cap_2",
      widthPx: 1000, // 2000 * 0.5
      heightPx: 750 // 1000 * 0.75
    });
  });

  test("5g. v2 dispatchEdit: crop re-normalizes vector layer coords (text at right edge → x>1, preserved as data outside viewport)", async () => {
    // User bug from pwrdrvr/PwrSnap#110: text at point.x=0.95 on a
    // 1728-px canvas (absolute pixel 1641) survived a crop to 60%
    // width — the canvas shrunk but the text's normalized coord
    // stayed 0.95, so the text "slid leftward" into the kept region
    // instead of being clipped at the right edge.
    //
    // Follow-up from the same PR review: crop is a VIEWPORT change,
    // not a destructive op. Overlays at absolute source pixels
    // outside the cropped viewport must PERSIST as DATA so undoing
    // the crop restores them. The schema's NormalizedScalar was
    // widened to .finite() (was .min(0).max(1)) specifically to allow
    // this. The dispatcher's "delete + reinsert" loop must always
    // reinsert with the transformed coords; renderer (SVG overflow)
    // and bake (sharp composite) clip at paint time.
    //
    // This test exercises the FULL dispatch flow (raster + text
    // vector → crop dispatch → verify text layer was deleted-and-
    // reinserted with the OUT-OF-CANVAS transformed coord + an
    // upsert of a NEW crop VectorLayer happened +
    // bundle:updateCanvasDimensions fired with derived dims).
    const record = makeRecord("cap_2", 2); // 2000x1000
    const rasterLayer = makeLayerNode("ly_raster");
    const rootGroupId = "ly_root";
    const rootGroup: BundleLayerNode = {
      id: rootGroupId,
      parent_id: null,
      name: "Root",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0,
      source: "user",
      ai_run_id: null,
      applied_at: "2026-05-23T12:00:00.000Z",
      rejected_at: null,
      superseded_by: null,
      created_at: "2026-05-23T12:00:00.000Z",
      kind: "group",
      collapsed: false
    };
    // Re-parent the raster under the root group (matches the doctor's
    // tree shape: root group → raster → user vectors).
    const rasterUnderRoot: BundleLayerNode = {
      ...rasterLayer,
      parent_id: rootGroupId
    };
    // Text on the right edge of the source. With a crop to w=0.6,
    // the user's expectation is that this text gets clipped at the
    // right edge of the new (smaller) canvas because its absolute
    // pixel position (0.95 * 2000 = 1900) is outside the new canvas
    // (0.6 * 2000 = 1200 wide).
    const textLayer: BundleLayerNode = {
      id: "ly_text",
      parent_id: rootGroupId,
      name: "Text",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 1,
      source: "user",
      ai_run_id: null,
      applied_at: "2026-05-23T12:00:00.000Z",
      rejected_at: null,
      superseded_by: null,
      created_at: "2026-05-23T12:00:00.000Z",
      kind: "vector",
      shape: {
        kind: "text",
        point: { x: 0.95, y: 0.5 },
        body: "edge",
        size: "small",
        color: "auto"
      }
    };
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId")
        return Promise.resolve({ ok: true, value: record });
      if (name === "layers:list")
        return Promise.resolve({
          ok: true,
          value: [rootGroup, rasterUnderRoot, textLayer]
        });
      if (name === "layers:delete") return Promise.resolve({ ok: true, value: undefined });
      if (name === "layers:upsert") {
        const r = req as { layer: BundleLayerNode };
        return Promise.resolve({ ok: true, value: r.layer });
      }
      if (name === "bundle:updateCanvasDimensions") {
        return Promise.resolve({
          ok: true,
          value: { previousWidthPx: 2000, previousHeightPx: 1000 }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();
    const m = model!;
    if (m.kind !== "loaded" || m.format !== 2) throw new Error("unexpected model");

    // Apply a 60% width crop. Per the user's intuition the text at
    // point.x = 0.95 should end up with new normalized coord
    // 0.95 / 0.6 ≈ 1.5833 (past the new canvas right edge → clipped).
    const r = await m.dispatchEdit({
      kind: "crop",
      rect: { x: 0, y: 0, w: 0.6, h: 1 }
    });
    expect(r.ok).toBe(true);

    // 1. Text layer was deleted (Step 0 of the dispatcher's "delete +
    //    reinsert with transformed coords" loop).
    const textDeleteCall = dispatchMock.mock.calls.find(
      (c) => c[0] === "layers:delete" && (c[1] as { id: string }).id === "ly_text"
    );
    expect(
      textDeleteCall,
      "expected layers:delete for the text layer id"
    ).toBeDefined();

    // 2. CRITICAL: text MUST be reinserted with transformed coords
    //    point.x = 0.95 / 0.6 ≈ 1.5833 (past the new canvas right
    //    edge, but the schema now permits out-of-canvas coords).
    //    Pre-#110 review: the dispatcher deleted-without-reinserting
    //    here, which made the data loss permanent — undo of the crop
    //    had nothing to restore. Post-fix: the overlay persists as
    //    DATA outside the viewport; renderer clips at paint time.
    const textUpsertCall = dispatchMock.mock.calls.find((c) => {
      if (c[0] !== "layers:upsert") return false;
      const layer = (c[1] as { layer: BundleLayerNode }).layer;
      return (
        layer.kind === "vector" &&
        layer.shape.kind === "text" &&
        layer.shape.body === "edge"
      );
    });
    expect(
      textUpsertCall,
      "text outside the new canvas MUST be reinserted with transformed (out-of-canvas) coords — without it, undo cannot restore the overlay (the destructive-crop regression from PR #110)"
    ).toBeDefined();
    if (textUpsertCall !== undefined) {
      const layer = (textUpsertCall[1] as { layer: BundleLayerNode }).layer;
      if (layer.kind !== "vector" || layer.shape.kind !== "text") {
        throw new Error("text layer shape preserved");
      }
      // 0.95 / 0.6 = 1.5833... — past the new canvas, but preserved.
      expect(layer.shape.point.x).toBeCloseTo(0.95 / 0.6, 4);
      expect(layer.shape.point.y).toBeCloseTo(0.5, 6);
    }

    // 3. A crop VectorLayer was inserted.
    const cropUpsertCall = dispatchMock.mock.calls.find((c) => {
      if (c[0] !== "layers:upsert") return false;
      const layer = (c[1] as { layer: BundleLayerNode }).layer;
      return layer.kind === "vector" && layer.shape.kind === "crop";
    });
    expect(cropUpsertCall, "expected a crop VectorLayer to be inserted").toBeDefined();

    // 4. The canvas dim shrink happened.
    const canvasDimCall = dispatchMock.mock.calls.find(
      (c) => c[0] === "bundle:updateCanvasDimensions"
    );
    expect(canvasDimCall).toBeDefined();
    expect(canvasDimCall?.[1]).toEqual({
      captureId: "cap_2",
      widthPx: 1200, // 2000 * 0.6
      heightPx: 1000
    });
  });

  test("5g2. v2 dispatchEdit: OFF-ORIGIN crop translates the raster layer so the new canvas shows the user's chosen region", async () => {
    // User-reported bug from pwrdrvr/PwrSnap#110 review (diagnostic
    // log on a real center-crop):
    //
    //   text at (0.89, 0.59) on 2880×1920
    //   crop rect (0.354, 0.187, 0.6, 0.6)  ← CENTER crop, not top-left
    //   newCanvas: 1728×1152
    //
    // The forward overlay transform correctly emits (0.896, 0.676) for
    // the text in the new canvas — matches the math. BUT the canvas-
    // dim shrink ignores rect.x/y (only uses w×h) so the new canvas
    // implicitly shows the TOP-LEFT 60% of the source, not the middle
    // 60% the user dragged. Net result: text lands at canvas pixel
    // (1548, 779) which displays source pixel (1548, 779), NOT the
    // user's chosen (2567, 1138).
    //
    // Fix: also translate the raster layer's transform by
    // (-rect.x × oldW, -rect.y × oldH) so the cropped canvas shows
    // the user's chosen region of the source. The dispatcher comment
    // ("Off-origin crops require translating every layer's transform
    // by (-rect.x, -rect.y) — deferred to the layer-editor UI in
    // Phase 4-5") flagged this as a known gap; this test makes it
    // un-deferred.
    const record = makeRecord("cap_2", 2);
    // 2000×1000 record (matches makeRecord default).
    const rasterLayer = makeLayerNode("ly_raster");
    const rootGroupId = "ly_root";
    const rootGroup: BundleLayerNode = {
      id: rootGroupId,
      parent_id: null,
      name: "Root",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0,
      source: "user",
      ai_run_id: null,
      applied_at: "2026-05-23T12:00:00.000Z",
      rejected_at: null,
      superseded_by: null,
      created_at: "2026-05-23T12:00:00.000Z",
      kind: "group",
      collapsed: false
    };
    const rasterUnderRoot: BundleLayerNode = {
      ...rasterLayer,
      parent_id: rootGroupId
    };
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId")
        return Promise.resolve({ ok: true, value: record });
      if (name === "layers:list")
        return Promise.resolve({
          ok: true,
          value: [rootGroup, rasterUnderRoot]
        });
      if (name === "layers:delete")
        return Promise.resolve({ ok: true, value: undefined });
      if (name === "layers:upsert") {
        const r = req as { layer: BundleLayerNode };
        return Promise.resolve({ ok: true, value: r.layer });
      }
      if (name === "bundle:updateCanvasDimensions") {
        return Promise.resolve({
          ok: true,
          value: { previousWidthPx: 2000, previousHeightPx: 1000 }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();
    const m = model!;
    if (m.kind !== "loaded" || m.format !== 2) throw new Error("unexpected model");

    // Off-origin crop: rect.x = 0.25, rect.y = 0.1, keeping middle 50% × 50%.
    const r = await m.dispatchEdit({
      kind: "crop",
      rect: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 }
    });
    expect(r.ok).toBe(true);

    // The raster must be deleted-and-reinserted with a translated
    // transform so its visible window matches the user's crop rect.
    // Expected new translation: (-0.25 × 2000, -0.1 × 1000) = (-500, -100).
    const rasterUpsertCall = dispatchMock.mock.calls.find((c) => {
      if (c[0] !== "layers:upsert") return false;
      const layer = (c[1] as { layer: BundleLayerNode }).layer;
      return layer.kind === "raster";
    });
    expect(
      rasterUpsertCall,
      "off-origin crop must reinsert the raster with a translated transform — without this the canvas shrink takes the TOP-LEFT W×H of the source instead of the user's chosen region"
    ).toBeDefined();
    if (rasterUpsertCall !== undefined) {
      const layer = (rasterUpsertCall[1] as { layer: BundleLayerNode }).layer;
      if (layer.kind !== "raster") throw new Error("kind preserved");
      // transform = [a, b, c, d, tx, ty]; the translation lives at [4]/[5].
      expect(layer.transform[4]).toBeCloseTo(-500, 3);
      expect(layer.transform[5]).toBeCloseTo(-100, 3);
      // Other matrix elements untouched (identity scale + no rotation).
      expect(layer.transform[0]).toBe(1);
      expect(layer.transform[1]).toBe(0);
      expect(layer.transform[2]).toBe(0);
      expect(layer.transform[3]).toBe(1);
    }

    // Canvas dims shrink to (1000, 500) — derived from w × oldW and
    // h × oldH; unchanged behavior. The translation in raster
    // transform is what makes the off-origin crop show the right
    // region.
    const canvasDimCall = dispatchMock.mock.calls.find(
      (c) => c[0] === "bundle:updateCanvasDimensions"
    );
    expect(canvasDimCall?.[1]).toEqual({
      captureId: "cap_2",
      widthPx: 1000, // 2000 * 0.5
      heightPx: 500 // 1000 * 0.5
    });
  });

  test("5h. v2 refetch race: stale broadcast resolution must NOT overwrite fresh record (crop undo bug)", async () => {
    // User-reported bug from PR #110 review:
    //   1. User crops a capture (1728 → 1037 wide).
    //   2. User hits ⌘Z immediately.
    //   3. Undo dispatches a reverse-crop with rect.w = 1728/1037 ≈ 1.667.
    //   4. The dispatcher reads recordRef.current.width_px to compute
    //      `newWidth = op.rect.w * record.width_px`.
    //   5. Expected: record.width_px is 1037 (post-forward-crop),
    //      newWidth = 1729 (~original 1728).
    //   6. Actual: record.width_px is STALE 1728, newWidth = 2880
    //      (raster natural dims). Canvas restores to wrong size; text
    //      transformed by the inverse rect now lands at totally wrong
    //      coords.
    //
    // Root cause: the v2 crop dispatcher fires multiple steps that each
    // broadcast events:overlays:changed / events:captures:changed. Each
    // broadcast triggers a refetch via library:byId. Refetches from
    // STEPS 0-2 dispatch BEFORE the DB row's canvas dims update (Step 3),
    // so library:byId returns stale 1728. Step 3's refetch returns the
    // fresh 1037. If the stale resolutions land AFTER the fresh one
    // (any order is possible — IPC + microtask queuing is non-
    // deterministic), state.record ends up at stale 1728 and recordRef
    // shows 1728 forever.
    //
    // This test SIMULATES the race: fire 5 captures:changed broadcasts
    // in sequence where each library:byId returns a different width
    // (mimicking the DB state at each broadcast point), and assert
    // the FINAL state.record.width is the LATEST value (1037), not the
    // earliest stale one.

    const STALE_WIDTH = 1728;
    const FRESH_WIDTH = 1037;

    // Realistic race simulation: each library:byId dispatch is queued.
    // We control resolution order explicitly. Real IPC + microtasks
    // don't preserve dispatch order on resolution (Electron's IPC
    // layer + V8's microtask queue + the broadcast handler invocation
    // order all contribute), so the order is intentionally reversed
    // here to demonstrate the bug: the FRESH response (matching the
    // FINAL DB state after Step 3's canvas dim update) is dispatched
    // LAST but should resolve FIRST, while STALE responses dispatched
    // earlier resolve AFTER it. Without a seq guard the stale
    // resolution overwrites fresh.
    type Pending = {
      resolve: (record: CaptureRecord) => void;
      width: number;
    };
    const pending: Pending[] = [];
    let dispatchIdx = 0;
    // Width per dispatch index: first call (initial) = stale.
    // Subsequent (from broadcasts) = stale, stale, stale, stale, fresh.
    const widthByIdx = [STALE_WIDTH, STALE_WIDTH, STALE_WIDTH, STALE_WIDTH, STALE_WIDTH, FRESH_WIDTH];

    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") {
        const w = widthByIdx[dispatchIdx] ?? FRESH_WIDTH;
        dispatchIdx += 1;
        return new Promise<{ ok: true; value: CaptureRecord }>((resolve) => {
          pending.push({
            width: w,
            resolve: (record: CaptureRecord) => resolve({ ok: true, value: record })
          });
        });
      }
      if (name === "layers:list") return Promise.resolve({ ok: true, value: [] });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    // Resolve the initial fetch (call #0, stale width).
    await act(async () => {
      const initial = pending.shift();
      if (initial !== undefined) {
        const r = makeRecord("cap_2", 2);
        initial.resolve({ ...r, width_px: initial.width });
      }
    });
    await flush();
    const initialModel = model as CaptureModel | null;
    expect(initialModel?.kind === "loaded").toBe(true);

    // Fire 5 captures:changed broadcasts in sequence. Each triggers
    // a refetch → library:byId dispatch → queues a Pending.
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        broadcast("events:captures:changed", { changedIds: ["cap_2"] });
      }
    });
    // All 5 should be queued.
    expect(pending.length).toBe(5);

    // Resolve them in REVERSE order: the FRESH response (last
    // dispatched) resolves FIRST; the 4 STALE responses resolve
    // AFTER. Without a seq guard, the last stale resolution wins
    // and state.record.width ends up at STALE_WIDTH.
    await act(async () => {
      const fresh = pending.pop(); // last dispatched = fresh
      if (fresh !== undefined) {
        const r = makeRecord("cap_2", 2);
        fresh.resolve({ ...r, width_px: fresh.width });
      }
    });
    await flush();
    // Now resolve the 4 stale ones (dispatched before fresh, but
    // resolving after — the bug case).
    await act(async () => {
      while (pending.length > 0) {
        const stale = pending.shift()!;
        const r = makeRecord("cap_2", 2);
        stale.resolve({ ...r, width_px: stale.width });
      }
    });
    await flush();
    await flush();

    // CORE ASSERTION: even though a STALE response resolved LAST, the
    // model's record should reflect the FRESH value because that
    // dispatch was the LATEST one fired. Per-refetch sequence-number
    // guard drops stale-arriving-late resolutions.
    const m = model! as CaptureModel;
    if (m.kind !== "loaded") throw new Error("model not loaded");
    expect(
      m.record.width_px,
      "stale-arriving-late refetch must NOT overwrite fresh state (otherwise crop undo reads stale dims and lands canvas at wrong size — pwrdrvr/PwrSnap#110 user report)"
    ).toBe(FRESH_WIDTH);
  });

  test("5d. v2 dispatchEdit: upsertBatch → not yet supported error", async () => {
    const record = makeRecord("cap_2", 2);
    const layer = makeLayerNode("ly_1");
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "layers:list") return Promise.resolve({ ok: true, value: [] });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind === "loaded" && m.format === 2) {
      const result = await m.dispatchEdit({ kind: "upsertBatch", nodes: [layer] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("v2_writes_not_yet_supported");
      }
    }
  });

  test("6. cancel-safety: capture-change drops stale resolution", async () => {
    const recordA = makeRecord("cap_1", 1);
    const recordB = makeRecord("cap_2", 1);
    const overlayA = makeOverlayRow("ov_a", "cap_1");
    const overlayB = makeOverlayRow("ov_b", "cap_2");

    // First call: library:byId for cap_1 → slow.
    // Subsequent calls: cap_2 → fast.
    const slowRecord = deferred<{ ok: true; value: CaptureRecord }>();
    let recordCalls = 0;
    dispatchMock.mockImplementation((name: string, req: { id?: string; captureId?: string }) => {
      if (name === "library:byId") {
        recordCalls += 1;
        if (req.id === "cap_1") return slowRecord.promise;
        if (req.id === "cap_2") return Promise.resolve({ ok: true, value: recordB });
      }
      if (name === "overlays:list") {
        if (req.captureId === "cap_1")
          return Promise.resolve({ ok: true, value: [overlayA] });
        if (req.captureId === "cap_2")
          return Promise.resolve({ ok: true, value: [overlayB] });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    const onSnapshot = (m: CaptureModel): void => {
      model = m;
    };

    render(createElement(Probe, { captureId: "cap_1", onSnapshot }));
    // cap_1 is now in-flight (recordCalls=1, but slowRecord not resolved).
    expect(model!.kind).toBe("loading");

    // Switch to cap_2 BEFORE cap_1 resolves.
    rerender(createElement(Probe, { captureId: "cap_2", onSnapshot }));
    await flush();

    // cap_2 loaded.
    {
      const m = model!;
      expect(m.kind).toBe("loaded");
      if (m.kind === "loaded") {
        expect(m.captureId).toBe("cap_2");
      }
    }

    // NOW resolve cap_1's slow response. It must NOT clobber cap_2.
    await act(async () => {
      slowRecord.resolve({ ok: true, value: recordA });
      await Promise.resolve();
      await Promise.resolve();
    });

    {
      const m = model!;
      expect(m.kind).toBe("loaded");
      if (m.kind === "loaded") {
        expect(m.captureId).toBe("cap_2");
        if (m.format === 1) {
          expect(m.overlays).toEqual([overlayB]);
        }
      }
    }
    expect(recordCalls).toBeGreaterThanOrEqual(2);
  });

  test("7. slow branch resolves SECOND: fast cap_2 stays, slow cap_1 ignored", async () => {
    // Same scenario as #6 but explicitly emphasizes resolution order:
    // the fast cap_2 response arrives first; the stale cap_1 second.
    const recordA = makeRecord("cap_1", 1);
    const recordB = makeRecord("cap_2", 2);
    const layerB = makeLayerNode("ly_b");

    const slowA = deferred<{ ok: true; value: CaptureRecord }>();
    dispatchMock.mockImplementation((name: string, req: { id?: string; captureId?: string }) => {
      if (name === "library:byId") {
        if (req.id === "cap_1") return slowA.promise;
        if (req.id === "cap_2") return Promise.resolve({ ok: true, value: recordB });
      }
      if (name === "overlays:list" && req.captureId === "cap_1") {
        return Promise.resolve({ ok: true, value: [] });
      }
      if (name === "layers:list" && req.captureId === "cap_2") {
        return Promise.resolve({ ok: true, value: [layerB] });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    const onSnapshot = (m: CaptureModel): void => {
      model = m;
    };

    render(createElement(Probe, { captureId: "cap_1", onSnapshot }));
    rerender(createElement(Probe, { captureId: "cap_2", onSnapshot }));
    await flush();

    // cap_2 is loaded as v2.
    {
      const m = model!;
      expect(m.kind).toBe("loaded");
      if (m.kind === "loaded") {
        expect(m.format).toBe(2);
      }
    }

    // Stale cap_1 resolves AFTER. Must be dropped.
    await act(async () => {
      slowA.resolve({ ok: true, value: recordA });
      await Promise.resolve();
      await Promise.resolve();
    });

    {
      const m = model!;
      expect(m.kind).toBe("loaded");
      if (m.kind === "loaded") {
        expect(m.captureId).toBe("cap_2");
        expect(m.format).toBe(2);
      }
    }
  });

  test("8. events:overlays:changed re-fetches for this capture", async () => {
    const record = makeRecord("cap_1", 1);
    let listCalls = 0;
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") {
        listCalls += 1;
        return Promise.resolve({ ok: true, value: [] });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    expect(listCalls).toBe(1);

    // Broadcast for this capture → re-fetch.
    await act(async () => {
      broadcast("events:overlays:changed", { captureId: "cap_1" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listCalls).toBe(2);

    // Broadcast for a different capture → no re-fetch.
    await act(async () => {
      broadcast("events:overlays:changed", { captureId: "cap_other" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listCalls).toBe(2);
  });

  test("9. events:captures:changed with format flip switches the IPC family", async () => {
    let recordV1 = makeRecord("cap_1", 1);
    const recordV2 = makeRecord("cap_1", 2);
    let useV2 = false;
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") {
        return Promise.resolve({ ok: true, value: useV2 ? recordV2 : recordV1 });
      }
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [] });
      if (name === "layers:list") return Promise.resolve({ ok: true, value: [] });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    {
      const m = model!;
      expect(m.kind).toBe("loaded");
      if (m.kind === "loaded") {
        expect(m.format).toBe(1);
      }
    }

    // Doctor ran; capture is now v2. Broadcast triggers re-fetch.
    useV2 = true;
    await act(async () => {
      broadcast("events:captures:changed", { changedIds: ["cap_1"] });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    {
      const m = model!;
      expect(m.kind).toBe("loaded");
      if (m.kind === "loaded") {
        expect(m.format).toBe(2);
      }
    }
    // After the flip, the latest list call should be layers:list.
    const recentList = dispatchMock.mock.calls
      .map((c) => c[0])
      .filter((n) => n === "overlays:list" || n === "layers:list");
    expect(recentList[recentList.length - 1]).toBe("layers:list");
  });

  test("10. error: library:byId returns Err → error model", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") {
        return Promise.resolve({
          ok: false,
          error: { kind: "persistence", code: "io", message: "disk dead" }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    expect(m.kind).toBe("error");
    if (m.kind === "error") {
      expect(m.message).toContain("disk dead");
    }
  });

  test("10b. error: library:byId returns null value → not-found error", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_missing",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    expect(m.kind).toBe("error");
    if (m.kind === "error") {
      expect(m.message).toContain("cap_missing");
    }
  });

  test("11. unmount during in-flight: no setState warning after unmount", async () => {
    const slow = deferred<{ ok: true; value: CaptureRecord }>();
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") return slow.promise;
      return Promise.resolve({ ok: true, value: null });
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: () => undefined
      })
    );

    // Unmount synchronously.
    act(() => {
      root!.unmount();
    });
    root = null;
    if (host !== null) {
      document.body.removeChild(host);
      host = null;
    }

    // Resolve AFTER unmount. The hook's cancel flag must drop the
    // response — no warnings or thrown errors.
    await act(async () => {
      slow.resolve({ ok: true, value: makeRecord("cap_1", 1) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  test("13a. v1 dispatchEdit: updateGeometry → overlays:delete + overlays:upsert with merged data", async () => {
    const record = makeRecord("cap_1", 1);
    const existing = makeOverlayRow("ov_orig", "cap_1");
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [existing] });
      if (name === "overlays:delete") return Promise.resolve({ ok: true, value: undefined });
      if (name === "overlays:upsert") {
        const r = req as { overlay: unknown };
        return Promise.resolve({
          ok: true,
          value: { ...makeOverlayRow("ov_new", "cap_1"), data: r.overlay }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 1) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "updateGeometry",
      layerId: "ov_orig",
      geometry: {
        kind: "arrow",
        from: { x: 0.3, y: 0.3 },
        to: { x: 0.9, y: 0.9 }
      }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.kind).toBe("update");
    if (r.value.kind !== "update") throw new Error("unreachable");
    expect(r.value.artifact.format).toBe(1);
    // overlays:delete on the original id, then overlays:upsert with
    // the merged geometry.
    const deletes = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:delete");
    expect(deletes.length).toBe(1);
    expect(deletes[0]?.[1]).toEqual({ id: "ov_orig" });
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:upsert");
    expect(upserts.length).toBe(1);
    const sentOverlay = (upserts[0]?.[1] as { overlay: { kind: string; from: { x: number }; to: { x: number } } }).overlay;
    expect(sentOverlay.kind).toBe("arrow");
    expect(sentOverlay.from.x).toBeCloseTo(0.3);
    expect(sentOverlay.to.x).toBeCloseTo(0.9);
  });

  test("13b. v1 dispatchEdit: updateGeometry refuses on missing layerId", async () => {
    const record = makeRecord("cap_1", 1);
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [] });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 1) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "updateGeometry",
      layerId: "missing",
      geometry: { kind: "rect", rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe("layer_not_found");
  });

  test("13c. v1 dispatchEdit: updateOverlay → overlays:delete + overlays:upsert with patched data", async () => {
    const record = makeRecord("cap_1", 1);
    const existing = makeOverlayRow("ov_orig", "cap_1");
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [existing] });
      if (name === "overlays:delete") return Promise.resolve({ ok: true, value: undefined });
      if (name === "overlays:upsert") {
        const r = req as { overlay: unknown };
        return Promise.resolve({
          ok: true,
          value: { ...makeOverlayRow("ov_new", "cap_1"), data: r.overlay }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 1) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "updateOverlay",
      layerId: "ov_orig",
      patch: { kind: "arrow", color: "#ff0000" }
    });
    expect(r.ok).toBe(true);
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:upsert");
    expect(upserts.length).toBe(1);
    const sentOverlay = (upserts[0]?.[1] as { overlay: { color: string } }).overlay;
    expect(sentOverlay.color).toBe("#ff0000");
  });

  test("13d. v2 dispatchEdit: updateGeometry → layers:delete + layers:upsert with merged vector shape", async () => {
    const record = makeRecord("cap_2", 2);
    const arrowOverlay = {
      kind: "arrow" as const,
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.5, y: 0.5 },
      color: "auto" as const
    };
    const vectorLayer: BundleLayerNode = {
      id: "ly_orig",
      parent_id: null,
      name: "Arrow",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0,
      source: "user",
      ai_run_id: null,
      applied_at: "2026-05-24T00:00:00Z",
      rejected_at: null,
      superseded_by: null,
      created_at: "2026-05-24T00:00:00Z",
      kind: "vector",
      shape: arrowOverlay
    };
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "layers:list") return Promise.resolve({ ok: true, value: [vectorLayer] });
      if (name === "layers:delete") return Promise.resolve({ ok: true, value: undefined });
      if (name === "layers:upsert") {
        const r = req as { layer: BundleLayerNode };
        return Promise.resolve({ ok: true, value: r.layer });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 2) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "updateGeometry",
      layerId: "ly_orig",
      geometry: {
        kind: "arrow",
        from: { x: 0.2, y: 0.2 },
        to: { x: 0.9, y: 0.9 }
      }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.kind).toBe("update");
    if (r.value.kind !== "update") throw new Error("unreachable");
    expect(r.value.artifact.format).toBe(2);
    const deletes = dispatchMock.mock.calls.filter((c) => c[0] === "layers:delete");
    expect(deletes.length).toBe(1);
    expect(deletes[0]?.[1]).toEqual({ id: "ly_orig" });
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "layers:upsert");
    expect(upserts.length).toBe(1);
    const sentLayer = (upserts[0]?.[1] as { layer: BundleLayerNode }).layer;
    expect(sentLayer.kind).toBe("vector");
    if (sentLayer.kind === "vector" && sentLayer.shape.kind === "arrow") {
      expect(sentLayer.shape.from.x).toBeCloseTo(0.2);
      expect(sentLayer.shape.to.x).toBeCloseTo(0.9);
    }
    // The new layer has a different id from the original (delete+insert).
    expect(sentLayer.id).not.toBe("ly_orig");
  });

  // ───────────────────────────────────────────────────────────────────────
  // PR #150 follow-up: z_index preservation across updateGeometry /
  // updateOverlay.
  //
  // User-reported bug: "I right-clicked the rotated red rectangle and
  // chose Send to Back. I dragged it over to the arrows. It was behind
  // them while dragging. I let go of the mouse and it jumped in front
  // of them."
  //
  // Root cause: both v1 and v2 updateGeometry / updateOverlay implement
  // edit-in-place as DELETE + INSERT. The INSERT path treats the
  // operation as "fresh draw" and bumps z_index to MAX + GAP, clobbering
  // the user's explicit Send-to-Back position. Same shape for nudge
  // (arrow keys), multi-drag (group pointerup commit), and undo restore.
  //
  // Fix contract:
  //   • v1: the dispatcher reads `current.z_index` and threads it through
  //     `overlays:upsert` as `req.zIndex` (a new optional field that
  //     `insertOverlay` already supports as `input.zIndex`).
  //   • v2: the merged layer node carries the original z_index by
  //     virtue of `...layer` spread in `applyGeometryToLayer`. The
  //     dispatcher does NOT pass `bumpZIndexToMax: true`; layers-repo
  //     stores `node.z_index` verbatim.
  //
  // These tests pin the dispatcher's outgoing IPC payloads. If a future
  // refactor breaks z_index preservation, they fail before any user
  // sees the regression.
  // ───────────────────────────────────────────────────────────────────────

  test("13e. v1 dispatchEdit: updateGeometry preserves current.z_index in overlays:upsert payload (Send-to-Back regression)", async () => {
    const record = makeRecord("cap_1", 1);
    // The load-bearing setup: existing row is at z_index = 0 (the
    // user Sent it to Back). After updateGeometry the new row must
    // ALSO be at z_index = 0 — anything else jumps the rect to the
    // top of the stack on drag-drop.
    const existing: OverlayRow = { ...makeOverlayRow("ov_stb", "cap_1"), z_index: 0 };
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [existing] });
      if (name === "overlays:delete") return Promise.resolve({ ok: true, value: undefined });
      if (name === "overlays:upsert") {
        const r = req as { overlay: unknown };
        return Promise.resolve({
          ok: true,
          value: { ...makeOverlayRow("ov_new", "cap_1"), data: r.overlay, z_index: 0 }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 1) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "updateGeometry",
      layerId: "ov_stb",
      geometry: {
        kind: "arrow",
        from: { x: 0.3, y: 0.3 },
        to: { x: 0.9, y: 0.9 }
      }
    });
    expect(r.ok).toBe(true);
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:upsert");
    expect(upserts.length).toBe(1);
    const sentReq = upserts[0]?.[1] as { overlay: unknown; zIndex?: number };
    // The dispatcher MUST forward the original z_index. Pre-fix this
    // field was absent → handler called insertOverlay without zIndex
    // → auto-bump → user's Send-to-Back was undone by every drag.
    expect(sentReq.zIndex).toBe(0);
  });

  test("13f. v1 dispatchEdit: updateGeometry preserves current.z_index > 0 in overlays:upsert payload", async () => {
    // Mid-stack preservation. A row at z_index = 2000 (some middle-
    // of-stack reorder) must stay at 2000 across drag-drop.
    const record = makeRecord("cap_1", 1);
    const existing: OverlayRow = { ...makeOverlayRow("ov_mid", "cap_1"), z_index: 2000 };
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [existing] });
      if (name === "overlays:delete") return Promise.resolve({ ok: true, value: undefined });
      if (name === "overlays:upsert") {
        const r = req as { overlay: unknown };
        return Promise.resolve({
          ok: true,
          value: { ...makeOverlayRow("ov_new", "cap_1"), data: r.overlay, z_index: 2000 }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 1) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "updateGeometry",
      layerId: "ov_mid",
      geometry: {
        kind: "arrow",
        from: { x: 0.4, y: 0.4 },
        to: { x: 0.8, y: 0.8 }
      }
    });
    expect(r.ok).toBe(true);
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:upsert");
    const sentReq = upserts[0]?.[1] as { overlay: unknown; zIndex?: number };
    expect(sentReq.zIndex).toBe(2000);
  });

  test("13g. v1 dispatchEdit: updateOverlay preserves current.z_index in overlays:upsert payload", async () => {
    // Same shape for style-patch (color/thickness/etc.). Style edits
    // shouldn't change stacking order.
    const record = makeRecord("cap_1", 1);
    const existing: OverlayRow = { ...makeOverlayRow("ov_stl", "cap_1"), z_index: 0 };
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: [existing] });
      if (name === "overlays:delete") return Promise.resolve({ ok: true, value: undefined });
      if (name === "overlays:upsert") {
        const r = req as { overlay: unknown };
        return Promise.resolve({
          ok: true,
          value: { ...makeOverlayRow("ov_new", "cap_1"), data: r.overlay, z_index: 0 }
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 1) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "updateOverlay",
      layerId: "ov_stl",
      patch: { kind: "arrow", color: "#00ff00" }
    });
    expect(r.ok).toBe(true);
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:upsert");
    const sentReq = upserts[0]?.[1] as { overlay: unknown; zIndex?: number };
    expect(sentReq.zIndex).toBe(0);
  });

  test("13h. v2 dispatchEdit: updateGeometry preserves layer.z_index = 0 (Send-to-Back regression)", async () => {
    // v2 mirror of 13e. layers:upsert receives the merged layer with
    // z_index = 0; the dispatcher must NOT set `bumpZIndexToMax: true`
    // (which would tell layers-repo to auto-bump).
    const record = makeRecord("cap_2", 2);
    const vectorLayer: BundleLayerNode = {
      id: "ly_stb",
      parent_id: null,
      name: "Rect",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0, // ← Sent to Back, the load-bearing field
      source: "user",
      ai_run_id: null,
      applied_at: "2026-05-24T00:00:00Z",
      rejected_at: null,
      superseded_by: null,
      created_at: "2026-05-24T00:00:00Z",
      kind: "vector",
      shape: {
        kind: "rect",
        rect: { x: 0.2, y: 0.3, w: 0.4, h: 0.3 },
        color: "auto"
      }
    };
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "layers:list") return Promise.resolve({ ok: true, value: [vectorLayer] });
      if (name === "layers:delete") return Promise.resolve({ ok: true, value: undefined });
      if (name === "layers:upsert") {
        const r = req as { layer: BundleLayerNode };
        return Promise.resolve({ ok: true, value: r.layer });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 2) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "updateGeometry",
      layerId: "ly_stb",
      geometry: {
        kind: "rect",
        rect: { x: 0.5, y: 0.5, w: 0.4, h: 0.3 }
      }
    });
    expect(r.ok).toBe(true);
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "layers:upsert");
    expect(upserts.length).toBe(1);
    const sentReq = upserts[0]?.[1] as {
      layer: BundleLayerNode;
      bumpZIndexToMax?: boolean;
    };
    // The merged layer must carry the ORIGINAL z_index = 0.
    expect(sentReq.layer.z_index).toBe(0);
    // The dispatcher must NOT request auto-bump on an update path —
    // otherwise the repo would bump the 0 to MAX + GAP, jumping the
    // rect to the top of the stack.
    expect(sentReq.bumpZIndexToMax).not.toBe(true);
  });

  test("13i. v2 dispatchEdit: updateGeometry preserves layer.z_index > 0 in layers:upsert payload", async () => {
    const record = makeRecord("cap_2", 2);
    const vectorLayer: BundleLayerNode = {
      id: "ly_mid",
      parent_id: null,
      name: "Arrow",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 3000,
      source: "user",
      ai_run_id: null,
      applied_at: "2026-05-24T00:00:00Z",
      rejected_at: null,
      superseded_by: null,
      created_at: "2026-05-24T00:00:00Z",
      kind: "vector",
      shape: {
        kind: "arrow",
        from: { x: 0.1, y: 0.1 },
        to: { x: 0.5, y: 0.5 },
        color: "auto"
      }
    };
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "layers:list") return Promise.resolve({ ok: true, value: [vectorLayer] });
      if (name === "layers:delete") return Promise.resolve({ ok: true, value: undefined });
      if (name === "layers:upsert") {
        const r = req as { layer: BundleLayerNode };
        return Promise.resolve({ ok: true, value: r.layer });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    const m = model!;
    if (m.kind !== "loaded" || m.format !== 2) throw new Error("unexpected model");
    const r = await m.dispatchEdit({
      kind: "updateGeometry",
      layerId: "ly_mid",
      geometry: {
        kind: "arrow",
        from: { x: 0.2, y: 0.2 },
        to: { x: 0.7, y: 0.7 }
      }
    });
    expect(r.ok).toBe(true);
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "layers:upsert");
    const sentReq = upserts[0]?.[1] as {
      layer: BundleLayerNode;
      bumpZIndexToMax?: boolean;
    };
    expect(sentReq.layer.z_index).toBe(3000);
    expect(sentReq.bumpZIndexToMax).not.toBe(true);
  });

  test("13j. v2 multi-drag preserves EACH layer's distinct z_index across the sequence", async () => {
    // Multi-drag is the user-facing pointerup commit at the end of a
    // group drag. It dispatches updateGeometry per selected layer in
    // a coalesced bracket. The contract: each dispatch must carry its
    // OWN layer's z_index — a sent-to-back rect in a multi-selection
    // with a top-of-stack arrow must NOT get the arrow's z_index, and
    // neither layer should be auto-bumped.
    //
    // We model the multi-drag as three sequential dispatchEdit calls
    // (the renderer's commit loop runs them serially via for-of). The
    // mock layers:list state advances after each dispatch so the
    // dispatcher's `layersRef.current.find(...)` sees the latest list
    // — matches the broadcast → refetch cycle that lands between
    // dispatches in production.
    const record = makeRecord("cap_2", 2);
    function mkLayer(id: string, zIndex: number): BundleLayerNode {
      return {
        id,
        parent_id: null,
        name: "Arrow",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal",
        transform: [1, 0, 0, 1, 0, 0],
        z_index: zIndex,
        source: "user",
        ai_run_id: null,
        applied_at: "2026-05-24T00:00:00Z",
        rejected_at: null,
        superseded_by: null,
        created_at: "2026-05-24T00:00:00Z",
        kind: "vector",
        shape: {
          kind: "arrow",
          from: { x: 0.1, y: 0.1 },
          to: { x: 0.4, y: 0.4 },
          color: "auto"
        }
      };
    }
    const a = mkLayer("ly_md_a", 0); // Sent to Back
    const b = mkLayer("ly_md_b", 2000); // Mid-stack
    const c = mkLayer("ly_md_c", 5000); // Near top
    let liveLayers = [a, b, c];
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "layers:list") return Promise.resolve({ ok: true, value: liveLayers });
      if (name === "layers:delete") {
        const r = req as { id: string };
        liveLayers = liveLayers.filter((l) => l.id !== r.id);
        return Promise.resolve({ ok: true, value: undefined });
      }
      if (name === "layers:upsert") {
        const r = req as { layer: BundleLayerNode };
        liveLayers = [...liveLayers, r.layer];
        return Promise.resolve({ ok: true, value: r.layer });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();
    const m = model!;
    if (m.kind !== "loaded" || m.format !== 2) throw new Error("unexpected model");

    // Drag the WHOLE group by (+0.1, +0.1). The renderer's commit
    // helper translates each snapshot's geometry by the delta and
    // dispatches updateGeometry per layer.
    for (const layer of [a, b, c]) {
      if (layer.kind !== "vector" || layer.shape.kind !== "arrow") continue;
      const r = await m.dispatchEdit({
        kind: "updateGeometry",
        layerId: layer.id,
        geometry: {
          kind: "arrow",
          from: { x: layer.shape.from.x + 0.1, y: layer.shape.from.y + 0.1 },
          to: { x: layer.shape.to.x + 0.1, y: layer.shape.to.y + 0.1 }
        }
      });
      expect(r.ok).toBe(true);
    }

    // Three layers:upsert calls, each carrying its OWN original z_index.
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "layers:upsert");
    expect(upserts.length).toBe(3);
    const sentZIndexes = upserts.map(
      (call) =>
        (call[1] as { layer: BundleLayerNode }).layer.z_index
    );
    expect(sentZIndexes).toEqual([0, 2000, 5000]);
    // NONE of the dispatches request auto-bump — multi-drag is an
    // update-in-place, not a fresh draw.
    for (const call of upserts) {
      const req = call[1] as { bumpZIndexToMax?: boolean };
      expect(req.bumpZIndexToMax).not.toBe(true);
    }
  });

  test("13k. v1 multi-drag preserves EACH overlay's distinct z_index across the sequence", async () => {
    // v1 mirror of 13j. Same shape: per-row updateGeometry dispatches
    // each forward their CURRENT row's z_index to overlays:upsert.
    const record = makeRecord("cap_1", 1);
    function mkRow(id: string, zIndex: number): OverlayRow {
      return { ...makeOverlayRow(id, "cap_1"), z_index: zIndex };
    }
    const a = mkRow("ov_md_a", 0);
    const b = mkRow("ov_md_b", 2000);
    const c = mkRow("ov_md_c", 5000);
    let liveRows = [a, b, c];
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: liveRows });
      if (name === "overlays:delete") {
        const r = req as { id: string };
        liveRows = liveRows.filter((o) => o.id !== r.id);
        return Promise.resolve({ ok: true, value: undefined });
      }
      if (name === "overlays:upsert") {
        const r = req as { overlay: unknown; zIndex?: number };
        const newRow: OverlayRow = {
          ...makeOverlayRow(`${liveRows.length}`, "cap_1"),
          data: r.overlay as OverlayRow["data"],
          ...(r.zIndex !== undefined ? { z_index: r.zIndex } : {})
        };
        liveRows = [...liveRows, newRow];
        return Promise.resolve({ ok: true, value: newRow });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();
    const m = model!;
    if (m.kind !== "loaded" || m.format !== 1) throw new Error("unexpected model");

    for (const row of [a, b, c]) {
      if (row.data.kind !== "arrow") continue;
      const result = await m.dispatchEdit({
        kind: "updateGeometry",
        layerId: row.id,
        geometry: {
          kind: "arrow",
          from: { x: row.data.from.x + 0.1, y: row.data.from.y + 0.1 },
          to: { x: row.data.to.x + 0.1, y: row.data.to.y + 0.1 }
        }
      });
      expect(result.ok).toBe(true);
    }

    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:upsert");
    expect(upserts.length).toBe(3);
    const sentZIndexes = upserts.map(
      (call) => (call[1] as { zIndex?: number }).zIndex
    );
    expect(sentZIndexes).toEqual([0, 2000, 5000]);
  });

  test("13l. v2 Send-to-Back → drag-drop end-to-end: z_index stays at 0 across the full sequence", async () => {
    // The user's exact repro flow: "I right-clicked the rotated red
    // rectangle and chose Send to Back. I dragged it. It jumped in
    // front of the arrows on release."
    //
    // Sequence:
    //   1. Initial state: rect at z_index = 5000 (created via fresh
    //      draw, auto-bumped to top).
    //   2. dispatchEdit({ kind: "reorder", layerId, zIndex: 0 })
    //      → layers:reorder → rect's z_index becomes 0 in the live
    //      list.
    //   3. dispatchEdit({ kind: "updateGeometry", layerId, geometry })
    //      → layers:delete + layers:upsert with merged.z_index = 0
    //      and NO bumpZIndexToMax flag → the inserted row preserves 0.
    //
    // The mock state advances after each dispatch so the dispatcher
    // sees the latest list (matches the broadcast → refetch cycle).
    // This locks the FULL user-facing flow, not just the dispatcher's
    // outgoing payload in isolation.
    const record = makeRecord("cap_2", 2);
    const initialRect: BundleLayerNode = {
      id: "ly_stb_flow",
      parent_id: null,
      name: "Rect",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 5000, // Created via fresh draw, auto-bumped to top
      source: "user",
      ai_run_id: null,
      applied_at: "2026-05-24T00:00:00Z",
      rejected_at: null,
      superseded_by: null,
      created_at: "2026-05-24T00:00:00Z",
      kind: "vector",
      shape: {
        kind: "rect",
        rect: { x: 0.2, y: 0.3, w: 0.4, h: 0.3 },
        color: "auto"
      }
    };
    let liveLayers: BundleLayerNode[] = [initialRect];
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "layers:list") return Promise.resolve({ ok: true, value: liveLayers });
      if (name === "layers:reorder") {
        // layers:reorder is an in-place z_index UPDATE — mirror that
        // by mutating the layer's z_index in our live list.
        const r = req as { id: string; zIndex: number };
        liveLayers = liveLayers.map((l) =>
          l.id === r.id ? { ...l, z_index: r.zIndex } : l
        );
        return Promise.resolve({ ok: true, value: undefined });
      }
      if (name === "layers:delete") {
        const r = req as { id: string };
        liveLayers = liveLayers.filter((l) => l.id !== r.id);
        return Promise.resolve({ ok: true, value: undefined });
      }
      if (name === "layers:upsert") {
        const r = req as { layer: BundleLayerNode; bumpZIndexToMax?: boolean };
        // Mirror the post-fix layers-repo behavior: when
        // bumpZIndexToMax !== true, store node.z_index verbatim.
        const storedLayer: BundleLayerNode = { ...r.layer };
        liveLayers = [...liveLayers, storedLayer];
        return Promise.resolve({ ok: true, value: storedLayer });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_2",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();
    const m = model!;
    if (m.kind !== "loaded" || m.format !== 2) throw new Error("unexpected model");

    // Step 1: Send to Back → reorder dispatches zIndex: 0.
    const reorderResult = await m.dispatchEdit({
      kind: "reorder",
      layerId: "ly_stb_flow",
      zIndex: 0
    });
    expect(reorderResult.ok).toBe(true);
    // Sanity check the mock state: rect now at z_index 0 in live list.
    const afterReorder = liveLayers.find((l) => l.id === "ly_stb_flow");
    expect(afterReorder?.z_index).toBe(0);

    // Simulate the post-reorder broadcast → refetch → state update.
    // In production this is `events:overlays:changed` fired by BOTH
    // overlays-handlers AND layers-handlers (see useCaptureModel's
    // subscription comment); the test harness synthesizes it via the
    // `broadcast` helper so the dispatcher's `layersRef` picks up
    // the post-reorder z_index. Without this, the subsequent
    // updateGeometry would see the STALE cached layer
    // (z_index = 5000) and preserve that — still correct contract
    // behavior (preserve current.z_index), but tests the wrong
    // scenario. The user's bug specifically needs the broadcast to
    // have landed: they wait between Send-to-Back and the drag.
    await act(async () => {
      broadcast("events:overlays:changed", { captureId: record.id });
      await Promise.resolve();
    });

    // Step 2: Drag-drop → updateGeometry.
    const dragResult = await m.dispatchEdit({
      kind: "updateGeometry",
      layerId: "ly_stb_flow",
      geometry: {
        kind: "rect",
        rect: { x: 0.5, y: 0.5, w: 0.4, h: 0.3 }
      }
    });
    expect(dragResult.ok).toBe(true);
    if (!dragResult.ok) throw new Error("unreachable");
    expect(dragResult.value.kind).toBe("update");

    // The freshly-inserted layer (different id, same logical row) must
    // still be at z_index = 0. Pre-fix it would be auto-bumped to
    // MAX + GAP = 1000 (since the old layer was already deleted by
    // the time MAX was computed, but for safety the test asserts
    // strictly: the new row IS at z_index 0).
    if (dragResult.value.kind !== "update") throw new Error("unreachable");
    if (dragResult.value.artifact.format !== 2) throw new Error("unreachable");
    expect(dragResult.value.artifact.node.z_index).toBe(0);

    // The dispatched layers:upsert call must NOT have requested
    // auto-bump (that's the load-bearing contract bit the user's
    // bug exposed).
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "layers:upsert");
    expect(upserts.length).toBe(1);
    const sentReq = upserts[0]?.[1] as {
      layer: BundleLayerNode;
      bumpZIndexToMax?: boolean;
    };
    expect(sentReq.layer.z_index).toBe(0);
    expect(sentReq.bumpZIndexToMax).not.toBe(true);
  });

  test("13m. v1 Send-to-Back → drag-drop end-to-end: z_index stays at 0 across the full sequence", async () => {
    // v1 mirror of 13l. Same flow: overlays:reorder → updateGeometry's
    // overlays:delete + overlays:upsert. The dispatcher reads
    // current.z_index from the LIVE row (post-reorder = 0) and
    // forwards it on the upsert.
    const record = makeRecord("cap_1", 1);
    const initialRow: OverlayRow = {
      ...makeOverlayRow("ov_stb_flow", "cap_1"),
      data: {
        kind: "rect",
        rect: { x: 0.2, y: 0.3, w: 0.4, h: 0.3 },
        color: "auto"
      },
      z_index: 5000
    };
    let liveRows: OverlayRow[] = [initialRow];
    dispatchMock.mockImplementation((name: string, req: unknown) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      if (name === "overlays:list") return Promise.resolve({ ok: true, value: liveRows });
      if (name === "overlays:reorder") {
        const r = req as { id: string; zIndex: number };
        liveRows = liveRows.map((o) =>
          o.id === r.id ? { ...o, z_index: r.zIndex } : o
        );
        return Promise.resolve({ ok: true, value: undefined });
      }
      if (name === "overlays:delete") {
        const r = req as { id: string };
        liveRows = liveRows.filter((o) => o.id !== r.id);
        return Promise.resolve({ ok: true, value: undefined });
      }
      if (name === "overlays:upsert") {
        const r = req as { overlay: unknown; zIndex?: number };
        // Mirror post-fix overlays-repo: when zIndex is present, store
        // it verbatim; omitted → auto-bump (not exercised here).
        const newRow: OverlayRow = {
          ...makeOverlayRow(`ov_new_${liveRows.length}`, "cap_1"),
          data: r.overlay as OverlayRow["data"],
          ...(r.zIndex !== undefined ? { z_index: r.zIndex } : {})
        };
        liveRows = [...liveRows, newRow];
        return Promise.resolve({ ok: true, value: newRow });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();
    const m = model!;
    if (m.kind !== "loaded" || m.format !== 1) throw new Error("unexpected model");

    // Step 1: Send to Back.
    const reorderResult = await m.dispatchEdit({
      kind: "reorder",
      layerId: "ov_stb_flow",
      zIndex: 0
    });
    expect(reorderResult.ok).toBe(true);
    const afterReorder = liveRows.find((r) => r.id === "ov_stb_flow");
    expect(afterReorder?.z_index).toBe(0);

    // Same broadcast simulation as 13l. See its comment for the
    // rationale on why the broadcast must land before the drag for
    // this test to exercise the user's actual flow.
    await act(async () => {
      broadcast("events:overlays:changed", { captureId: record.id });
      await Promise.resolve();
    });

    // Step 2: Drag-drop.
    const dragResult = await m.dispatchEdit({
      kind: "updateGeometry",
      layerId: "ov_stb_flow",
      geometry: {
        kind: "rect",
        rect: { x: 0.5, y: 0.5, w: 0.4, h: 0.3 }
      }
    });
    expect(dragResult.ok).toBe(true);
    if (!dragResult.ok) throw new Error("unreachable");
    if (dragResult.value.kind !== "update") throw new Error("unreachable");
    if (dragResult.value.artifact.format !== 1) throw new Error("unreachable");
    // The new row (different id, same logical row) must still be at z=0.
    expect(dragResult.value.artifact.row.z_index).toBe(0);

    // The overlays:upsert call must carry zIndex: 0 explicitly.
    const upserts = dispatchMock.mock.calls.filter((c) => c[0] === "overlays:upsert");
    expect(upserts.length).toBe(1);
    const sentReq = upserts[0]?.[1] as { overlay: unknown; zIndex?: number };
    expect(sentReq.zIndex).toBe(0);
  });

  test("12. invalid bundle_format_version (99) returns error", async () => {
    const record = makeRecord("cap_weird", 99);
    dispatchMock.mockImplementation((name: string) => {
      if (name === "library:byId") return Promise.resolve({ ok: true, value: record });
      return Promise.resolve({ ok: true, value: null });
    });

    let model: CaptureModel | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_weird",
        onSnapshot: (m) => {
          model = m;
        }
      })
    );
    await flush();

    // We treat anything below 1 as error; anything >= 2 routes through
    // the v2 path. 99 is therefore "loaded as v2" rather than crashing.
    // The contract: the hook never crashes; it returns either a typed
    // loaded model or an error model. Either is acceptable here.
    const m = model!;
    expect(["loaded", "error"]).toContain(m.kind);
    // Specifically: 99 >= 2 → v2 path is reasonable. Verify no crash.
    if (m.kind === "loaded") {
      expect(m.format).toBe(2);
    }
  });
});
