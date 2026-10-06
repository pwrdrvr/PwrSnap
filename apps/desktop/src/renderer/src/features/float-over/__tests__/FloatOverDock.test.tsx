// The screen-edge dock, end to end in the renderer: a toast whose snap
// the model is still reading tucks when its countdown ends, snaps wait on
// the dock (or the rail beside the next toast), and every close decides
// between the dock and going away.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  EVENT_CHANNELS,
  type CaptureEnrichment,
  type CaptureRecord,
  type FloatOverOverflowChoice,
  type Settings,
  type VideoRange
} from "@pwrsnap/shared";
import { FloatOver } from "../FloatOver";
import { FloatOverHost } from "../FloatOverHost";
import { DOCK_TUCK_COUNTDOWN_MS, FIRST_RUN_GRACE_MS } from "../float-over-dock-model";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    class ResizeObserver {
      observe(): void {
        return;
      }
      unobserve(): void {
        return;
      }
      disconnect(): void {
        return;
      }
    } as unknown as typeof ResizeObserver;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function enrichment(
  captureId: string,
  status: CaptureEnrichment["status"]
): CaptureEnrichment {
  return {
    captureId,
    latestRunId: `run_${captureId}`,
    status,
    error: null,
    ocrText: null,
    suggestedTitle: status === "completed" ? "Cereal aisle price tags" : null,
    acceptedTitle: null,
    titleAcceptedAt: null,
    suggestedFilenameStem: null,
    acceptedFilenameStem: null,
    filenameAcceptedAt: null,
    suggestedDescription: null,
    acceptedDescription: null,
    descriptionAcceptedAt: null,
    suggestedTags: [],
    acceptedTags: []
  };
}

function record(id: string, capturedAt = "2026-09-27T10:00:00.000Z"): CaptureRecord {
  return {
    id,
    kind: "image",
    captured_at: capturedAt,
    legacy_src_path: `/tmp/${id}.png`,
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 2,
    bundle_edits_version: 0,
    width_px: 1280,
    height_px: 800,
    device_pixel_ratio: 1,
    byte_size: 1000,
    sha256: `sha_${id}`,
    source_app_bundle_id: null,
    source_app_name: "Toaster",
    source_window_title: null,
    edits_version: 0,
    has_alpha: false,
    deleted_at: null,
    video: null
  };
}

// Only what the host and toast read. AI is on and consented, so
// enrichment is going to run for every snap.
const settings = {
  codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "" },
  ai: {
    enabled: true,
    consentAcceptedAt: "2026-09-01T00:00:00.000Z",
    budgetSafetyDisabledAt: null,
    autoAcceptSuggestions: false,
    defaults: { libraryChat: {}, sizzleChat: {}, enrichment: {} }
  },
  storage: { filenameTimestampZone: "local", capturesLocation: "documents" },
  experimental: { processSplit: true, dpiAwareExport: false, allowRetinaExport: true }
} as unknown as Settings;

const codexSnapshot = {
  candidates: [{ path: "codex", source: "path", version: "1.0.0", available: true }],
  resolvedPath: "codex",
  auth: { status: "authenticated", testedAt: "2026-09-01T00:00:00.000Z", durationMs: 1, detail: "" },
  refreshedAt: "2026-09-01T00:00:00.000Z"
};

type EventHandler = (payload: unknown) => void;

type HostApi = {
  push: (channel: string, payload: unknown) => void;
  dispatch: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  passThrough: ReturnType<typeof vi.fn>;
  /** What `library:list` serves, newest first. `showSnap` adds to it. */
  library: CaptureRecord[];
  /** Runs of a verb, as `[request]` tuples. */
  calls: (verb: string) => unknown[];
};

function installHostApi(options: {
  dock?: boolean;
  settings?: Settings;
  enrichmentFor?: (captureId: string) => CaptureEnrichment | null;
  byId?: (id: string) => CaptureRecord | null | Promise<CaptureRecord | null>;
  library?: CaptureRecord[];
  pageSize?: number;
  overflowChoice?: FloatOverOverflowChoice;
} = {}): HostApi {
  const subscribers = new Map<string, Set<EventHandler>>();
  const library: CaptureRecord[] = options.library ?? [];
  const dispatch = vi.fn(async (name: string, req: Record<string, unknown>) => {
    switch (name) {
      case "float-over:capabilities":
        return { ok: true, value: { dock: options.dock ?? true } };
      case "float-over:tuck":
        return { ok: true, value: { docked: options.dock ?? true } };
      case "float-over:overflowMenu":
        return { ok: true, value: { choice: options.overflowChoice ?? null } };
      case "settings:read":
        return { ok: true, value: options.settings ?? settings };
      case "settings:refreshCodexDiscovery":
        return { ok: true, value: codexSnapshot };
      case "capture:presetMetrics":
      case "video:presetMetrics":
        return { ok: true, value: { metrics: [] } };
      case "codex:enrichment":
        return {
          ok: true,
          value: options.enrichmentFor?.(req.captureId as string) ?? null
        };
      case "library:list": {
        const sorted = [...library].sort((a, b) =>
          a.captured_at === b.captured_at ? (a.id < b.id ? 1 : -1) : a.captured_at < b.captured_at ? 1 : -1
        );
        const cursor = req.cursor as { id: string } | undefined;
        const start = cursor === undefined ? 0 : sorted.findIndex((row) => row.id === cursor.id) + 1;
        const size = options.pageSize ?? (req.limit as number);
        const rows = sorted.slice(start, start + size);
        const last = rows.at(-1);
        const more = start + size < sorted.length && last !== undefined;
        return {
          ok: true,
          value: {
            rows,
            nextCursor: more ? { capturedAt: last.captured_at, id: last.id } : null
          }
        };
      }
      case "library:listByIds":
        return {
          ok: true,
          value: { rows: library.filter((row) => (req.ids as string[]).includes(row.id)) }
        };
      case "library:byId":
        return {
          ok: true,
          value: options.byId !== undefined ? await options.byId(req.id as string) : record(req.id as string)
        };
      default:
        return { ok: true, value: undefined };
    }
  });
  const resize = vi.fn();
  const passThrough = vi.fn();
  window.pwrsnapApi = {
    dispatch,
    on: (channel: string, handler: EventHandler) => {
      const set = subscribers.get(channel) ?? new Set<EventHandler>();
      set.add(handler);
      subscribers.set(channel, set);
      return () => {
        set.delete(handler);
      };
    },
    requestFloatOverResize: resize,
    requestFloatOverDockDrag: vi.fn(),
    requestFloatOverState: vi.fn(),
    setFloatOverPassThrough: passThrough,
    startCaptureDrag: vi.fn()
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return {
    push(channel, payload) {
      for (const handler of subscribers.get(channel) ?? []) handler(payload);
    },
    dispatch,
    resize,
    passThrough,
    library,
    calls: (verb) =>
      dispatch.mock.calls.filter(([name]) => name === verb).map(([, req]) => req)
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function mountHost(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(FloatOverHost));
  });
  await flush();
  return container;
}

