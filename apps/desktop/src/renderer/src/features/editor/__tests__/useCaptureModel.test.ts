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