async function push(api: HostApi, channel: string, payload: unknown): Promise<void> {
  await act(async () => {
    api.push(channel, payload);
  });
  await flush();
}

async function showSnap(api: HostApi, id: string, status: CaptureEnrichment["status"]): Promise<void> {
  if (!api.library.some((row) => row.id === id)) api.library.push(record(id));
  await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: id, record: record(id) });
  await push(api, EVENT_CHANNELS.aiRunUpdated, { enrichment: enrichment(id, status) });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

async function press(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, screenX: 5, screenY: 5 }));
    el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, screenX: 5, screenY: 5 }));
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "Date"]
  });
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

describe("FloatOverHost active video revalidation", () => {
  function videoRecord(id: string, range: VideoRange): CaptureRecord {
    return {
      ...record(id), kind: "video",
      video: {
        durationSec: 4, containerFormat: "mp4", hasSystemAudio: false, hasMicrophoneAudio: false,
        requestedSystemAudio: false, requestedMicrophone: false, defaultRange: range, segments: [range],
        previewPath: null, previewStatus: "failed"
      }
    };
  }
  const initial = { start: 1.81, end: 3.41 };
  const edited = { start: 2.21, end: 3.41 };
  const clock = (el: HTMLElement): string | null =>
    el.querySelector('[data-testid="preview-timecode"]')?.textContent ?? null;
  async function showVideo(api: HostApi, id: string, range = initial): Promise<void> {
    await push(api, EVENT_CHANNELS.floatOverState, {
      kind: "show-loaded", captureId: id, record: videoRecord(id, range)
    });
  }

  test("a capture-change broadcast updates the paused toast's trim, clock, and source position", async () => {
    const api = installHostApi({ byId: (id) => videoRecord(id, edited) });
    const el = await mountHost();
    await showVideo(api, "vid_1");
    await push(api, EVENT_CHANNELS.aiRunUpdated, { enrichment: enrichment("vid_1", "completed") });
    expect(clock(el)).toBe("0:00.0 / 0:01.6");
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["vid_1"] });
    expect(clock(el)).toBe("0:00.0 / 0:01.2");
    expect(el.querySelector<HTMLVideoElement>(".fo__preview video")?.currentTime).toBe(2.21);
    expect(el.querySelector(".fo__preview-size")?.textContent).toBe("1.2s");
    expect(el.querySelector('[data-testid="video-timeline-trim-label"]')?.textContent)
      .toBe("TRIM 0:02.2 – 0:03.4 · 1.2 s");
    expect(el.textContent).toContain("Codex drafted a title + description.");
  });

  test("a broadcast for another capture does not replace or re-read the active video", async () => {
    const api = installHostApi();
    const el = await mountHost();
    await showVideo(api, "vid_1");
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["other"] });
    expect(api.calls("library:byId")).toEqual([]);
    expect(clock(el)).toBe("0:00.0 / 0:01.6");
  });

  test("an older refresh cannot restore a trim after a newer broadcast resolves", async () => {
    let resolveOld!: (value: CaptureRecord) => void;
    let reads = 0;
    const newer = { start: 2.41, end: 3.41 };
    const api = installHostApi({ byId: (id) => ++reads === 1
      ? new Promise<CaptureRecord>((resolve) => { resolveOld = resolve; })
      : videoRecord(id, newer) });
    const el = await mountHost();
    await showVideo(api, "vid_1");
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["vid_1"] });
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["vid_1"] });
    expect(clock(el)).toBe("0:00.0 / 0:01.0");
    await act(async () => resolveOld(videoRecord("vid_1", edited)));
    await flush();
    expect(clock(el)).toBe("0:00.0 / 0:01.0");
  });

  test("a refresh from a previous toast cannot replace a newly shown capture", async () => {
    let resolveOld!: (value: CaptureRecord) => void;
    const api = installHostApi({ byId: () => new Promise<CaptureRecord>((resolve) => { resolveOld = resolve; }) });
    const el = await mountHost();
    await showVideo(api, "vid_1");
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["vid_1"] });
    await showVideo(api, "vid_2", { start: 0, end: 4 });
    await act(async () => resolveOld(videoRecord("vid_1", edited)));
    await flush();
    expect(el.querySelector(".fo__preview video")?.getAttribute("src")).toBe("pwrsnap-capture://r/vid_2");
    expect(clock(el)).toBe("0:00.0 / 0:04.0");
  });

  test("reopening the same capture retires a refresh from its previous showing", async () => {
    let resolveOld!: (value: CaptureRecord) => void;
    const api = installHostApi({ byId: () => new Promise<CaptureRecord>((resolve) => { resolveOld = resolve; }) });
    const el = await mountHost();
    await showVideo(api, "vid_1");
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["vid_1"] });
    await showVideo(api, "vid_1", { start: 2.81, end: 3.41 });
    await act(async () => resolveOld(videoRecord("vid_1", edited)));
    await flush();
    expect(clock(el)).toBe("0:00.0 / 0:00.6");
  });
});

describe("FloatOver tuck countdown", () => {
  const running = enrichment("cap_1", "running");
  const baseProps = {
    src: "pwrsnap-capture://r/cap_1",
    srcW: 1280,
    srcH: 800,
    srcBytes: 1000,
    aiEnabled: true,
    aiConsentAccepted: true,
    providerAvailable: true,
    startCountdown: true
  };

  async function render(props: Parameters<typeof FloatOver>[0]): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(FloatOver, props));
    });
    return container;
  }

  test("runs while the model reads, and ends in a tuck", async () => {
    const onTimeout = vi.fn();
    const onDismiss = vi.fn();
    await render({ ...baseProps, enrichment: running, dockable: true, onTimeout, onDismiss });

    await advance(DOCK_TUCK_COUNTDOWN_MS - 200);
    expect(onTimeout).not.toHaveBeenCalled();
    await advance(600);
    expect(onTimeout).toHaveBeenCalledWith({ inFlight: true });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("without a dock the toast holds the corner until the model answers", async () => {
    const onTimeout = vi.fn();
    await render({ ...baseProps, enrichment: running, dockable: false, onTimeout });

    await advance(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(container?.querySelector('[aria-label="Tuck to the screen edge"]')).toBeNull();
  });

  test("an answer that lands gets a full countdown to be read", async () => {
    const onTimeout = vi.fn();
    const props = { ...baseProps, dockable: true, onTimeout };
    await render({ ...props, enrichment: running });
    await advance(4_000);

    await act(async () => {
      root?.render(createElement(FloatOver, { ...props, enrichment: enrichment("cap_1", "completed") }));
    });
    await advance(DOCK_TUCK_COUNTDOWN_MS - 500);
    expect(onTimeout).not.toHaveBeenCalled();
    await advance(1_000);
    expect(onTimeout).toHaveBeenCalledWith({ inFlight: false });
  });

  test("the Tuck button tucks now, and only while the model is reading", async () => {
    const onTimeout = vi.fn();
    const el = await render({ ...baseProps, enrichment: running, dockable: true, onTimeout });

    const tuck = el.querySelector<HTMLButtonElement>('[aria-label="Tuck to the screen edge"]');
    expect(tuck).not.toBeNull();
    await act(async () => {
      tuck?.click();
    });
    await advance(300);
    expect(onTimeout).toHaveBeenCalledWith({ inFlight: true });

    await act(async () => {
      root?.render(
        createElement(FloatOver, {
          ...baseProps,
          enrichment: enrichment("cap_1", "completed"),
          dockable: true,
          onTimeout
        })
      );
    });
    expect(el.querySelector('[aria-label="Tuck to the screen edge"]')).toBeNull();
  });

  test("a Tuck pressed just before the countdown ends closes the toast once", async () => {
    const onTimeout = vi.fn();
    const el = await render({ ...baseProps, enrichment: running, dockable: true, onTimeout });
    await advance(DOCK_TUCK_COUNTDOWN_MS - 100);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[aria-label="Tuck to the screen edge"]')?.click();
    });
    await advance(1_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test("with the sidebar hidden the countdown is unchanged, but nothing offers a tuck", async () => {
    const onTimeout = vi.fn();
    const el = await render({
      ...baseProps,
      enrichment: running,
      dockable: true,
      sidebarVisible: false,
      onTimeout
    });

    expect(el.querySelector('[aria-label="Tuck to the screen edge"]')).toBeNull();
    await advance(DOCK_TUCK_COUNTDOWN_MS - 200);
    expect(onTimeout).not.toHaveBeenCalled();
    await advance(600);
    expect(onTimeout).toHaveBeenCalledWith({ inFlight: true });
  });

  test("hovering the rail beside the toast pauses it like hovering the toast", async () => {
    const onTimeout = vi.fn();
    await render({ ...baseProps, enrichment: running, dockable: true, onTimeout, externalHover: true });
    await advance(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe("FloatOverHost dock", () => {
  const offlineSettings: Settings = {
    ...settings,
    ai: {
      ...settings.ai,
      defaults: {
        ...settings.ai.defaults,
        enrichment: { provider: "custom:11111111-1111-4111-8111-111111111111" }
      },
      customModels: [{
        id: "11111111-1111-4111-8111-111111111111",
        connectionId: "22222222-2222-4222-8222-222222222222",
        displayName: "Local vision model",
        modelId: "local-vision",
        capabilities: { vision: true, streaming: true },
        maxOutputTokens: 4096
      }]
    }
  };
  const endpointFailure = (captureId: string): CaptureEnrichment => ({
    ...enrichment(captureId, "failed"),
    error: "Could not reach the configured endpoint. Check its address and TLS configuration."
  });

  test("an unreachable local model leaves a failed tab after the toast times out", async () => {
    const api = installHostApi({ settings: offlineSettings });
    const el = await mountHost();
    await showSnap(api, "cap_1", "running");
    await push(api, EVENT_CHANNELS.aiRunUpdated, { enrichment: endpointFailure("cap_1") });

    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    expect(api.calls("float-over:tuck")).toEqual([{}]);
    expect(api.calls("float-over:dismiss")).toEqual([]);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    expect(el.querySelector(".fod-tab")?.getAttribute("data-status")).toBe("failed");

    // Opening reads the saved failure without retrying inference, and
    // the next timeout returns the snap to the recent-capture sidebar.
    await press(el.querySelector(".fod-tab")!);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: "cap_1" });
    expect(el.textContent).toContain("Could not reach the configured endpoint.");
    expect(api.calls("codex:enrich")).toEqual([]);
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    expect(api.calls("float-over:dismiss")).toEqual([]);
    expect(api.calls("float-over:tuck")).toEqual([{}, {}]);
  });

  describe("recent-capture sidebar setting", () => {
    const withSidebar = (show: boolean): Settings =>
      ({
        ...offlineSettings,
        recording: { showRecentCaptureSidebar: show }
      }) as unknown as Settings;
    // Everything that would mean the setting reached past visibility:
    // captures, AI runs, or the list main keeps the dock for.
    const SIDE_EFFECT_VERBS = [
      "codex:enrich",
      "codex:cancel",
      "capture:delete",
      "library:trash",
      "float-over:dismiss",
      "float-over:tuck"
    ];
    const sideEffects = (api: HostApi): unknown[] =>
      SIDE_EFFECT_VERBS.flatMap((verb) => api.calls(verb).map((req) => [verb, req]));

    test("hidden: a timed-out snap is still kept, with its status, for when it is shown", async () => {
      const api = installHostApi({ settings: withSidebar(false) });
      const el = await mountHost();
      await showSnap(api, "cap_1", "running");
      // While the model reads, a tuck would send the snap nowhere visible.
      expect(el.querySelector('[aria-label="Tuck to the screen edge"]')).toBeNull();
      await push(api, EVENT_CHANNELS.aiRunUpdated, { enrichment: endpointFailure("cap_1") });

      await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
      // The same close as with the sidebar on: main parks the dock.
      expect(api.calls("float-over:tuck")).toEqual([{}]);
      expect(api.calls("float-over:dismiss")).toEqual([]);
      expect(api.calls("codex:enrich")).toEqual([]);
      await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
      expect(el.querySelector(".fod-tab")?.getAttribute("data-status")).toBe("failed");
    });

    test("toggling the setting dispatches nothing and keeps the tabs", async () => {
      const api = installHostApi({ settings: withSidebar(true) });
      const el = await mountHost();
      await showSnap(api, "cap_1", "failed");
      await showSnap(api, "cap_2", "running");
      await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
      await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
      const statuses = (): Array<string | null> =>
        Array.from(el.querySelectorAll(".fod-tab"), (tab) => tab.getAttribute("data-status"));
      expect(statuses()).toEqual(["reading", "failed"]);
      const before = sideEffects(api);

      for (const show of [false, true]) {
        await push(api, EVENT_CHANNELS.settingsChanged, { settings: withSidebar(show), secrets: {} });
      }
      expect(sideEffects(api)).toEqual(before);
      expect(statuses()).toEqual(["reading", "failed"]);
    });
  });

  test("a new capture preserves an unopened model failure on the dock", async () => {
    const api = installHostApi({ settings: offlineSettings });
    const el = await mountHost();
    await showSnap(api, "cap_1", "failed");
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-idle" });
    expect(api.calls("float-over:tuck")).toEqual([{ markOnly: true }]);
    await showSnap(api, "cap_2", "completed");
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    expect(Array.from(el.querySelectorAll(".fod-tab"), (tab) => tab.getAttribute("data-status"))).toEqual(["ready", "failed"]);
    expect(api.calls("float-over:dismiss")).toEqual([]);
  });

  test("explicitly dismissing a failed toast clears it", async () => {
    const api = installHostApi({ settings: offlineSettings });
    const el = await mountHost();
    await showSnap(api, "cap_1", "failed");
    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')?.click();
    });
    await advance(300);
    expect(api.calls("float-over:dismiss")).toEqual([{}]);
    expect(api.calls("float-over:tuck")).toEqual([]);
  });

  test("opening a saved failure outside the catalog keeps it available without retrying", async () => {
    const api = installHostApi({ settings: offlineSettings, enrichmentFor: endpointFailure });
    const el = await mountHost();
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: "cap_1" });
    expect(el.textContent).toContain("Could not reach the configured endpoint.");
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    expect(api.calls("float-over:dismiss")).toEqual([]);
    expect(api.calls("float-over:tuck")).toEqual([{}]);
    expect(api.calls("codex:enrich")).toEqual([]);
  });

  test("a retry that fails after opening a failed tab needs attention again", async () => {
    const api = installHostApi({ settings: offlineSettings });
    const el = await mountHost();
    await showSnap(api, "cap_1", "failed");
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    await press(el.querySelector(".fod-tab")!);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: "cap_1" });
    await push(api, EVENT_CHANNELS.aiRunUpdated, {
      enrichment: { ...enrichment("cap_1", "running"), latestRunId: "retry_1" }
    });
    await push(api, EVENT_CHANNELS.aiRunUpdated, {
      enrichment: { ...endpointFailure("cap_1"), latestRunId: "retry_1" }
    });
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    expect(api.calls("float-over:tuck")).toEqual([{}, {}]);
    expect(api.calls("float-over:dismiss")).toEqual([]);
  });

  test.each(["completed", "cancelled"] as const)("a %s run remains on the sidebar after timeout", async (status) => {
    const api = installHostApi({ settings: offlineSettings });
    const el = await mountHost();
    await showSnap(api, "cap_1", status);
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    expect(api.calls("float-over:dismiss")).toEqual([]);
    expect(api.calls("float-over:tuck")).toEqual([{}]);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    expect(el.querySelector(".fod-tab")?.getAttribute("data-status")).toBe(status === "completed" ? "ready" : "failed");
  });

  test.each(["off", "unavailable"])("the sidebar keeps a snap with AI %s without a waiting glyph", async (availability) => {
    const api = installHostApi({ settings: {
      ...offlineSettings,
      ai: { ...offlineSettings.ai, enabled: availability !== "off", customModels: [] }
    } });
    const el = await mountHost();
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: "cap_1", record: record("cap_1") });
    await advance(20_000);
    expect(api.calls("float-over:dismiss")).toEqual([]);
    expect(api.calls("float-over:tuck")).toEqual([{}]);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    expect(el.querySelectorAll(".fod-tab")).toHaveLength(1);
    expect(el.querySelector(".fod-st")).toBeNull();
    expect(el.querySelector(".fod-tab")?.getAttribute("aria-label")).not.toContain("waiting");
  });

  test("a failed run cannot leave a tab where dock placement is unavailable", async () => {
    const api = installHostApi({ settings: offlineSettings, dock: false });
    await mountHost();
    await showSnap(api, "cap_1", "failed");
    await advance(20_000);
    expect(api.calls("float-over:dismiss")).toEqual([{}]);
    expect(api.calls("float-over:tuck")).toEqual([]);
  });

  test("a recent snap with no queued run stops waiting when the first-run grace expires", async () => {
    vi.setSystemTime(new Date("2026-09-27T10:00:00.000Z"));
    const api = installHostApi({ library: [record("older", "2026-09-27T09:00:00.000Z")] });
    const el = await mountHost();
    await push(api, EVENT_CHANNELS.floatOverState, {
      kind: "show-loaded", captureId: "no_run", record: record("no_run")
    });
    expect(el.querySelector('[data-testid="float-over-rail"] b[title$="still with the model"]')?.textContent).toBe("1");
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    expect(el.querySelector(".fod-tab")?.getAttribute("data-status")).toBe("waiting");

    await advance(FIRST_RUN_GRACE_MS - DOCK_TUCK_COUNTDOWN_MS - 501);
    expect(el.querySelector(".fod-tab")?.getAttribute("data-status")).toBe("waiting");
    await advance(1);
    expect(el.querySelector(".fod-tab")?.getAttribute("data-status")).toBe("none");
    expect(api.calls("float-over:dismiss")).toEqual([]);

    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: "no_run" });
    expect(el.querySelector('[data-testid="float-over-rail"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="float-over-rail"] b[title$="still with the model"]')).toBeNull();
    expect(api.calls("codex:enrich")).toEqual([]);

    // A real run that arrives late still owns the status.
    await push(api, EVENT_CHANNELS.aiRunUpdated, { enrichment: enrichment("no_run", "running") });
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    expect(el.querySelector(".fod-tab")?.getAttribute("data-status")).toBe("reading");
  });

  test("Clear finished removes expired no-run snaps while keeping actual queued and running runs", async () => {
    vi.setSystemTime(new Date("2026-09-27T10:00:00.000Z"));
    const api = installHostApi({ overflowChoice: { kind: "clear-finished" } });
    const el = await mountHost();
    for (const id of ["no_run_1", "no_run_2", "no_run_3", "no_run_4"]) {
      await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: id, record: record(id) });
      await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-idle" });
    }
    await showSnap(api, "queued", "queued");
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-idle" });
    await showSnap(api, "running", "running");
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-idle" });
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    await advance(FIRST_RUN_GRACE_MS);

    await press(el.querySelector(".fod-more")!);
    expect(api.calls("float-over:overflowMenu").at(-1)).toMatchObject({ canClearFinished: true });
    expect(Array.from(el.querySelectorAll(".fod-tab"), (tab) => tab.getAttribute("data-status")))
      .toEqual(["reading", "waiting"]);
  });

  test("a snap still being read tucks to the dock, and opens from it", async () => {
    const api = installHostApi();
    const el = await mountHost();
    await showSnap(api, "cap_1", "running");

    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    expect(api.calls("float-over:tuck")).toEqual([{}]);
    expect(api.calls("float-over:dismiss")).toEqual([]);

    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    const dock = el.querySelector('[data-testid="float-over-dock"]');
    expect(dock).not.toBeNull();
    expect(el.querySelector(".fo")).toBeNull();
    const tabs = el.querySelectorAll(".fod-tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.getAttribute("data-status")).toBe("reading");
    expect(api.resize.mock.calls.at(-1)?.[0]).toMatchObject({ mode: "dock" });

    await press(tabs[0]!);
    expect(api.calls("float-over:open")).toEqual([{ captureId: "cap_1" }]);

    // Enter / Space on a focused tab: a click with no pointer before it.
    await act(async () => {
      tabs[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    });
    expect(api.calls("float-over:open")).toHaveLength(2);
    // A pointer click's own click event does not open it a second time.
    await act(async () => {
      tabs[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(api.calls("float-over:open")).toHaveLength(2);
  });

  test("a waiting tab follows its snap's enrichment, and stays once it is ready", async () => {
    const api = installHostApi();
    const el = await mountHost();
    await showSnap(api, "cap_1", "running");
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });

    await push(api, EVENT_CHANNELS.aiRunUpdated, { enrichment: enrichment("cap_1", "completed") });
    expect(el.querySelector(".fod-tab")?.getAttribute("data-status")).toBe("ready");
    // No ⋮ tab until there are more snaps than tabs: a finished snap
    // leaves by being opened, or by "Clear finished" in that list.
    expect(el.querySelector(".fod-more")).toBeNull();
    // Nothing on a tab counts time.
    expect(el.querySelector(".fod-tab")?.textContent).toBe("");
  });

  test("a new capture while the model reads shows the rail, and every close keeps the dock", async () => {
    const api = installHostApi();
    const el = await mountHost();
    await showSnap(api, "cap_1", "running");

    // The user takes another snap: the selector session starts.
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-idle" });
    expect(api.calls("float-over:tuck")).toEqual([{ markOnly: true }]);

    await showSnap(api, "cap_2", "running");
    const rail = el.querySelector('[data-testid="float-over-rail"]');
    expect(rail).not.toBeNull();
    const items = Array.from(el.querySelectorAll(".fo-rail__item"));
    expect(items.map((item) => item.classList.contains("is-current"))).toEqual([true, false]);
    expect(api.resize.mock.calls.at(-1)?.[0]).toMatchObject({ mode: "toast" });

    // X on the second toast: the first is still waiting, so the window
    // becomes the dock rather than going away.
    const dismiss = el.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    await act(async () => {
      dismiss?.click();
    });
    await advance(300);
    expect(api.calls("float-over:tuck").at(-1)).toEqual({});
    expect(api.calls("float-over:dismiss")).toEqual([]);

    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    // The dismissed snap is gone; the one still being read waits.
    expect(Array.from(el.querySelectorAll(".fod-tab")).map((tab) => tab.getAttribute("aria-label"))).toEqual([
      expect.stringContaining("Toaster snap")
    ]);
    expect(el.querySelectorAll(".fod-tab")).toHaveLength(1);
  });

  test("leaving the native window through the rail releases its countdown pause", async () => {
    const api = installHostApi();
    const el = await mountHost();
    await showSnap(api, "cap_1", "completed");
    await showSnap(api, "cap_2", "completed");

    const rail = el.querySelector('[data-testid="float-over-rail"]');
    const toast = el.querySelector(".fo");
    expect(rail).not.toBeNull();
    expect(toast?.classList.contains("is-paused")).toBe(false);

    await act(async () => {
      rail?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
      );
    });
    expect(toast?.classList.contains("is-paused")).toBe(true);

    // Windows can omit the rail's React mouseleave when the pointer crosses
    // directly out of the transparent BrowserWindow. The native window exit
    // still arrives as mouseout with no related target.
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
    });
    expect(toast?.classList.contains("is-paused")).toBe(false);

    await advance(8_000);
    expect(api.calls("float-over:tuck")).toEqual([{ markOnly: true }, {}]);
    expect(api.calls("float-over:dismiss")).toEqual([]);
  });

  test("the see-through area beside the rail lets clicks through, the rail and toast do not", async () => {
    const api = installHostApi();
    const el = await mountHost();
    await showSnap(api, "cap_1", "running");
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-idle" });
    await showSnap(api, "cap_2", "running");

    // The toast re-derives its own hover from the pointer on every move;
    // jsdom has no hit testing.
    document.elementFromPoint = () => null;
    const move = (target: Element): void => {
      target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    };
    move(el.querySelector(".fo-shell")!);
    move(el.querySelector(".fo-shell")!);
    move(el.querySelector(".fo-rail__item")!);
    move(el.querySelector(".fo-rail")!);
    move(el.querySelector(".fo")!);
    move(el.querySelector(".fo-host")!);
    // Only crossings are reported.
    expect(api.passThrough.mock.calls).toEqual([[true], [false], [true]]);
  });

  test("the rail opens another waiting snap", async () => {
    const api = installHostApi();
    const el = await mountHost();
    await showSnap(api, "cap_1", "running");
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-idle" });
    await showSnap(api, "cap_2", "running");

    const other = el.querySelector<HTMLButtonElement>(".fo-rail__item:not(.is-current)");
    await act(async () => {
      other?.click();
    });
    expect(api.calls("float-over:open")).toEqual([{ captureId: "cap_1" }]);

    // Main answers with the snap; the host already has its record, so no
    // "Loading capture…" flashes first.
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: "cap_1" });
    expect(el.querySelector('[data-state="loading"]')).toBeNull();
    expect(el.querySelector(".fo")).not.toBeNull();
    // cap_2 left the toast unread, so it now waits; the rail keeps both.
    expect(el.querySelectorAll(".fo-rail__item")).toHaveLength(2);
  });

  test("a finished snap stays when a new capture starts", async () => {
    const api = installHostApi();
    await mountHost();
    await showSnap(api, "cap_1", "completed");

    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-idle" });
    expect(api.calls("float-over:tuck")).toEqual([{ markOnly: true }]);

    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    expect(api.calls("float-over:dismiss")).toEqual([]);
  });

  test("where the dock is unavailable the toast holds the corner while the model reads", async () => {
    const api = installHostApi({ dock: false });
    await mountHost();
    await showSnap(api, "cap_1", "running");

    await advance(20_000);
    expect(api.calls("float-over:tuck")).toEqual([]);
    expect(api.calls("float-over:dismiss")).toEqual([]);
  });

  test("a waiting snap deleted in the Library leaves the dock", async () => {
    let deleted = false;
    const api = installHostApi({ byId: (id) => (deleted ? null : record(id)) });
    const el = await mountHost();
    await showSnap(api, "cap_1", "running");
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "left" });
    expect(el.querySelector(".fod--left")).not.toBeNull();

    deleted = true;
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["cap_1"] });
    expect(el.querySelectorAll(".fod-tab")).toHaveLength(0);
    expect(api.calls("float-over:dismiss")).toEqual([{}]);
  });

  test.each([
    ["AI off", null, null],
    ["AI off", null, "2026-09-27T10:00:01.000Z"],
    ["completed", "completed", null],
    ["completed", "completed", "2026-09-27T10:00:01.000Z"]
  ] as const)("deleting an active %s image (%s, tombstone %s) dismisses it before timeout", async (_label, status, deletedAt) => {
    const api = installHostApi({
      settings: status === null ? { ...settings, ai: { ...settings.ai, enabled: false } } : settings,
      byId: (id) => deletedAt === null ? null : { ...record(id), deleted_at: deletedAt }
    });
    const el = await mountHost();
    if (status === null) {
      await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: "cap_1", record: record("cap_1") });
    } else await showSnap(api, "cap_1", status);
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["cap_1"] });
    expect(api.calls("float-over:dismiss")).toEqual([{}]);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "dismiss" });
    await advance(20_000);
    expect(api.calls("float-over:tuck")).toEqual([]);
    expect(el.querySelector(".fod-tab")).toBeNull();
  });

  test("deleting the active image returns to other retained snaps without restoring the deleted one", async () => {
    const api = installHostApi({ byId: () => null });
    const el = await mountHost();
    await showSnap(api, "cap_1", "completed");
    await showSnap(api, "deleted", "completed");
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["deleted"] });
    expect(api.calls("float-over:tuck")).toEqual([{ markOnly: true }, {}]);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    expect(el.querySelectorAll(".fod-tab")).toHaveLength(1);
    await press(el.querySelector(".fod-tab")!);
    expect(api.calls("float-over:open")).toEqual([{ captureId: "cap_1" }]);
  });

  test("a deletion read finishing after timeout removes the image that just joined the dock", async () => {
    let resolveDeleted!: (value: CaptureRecord | null) => void;
    const api = installHostApi({ byId: () => new Promise<CaptureRecord | null>((resolve) => { resolveDeleted = resolve; }) });
    const el = await mountHost();
    await showSnap(api, "cap_1", "completed");
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["cap_1"] });
    expect(api.calls("library:byId")).toEqual([{ id: "cap_1" }]);
    await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    await act(async () => resolveDeleted(null));
    await flush();
    expect(el.querySelector(".fod-tab")).toBeNull();
    expect(api.calls("float-over:dismiss")).toEqual([{}]);
  });

  test.each(["toast", "dock"])("an older deletion read cannot remove a restored image from the %s", async (mode) => {
    let resolveDeleted!: (value: CaptureRecord | null) => void;
    let reads = 0;
    const api = installHostApi({ byId: (id) => ++reads === 1
      ? new Promise<CaptureRecord | null>((resolve) => { resolveDeleted = resolve; })
      : record(id) });
    const el = await mountHost();
    await showSnap(api, "cap_1", "completed");
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["cap_1"] });
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["cap_1"] });
    expect(api.calls("library:byId")).toHaveLength(2);
    if (mode === "dock") {
      await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
      await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    }
    await act(async () => resolveDeleted(null));
    await flush();
    expect(api.calls("float-over:dismiss")).toEqual([]);
    if (mode === "toast") {
      await advance(DOCK_TUCK_COUNTDOWN_MS + 500);
      await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    }
    expect(el.querySelector(".fod-tab")?.getAttribute("data-status")).toBe("ready");
  });

  test("snaps past three fold into the overflow menu", async () => {
    const api = installHostApi();
    const el = await mountHost();
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await showSnap(api, id, "running");
      await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-idle" });
    }
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "tucked", side: "right" });
    expect(el.querySelectorAll(".fod-tab")).toHaveLength(3);

    const more = el.querySelector(".fod-more");
    expect(more?.textContent).toContain("+1");
    await press(more!);
    expect(api.calls("float-over:overflowMenu")).toEqual([
      {
        items: [{ captureId: "s1", label: expect.stringContaining("reading") }],
        canClearFinished: false
      }
    ]);
  });
});

describe("FloatOverHost rail: the recent-snaps catalog", () => {
  const railIds = (el: HTMLElement): string[] =>
    Array.from(el.querySelectorAll(".fo-rail__item")).map(
      (item) => item.getAttribute("aria-label") ?? ""
    );

  test("a narrow work area omits the recent rail", async () => {
    const original = Object.getOwnPropertyDescriptor(window.screen, "availWidth");
    Object.defineProperty(window.screen, "availWidth", { configurable: true, value: 526 });
    try {
      const api = installHostApi({
        library: [record("toast_old", "2026-09-27T09:00:00.000Z")]
      });
      const el = await mountHost();
      await showSnap(api, "cap_new", "completed");
      expect(el.querySelectorAll(".fo-rail__item")).toHaveLength(0);
      expect(el.querySelector('[data-testid="float-over-rail"]')).toBeNull();
    } finally {
      if (original === undefined) {
        delete (window.screen as unknown as Record<string, unknown>).availWidth;
      } else {
        Object.defineProperty(window.screen, "availWidth", original);
      }
    }
  });

  test("lists every recent snap, newest first, not only the waiting ones", async () => {
    const api = installHostApi({
      library: [record("toast_old", "2026-09-27T09:00:00.000Z"), record("jam_mid", "2026-09-27T09:30:00.000Z")]
    });
    const el = await mountHost();
    await showSnap(api, "cap_new", "completed");

    const items = Array.from(el.querySelectorAll(".fo-rail__item"));
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.classList.contains("is-current"))).toEqual([true, false, false]);
    // Nothing is waiting on the model, so no glyphs and no count.
    expect(el.querySelectorAll(".fo-rail__item .fod-st")).toHaveLength(0);
    expect(el.querySelector(".fo-rail__eb b")).toBeNull();
  });

  test("opening an older snap removes nothing and reorders nothing", async () => {
    const api = installHostApi({
      library: [record("toast_old", "2026-09-27T09:00:00.000Z"), record("jam_mid", "2026-09-27T09:30:00.000Z")]
    });
    const el = await mountHost();
    await showSnap(api, "cap_new", "completed");
    const order = (): string[] =>
      Array.from(el.querySelectorAll(".fo-rail__item")).map(
        (item) => item.getAttribute("data-capture-id") ?? ""
      );
    expect(order()).toEqual(["cap_new", "jam_mid", "toast_old"]);

    for (const target of ["toast_old", "jam_mid", "cap_new"]) {
      await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: target });
      // The catalog already has the record: no "Loading capture…" first.
      expect(el.querySelector('[data-state="loading"]')).toBeNull();
      expect(order()).toEqual(["cap_new", "jam_mid", "toast_old"]);
      expect(el.querySelector(".fo-rail__item.is-current")?.getAttribute("data-capture-id")).toBe(target);
      expect(railIds(el).filter((label) => label.startsWith("Showing"))).toHaveLength(1);
    }
    expect(api.calls("library:byId")).toEqual([]);
  });

  test("the toast header and every thumb count from the capture", async () => {
    vi.setSystemTime(new Date("2026-09-27T10:03:23.000Z"));
    const api = installHostApi({ library: [record("toast_old", "2026-09-27T08:59:00.000Z")] });
    const el = await mountHost();
    await showSnap(api, "cap_new", "completed");

    expect(el.querySelector(".fo__hdr-sub")?.textContent).toContain("3m 23s ago");
    expect(
      Array.from(el.querySelectorAll(".fo-rail__age")).map((age) => age.textContent)
    ).toEqual(["3m 23s", "1h 4m"]);

    await advance(1_000);
    expect(el.querySelector(".fo__hdr-sub")?.textContent).toContain("3m 24s ago");
    expect(el.querySelector(".fo-rail__age")?.textContent).toBe("3m 24s");
  });

  test("an older snap with no run stays in the sidebar without a waiting glyph", async () => {
    vi.setSystemTime(new Date("2026-09-27T10:00:05.000Z"));
    const api = installHostApi({ library: [record("toast_old", "2026-09-26T09:00:00.000Z")] });
    const el = await mountHost();
    await showSnap(api, "cap_new", "completed");

    // Opened from the rail: no enrichment row, and none is coming.
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: "toast_old" });
    expect(el.querySelector('.fo-rail__item.is-current .fod-st')).toBeNull();
    await push(api, EVENT_CHANNELS.floatOverState, { kind: "show-loaded", captureId: "cap_new" });
    expect(api.calls("float-over:tuck")).toEqual([{ markOnly: true }, { markOnly: true }]);
    expect(el.querySelector('.fo-rail__item:not(.is-current) .fod-st')).toBeNull();
  });

  test("scrolling near the end loads the next page", async () => {
    const library = ["a", "b", "c", "d", "e"].map((id, index) =>
      record(`snap_${id}`, `2026-09-27T0${index + 1}:00:00.000Z`)
    );
    const api = installHostApi({ library, pageSize: 2 });
    const el = await mountHost();
    await showSnap(api, "cap_new", "completed");
    // jsdom lays nothing out, so every page reads as "near the end" and
    // the next one follows until the library is exhausted.
    const list = el.querySelector(".fo-rail__list")!;
    await act(async () => {
      list.dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(el.querySelectorAll(".fo-rail__item")).toHaveLength(6);
    const cursors = api.calls("library:list").map((req) => (req as { cursor?: unknown }).cursor);
    expect(cursors[0]).toBeUndefined();
    expect(cursors.slice(1).every((cursor) => cursor !== undefined)).toBe(true);
  });

  test("a snap deleted elsewhere leaves the rail, and a new one joins it", async () => {
    const api = installHostApi({ library: [record("toast_old", "2026-09-27T09:00:00.000Z")] });
    const el = await mountHost();
    await showSnap(api, "cap_new", "completed");
    expect(el.querySelectorAll(".fo-rail__item")).toHaveLength(2);

    api.library.push(record("waffle_newer", "2026-09-27T10:30:00.000Z"));
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["waffle_newer"] });
    expect(el.querySelectorAll(".fo-rail__item")).toHaveLength(3);

    api.library.splice(api.library.findIndex((row) => row.id === "toast_old"), 1);
    await push(api, EVENT_CHANNELS.capturesChanged, { changedIds: ["toast_old"] });
    expect(el.querySelectorAll(".fo-rail__item")).toHaveLength(2);
  });
});
