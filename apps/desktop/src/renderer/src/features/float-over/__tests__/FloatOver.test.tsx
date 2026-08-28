import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type CaptureEnrichment, type CaptureRecord, type Settings } from "@pwrsnap/shared";
import { FloatOver, type FloatOverAsset } from "../FloatOver";
import { FloatOverHost } from "../FloatOverHost";

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

function enrichment(patch: Partial<CaptureEnrichment> = {}): CaptureEnrichment {
  return {
    captureId: "cap_1",
    latestRunId: "run_1",
    status: "completed",
    error: null,
    ocrText: "LINE",
    suggestedTitle: null,
    acceptedTitle: null,
    titleAcceptedAt: null,
    suggestedFilenameStem: null,
    acceptedFilenameStem: null,
    filenameAcceptedAt: null,
    suggestedDescription: "Dark-mode LINE desktop chat showing PwrAgent command help.",
    acceptedDescription: null,
    descriptionAcceptedAt: null,
    suggestedTags: [
      { id: "tag_1", label: "line", confidence: 0.91, accepted_at: null, rejected_at: null },
      { id: "tag_2", label: "chat", confidence: 0.84, accepted_at: null, rejected_at: null }
    ],
    acceptedTags: [],
    ...patch
  };
}

const baseSettings: Settings = {
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
  general: {
    developerMode: false,
    hotCpuProfilingEnabled: false,
    hotCpuProfilingStartDelayMs: 0,
    hotCpuProfilingTriggerMode: "sustained",
    hotCpuProfilingSlowburnThresholdPercent: 15,
    hotCpuProfilingCaptureHeapSnapshot: false,
    hotCpuProfilingHeapSnapshotLimit: 2,
    launchAtLogin: false
  },
  experimental: { processSplit: true, dpiAwareExport: false, allowRetinaExport: true },
  appearance: { theme: "system" },
  updates: { channel: "latest", train: "stable" },
  storage: { filenameTimestampZone: "local", capturesLocation: "documents" },
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
      arrow: { color: "accent", thickness: "auto", endStyle: "filled-triangle", stemStyle: "solid", doubleEnded: false, outline: "auto" },
      text: { color: "accent", fontSize: "auto", weight: "regular", outline: "auto" },
      shape: { color: "accent", thickness: "auto", filled: false, shape: "rect", skewDeg: 15, outline: "auto" },
      blur: { mode: "gaussian", radius: { mode: "auto" } },
      highlight: { color: "yellow", opacity: 0.3, blend: "multiply" }
    },
    coachmarks: { stoplightSeen: false },
    matchingText: { enabled: true },
    sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
  },
  library: { detailRail: { pinned: true, lastSelectedTab: "info" }, gridCopyPalette: { anchor: "follow" }, confirmBeforeTrash: true, gridZoom: 180 },
  localAgents: { enabled: false, grants: [], roles: [], audit: [] }
};

const imageRecord: CaptureRecord = {
  id: "cap_1",
  kind: "image",
  captured_at: "2026-05-15T18:24:00.000Z",
  legacy_src_path: "/tmp/cap_1.png",
  bundle_path: null,
  flat_png_path: null,
  bundle_modified_at: null,
  bundle_format_version: 1,
  bundle_edits_version: 0,
  width_px: 1200,
  height_px: 800,
  device_pixel_ratio: 2,
  byte_size: 1000,
  sha256: "sha_cap_1",
  source_app_bundle_id: "com.example.App",
  source_app_name: "Example",
  edits_version: 0,
  has_alpha: false,
  deleted_at: null,
  video: null
};

// The host's mount probe dispatches `settings:refreshCodexDiscovery` and feeds
// the result straight to `codexAvailableInSnapshot`, which dereferences
// `resolvedPath`. Tests that replace the dispatch mock must return a
// well-formed snapshot for that verb or the probe throws an unhandled rejection.
const codexSnapshotResult = {
  ok: true,
  value: {
    candidates: [{ path: "codex", source: "path", version: "1.0.0", available: true }],
    resolvedPath: "codex",
    auth: {
      status: "authenticated",
      testedAt: "2026-05-19T12:00:00.000Z",
      durationMs: 12,
      detail: "Logged in using ChatGPT"
    },
    refreshedAt: "2026-05-19T12:00:00.000Z"
  }
};

type EventHandler = (payload: unknown) => void;

function installHostApi(): {
  pushEvent: (channel: string, payload: unknown) => void;
} {
  const subscribers = new Map<string, Set<EventHandler>>();
  window.pwrsnapApi = {
    dispatch: vi.fn(async (name: string) => {
      if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
      if (name === "settings:refreshCodexDiscovery") {
        return {
          ok: true,
          value: {
            candidates: [{ path: "codex", source: "path", version: "1.0.0", available: true }],
            resolvedPath: "codex",
            auth: {
              status: "authenticated",
              testedAt: "2026-05-19T12:00:00.000Z",
              durationMs: 12,
              detail: "Logged in using ChatGPT"
            },
            refreshedAt: "2026-05-19T12:00:00.000Z"
          }
        };
      }
      return { ok: true, value: undefined };
    }),
    on: (channel: string, handler: EventHandler) => {
      const set = subscribers.get(channel) ?? new Set<EventHandler>();
      set.add(handler);
      subscribers.set(channel, set);
      return () => {
        set.delete(handler);
      };
    },
    requestFloatOverResize: vi.fn(),
    startCaptureDrag: vi.fn()
  } as unknown as NonNullable<Window["pwrsnapApi"]>;

  return {
    pushEvent(channel, payload) {
      for (const handler of subscribers.get(channel) ?? []) {
        handler(payload);
      }
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function defaultHostDispatchResult(name: string): unknown {
  if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
  if (name === "settings:read") return { ok: true, value: baseSettings };
  if (name === "settings:refreshCodexDiscovery") return codexSnapshotResult;
  return { ok: true, value: undefined };
}

async function renderHostRecord(
  api: ReturnType<typeof installHostApi>,
  record: CaptureRecord = imageRecord
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(FloatOverHost));
  });
  await act(async () => {
    api.pushEvent(EVENT_CHANNELS.floatOverState, {
      kind: "show-loaded",
      captureId: record.id,
      record
    });
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function enterTag(input: HTMLInputElement, label: string, repeatEnter = false): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, label);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  if (repeatEnter) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
}

async function renderFloatOver(props: Parameters<typeof FloatOver>[0]): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(FloatOver, props));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

async function renderToast(asset: FloatOverAsset): Promise<HTMLDivElement> {
  return renderFloatOver({
    asset,
    src: asset.src,
    srcW: 1920,
    srcH: 1080,
    srcBytes: 1024,
    startCountdown: false
  });
}

async function unmount(): Promise<void> {
  if (root !== null) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  container = null;
  root = null;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  await unmount();
});

describe("FloatOver asset mode", () => {
  beforeEach(() => {
    // The 6-card export grid (`VideoExportPresetsPanel`) fires
    // `video:presetMetrics` on mount. Stub it so the renderer doesn't
    // hit an undefined `window.pwrsnapApi`. The hook also dispatches
    // `clipboard:copyVideoFile` / `copyVideoPath` / `video:export`
    // on click but those don't fire in the no-interaction tests.
    window.pwrsnapApi = {
      dispatch: vi.fn(async (name: string) => {
        if (name === "video:presetMetrics") return { ok: true, value: { metrics: [] } };
        return { ok: true, value: { path: "/tmp/out.mp4" } };
      }),
      on: () => () => undefined,
      requestFloatOverResize: vi.fn(),
      startCaptureDrag: vi.fn(),
      startVideoDrag: vi.fn()
    } as unknown as NonNullable<Window["pwrsnapApi"]>;
  });

  test("video asset renders <video> in fo__preview, the mini-trim strip, and the 6-card export grid", async () => {
    const el = await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/abc",
      captureId: "abc",
      durationSec: 12.5,
      widthPx: 1920,
      heightPx: 1080,
      defaultRange: { start: 0, end: 12.5 }
    });

    const preview = el.querySelector(".fo__preview");
    expect(preview?.querySelector("video")).not.toBeNull();
    expect(preview?.querySelector("img")).toBeNull();
    expect(preview?.querySelector("video")?.getAttribute("src")).toBe("pwrsnap-capture://r/abc");

    expect(el.querySelector(".fo__hdr-title")?.textContent).toBe("Recording saved");
    expect(el.querySelector(".fo__hdr-sub")?.textContent).toContain("12.5s");

    // Mini-trim strip: compact timeline with in/out handles and the
    // Full-clip chip (disabled while the range is the whole clip).
    const trim = el.querySelector('[data-testid="video-timeline-compact"]');
    expect(trim).not.toBeNull();
    expect(trim?.querySelector('[data-testid="video-timeline-in"]')).not.toBeNull();
    expect(trim?.querySelector('[data-testid="video-timeline-out"]')).not.toBeNull();
    expect(trim?.querySelector('[data-testid="video-timeline-playhead"]')).toBeNull();
    expect(
      (trim?.querySelector('[data-testid="video-timeline-full-clip"]') as HTMLButtonElement | null)
        ?.disabled
    ).toBe(true);
    expect(trim?.querySelector('[data-testid="video-timeline-trim-label"]')?.textContent).toBe(
      "FULL CLIP · 0:12.5"
    );

    // Two format groups (GIF + MP4) with three cards each → 6 buttons.
    const groups = el.querySelectorAll(".psl__copy-row-group");
    expect(groups.length).toBe(2);
    const buttons = el.querySelectorAll(".fo__export-grid button.fo__copy-btn");
    expect(buttons.length).toBe(6);
    // Cards label "Low / Med / High" within each group; the format
    // header ("GIF" / "MP4") lives in the format eyebrow.
    const eyebrows = el.querySelectorAll(".psl__copy-format-eyebrow span:first-child");
    expect(Array.from(eyebrows).map((n) => n.textContent)).toEqual(["GIF", "MP4"]);
    const labels = Array.from(buttons).map(
      (b) => b.querySelector(".fo__copy-label")?.textContent
    );
    expect(labels).toEqual(["Low", "Med", "High", "Low", "Med", "High"]);
  });

  test("image asset (default) keeps the existing <img> + Low/Med/High copy row", async () => {
    const el = await renderToast({
      kind: "image",
      src: "pwrsnap-capture://r/img"
    });
    expect(el.querySelector(".fo__preview img")).not.toBeNull();
    expect(el.querySelector(".fo__preview video")).toBeNull();
    expect(el.querySelectorAll(".fo__copy > *").length).toBe(3);
    expect(el.querySelector(".fo__hdr-title")?.textContent).toBe("Snap captured");
  });

  // Regression: issue #77 / R12 — "auto-dismiss must continue to pause
  // while the scrubber is being interacted with".
  //
  // `VideoTimeline.beginDrag` takes pointer capture, so a trim drag
  // keeps running after the pointer leaves the toast — and with a 40 px
  // strip inside a 360 px toast, leaving is the normal case. The toast
  // drove its pause state purely off `onMouseEnter` / `onMouseLeave`,
  // so `mouseleave` dropped `hovering`, the compact variant's 4000 ms
  // countdown resumed, and the toast closed mid-drag, discarding the
  // in-progress trim.
  test("a trim-handle drag keeps the toast open after the pointer leaves it", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"]
    });
    const onDismiss = vi.fn();
    const el = await renderFloatOver({
      // compact: autoMs = 4000, and no annotate / AI rows to pause on.
      variant: "compact",
      asset: {
        kind: "video",
        src: "pwrsnap-capture://r/abc",
        captureId: "abc",
        durationSec: 12.5,
        widthPx: 1920,
        heightPx: 1080,
        defaultRange: { start: 0, end: 12.5 }
      },
      src: "pwrsnap-capture://r/abc",
      startCountdown: true,
      onDismiss
    });

    const fo = el.querySelector(".fo")!;
    const strip = el.querySelector(".vtl__strip")!;
    const inHandle = el.querySelector('[data-testid="video-timeline-in"]')!;

    // Baseline: nothing is holding the countdown.
    expect(fo.classList.contains("is-paused")).toBe(false);

    // Pointer enters the toast, then presses the in-handle.
    await act(async () => {
      fo.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
      );
    });
    await act(async () => {
      inHandle.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 10,
          button: 0
        })
      );
    });
    expect(fo.classList.contains("is-paused")).toBe(true);

    // Pointer is dragged off the toast. Pointer capture keeps the drag
    // alive, but `mouseleave` fires and hover state drops — this is the
    // exact moment the countdown used to restart.
    await act(async () => {
      fo.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })
      );
      window.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null, bubbles: true }));
    });
    expect(fo.classList.contains("is-paused")).toBe(true);

    // Well past the compact variant's 4000 ms window plus the 220 ms
    // exit animation: the toast must still be here, mid-drag.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(fo.classList.contains("is-exiting")).toBe(false);
    expect(el.querySelector('[data-testid="video-timeline-compact"]')).not.toBeNull();

    // Release: the hold lifts and the countdown resumes. This half also
    // proves the advance above would have dismissed an unheld toast.
    await act(async () => {
      strip.dispatchEvent(
        new MouseEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 10,
          button: 0
        })
      );
    });
    expect(fo.classList.contains("is-paused")).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(fo.classList.contains("is-exiting")).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // The toast's preview <video> doubles as the trim strip's scrub
  // monitor. Without this wiring you pick trim points off a 40 px
  // filmstrip blind — the preview just sits on frame 0 no matter where
  // the handles go, which makes the trim UI useless.
  test("dragging a trim handle parks the preview video on that frame", async () => {
    // jsdom has no layout; pin the strip to 800 px so px↔sec math runs.
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 80,
      width: 800,
      height: 80,
      toJSON: () => ({})
    } as DOMRect);
    try {
      const el = await renderToast({
        kind: "video",
        src: "pwrsnap-capture://r/abc",
        captureId: "abc",
        durationSec: 12.5,
        widthPx: 1920,
        heightPx: 1080,
        defaultRange: { start: 0, end: 12.5 }
      });

      const video = el.querySelector<HTMLVideoElement>(".fo__preview video")!;
      const strip = el.querySelector(".vtl__strip")!;
      const outHandle = el.querySelector('[data-testid="video-timeline-out"]')!;
      expect(video.currentTime).toBe(0);

      const at = (type: string, clientX: number): MouseEvent =>
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10, button: 0 });

      // 800 px ↔ 12.5 s. Grab the out handle and drag it to the middle.
      await act(async () => {
        outHandle.dispatchEvent(at("pointerdown", 800));
      });
      await act(async () => {
        strip.dispatchEvent(at("pointermove", 400));
      });
      expect(video.currentTime).toBe(6.25);

      // Still tracking on release, and the range agrees with the frame.
      await act(async () => {
        strip.dispatchEvent(at("pointerup", 320));
      });
      expect(video.currentTime).toBe(5);
      expect(el.querySelector('[data-testid="video-timeline-trim-label"]')?.textContent).toBe(
        "TRIM 0:00.0 – 0:05.0 · 5 s"
      );
    } finally {
      rect.mockRestore();
    }
  });

  test("labels the sticky home fallback as the saved destination", async () => {
    const el = await renderFloatOver({
      src: "pwrsnap-capture://r/img",
      capturesLocation: "home",
      startCountdown: false
    });

    expect(el.querySelector(".fo__dest-saved")?.textContent).toContain("saved · ~/PwrSnap");
    expect(el.querySelector(".fo__dest-saved")?.textContent).not.toContain("Documents");
  });

  test("does not invent a display path for a PWRSNAP_DATA_ROOT override", async () => {
    const el = await renderFloatOver({
      src: "pwrsnap-capture://r/img",
      capturesLocation: "documents",
      capturesRootOverridden: true,
      startCountdown: false
    });

    expect(el.querySelector(".fo__dest-saved")?.textContent).toContain(
      "saved · your active captures folder"
    );
    expect(el.querySelector(".fo__dest-saved")?.textContent).not.toContain(
      "Documents"
    );
  });
});

describe("FloatOverHost", () => {
  test("reads settings from settings-change event payload", async () => {
    const api = installHostApi();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(FloatOverHost));
    });
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.floatOverState, {
        kind: "show-loaded",
        captureId: imageRecord.id,
        record: imageRecord
      });
    });
    expect(container.textContent).toContain("Enable AI to read");

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.settingsChanged, {
        settings: {
          ...baseSettings,
          ai: {
            ...baseSettings.ai,
            enabled: true,
            consentAcceptedAt: "2026-05-19T12:00:00.000Z"
          }
        },
        secrets: {}
      });
    });

    expect(container.textContent).toContain("Codex has no suggestion yet");
    expect(container.textContent).not.toContain("Enable AI to read");
  });

  test("status pill names the configured enrichment provider (Gemini, not Codex)", async () => {
    const api = installHostApi();
    // The fast show-loaded-with-record path must still fetch settings so the
    // pill can name the provider. Return an acp:gemini enrichment default.
    const geminiSettings: Settings = {
      ...baseSettings,
      ai: {
        ...baseSettings.ai,
        enabled: true,
        consentAcceptedAt: "2026-05-19T12:00:00.000Z",
        defaults: {
          ...baseSettings.ai.defaults,
          enrichment: { provider: "acp:gemini" }
        }
      }
    };
    (window.pwrsnapApi!.dispatch as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string) => {
        if (name === "settings:read") return { ok: true, value: geminiSettings };
        if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
        if (name === "settings:refreshCodexDiscovery") {
          return {
            ok: true,
            value: {
              candidates: [{ path: "codex", source: "path", version: "1.0.0", available: true }],
              resolvedPath: "codex",
              auth: {
                status: "authenticated",
                testedAt: "2026-05-19T12:00:00.000Z",
                durationMs: 12,
                detail: "Logged in using ChatGPT"
              },
              refreshedAt: "2026-05-19T12:00:00.000Z"
            }
          };
        }
        return { ok: true, value: undefined };
      }
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(FloatOverHost));
    });
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.floatOverState, {
        kind: "show-loaded",
        captureId: imageRecord.id,
        record: imageRecord
      });
    });
    // Let the on-load settings:read resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.aiRunUpdated, {
        enrichment: {
          captureId: imageRecord.id,
          latestRunId: "run_g",
          status: "running",
          ocrText: null,
          suggestedTitle: null,
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
        }
      });
    });

    expect(container.textContent).toContain("Gemini is reading the snap");
    expect(container.textContent).not.toContain("Codex is reading the snap");
  });

  // Glue for `isEnrichmentProviderAvailable`: the host probes `acp:discover`
  // (real `--version` spawns, no handler cache) ONLY when an ACP agent is the
  // enrichment backend — never for Codex users. The Library footer uses the
  // identical machinery, so this gating is exercised once here.
  test("probes acp:discover when an ACP agent is the enrichment backend", async () => {
    const api = installHostApi();
    const dispatchMock = window.pwrsnapApi!.dispatch as ReturnType<typeof vi.fn>;
    const acpSettings: Settings = {
      ...baseSettings,
      ai: {
        ...baseSettings.ai,
        defaults: { ...baseSettings.ai.defaults, enrichment: { provider: "acp:gemini" } }
      }
    };
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "settings:read") return { ok: true, value: acpSettings };
      if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
      if (name === "settings:refreshCodexDiscovery") return codexSnapshotResult;
      if (name === "acp:discover") {
        return {
          ok: true,
          value: {
            agents: [
              { id: "gemini", displayName: "Gemini CLI", installed: true, instances: [] }
            ]
          }
        };
      }
      return { ok: true, value: undefined };
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(FloatOverHost));
    });
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.floatOverState, {
        kind: "show-loaded",
        captureId: imageRecord.id,
        record: imageRecord
      });
    });
    // Let settings:read resolve so the provider selector reads "acp:gemini".
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatchMock.mock.calls.some((c) => c[0] === "acp:discover")).toBe(true);
  });

  test("does not probe acp:discover for the Codex enrichment backend", async () => {
    const api = installHostApi();
    const dispatchMock = window.pwrsnapApi!.dispatch as ReturnType<typeof vi.fn>;
    // baseSettings leaves `enrichment` empty → provider "" → Codex backend.
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "settings:read") return { ok: true, value: baseSettings };
      if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
      if (name === "settings:refreshCodexDiscovery") return codexSnapshotResult;
      return { ok: true, value: undefined };
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(FloatOverHost));
    });
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.floatOverState, {
        kind: "show-loaded",
        captureId: imageRecord.id,
        record: imageRecord
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatchMock.mock.calls.some((c) => c[0] === "acp:discover")).toBe(false);
  });

  // Regression: bug v — the ⌘1/⌘2/⌘3 keydown listener must keep
  // dispatching `clipboard:copy` with the correct captureId after
  // enrichment IPC arrives. Previously the listener's effect was
  // keyed on `[state]`, so each enrichment update detached + re-
  // attached the window listener; if the keystroke landed mid-
  // detach (or main batched the update), the dispatch was lost or
  // pointed at stale closure data.
  test("⌘1 keeps dispatching clipboard:copy after enrichment updates arrive", async () => {
    const api = installHostApi();
    const dispatchMock = window.pwrsnapApi!.dispatch as ReturnType<typeof vi.fn>;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(FloatOverHost));
    });
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.floatOverState, {
        kind: "show-loaded",
        captureId: imageRecord.id,
        record: imageRecord
      });
    });

    // Simulate the Codex enrichment broadcast train: queued → running
    // → completed, each one a separate IPC. Pre-fix this caused the
    // keydown listener to be torn down + re-built three times.
    for (const status of ["queued", "running", "completed"] as const) {
      await act(async () => {
        api.pushEvent(EVENT_CHANNELS.aiRunUpdated, {
          enrichment: {
            captureId: imageRecord.id,
            latestRunId: "run_1",
            status,
            ocrText: null,
            suggestedTitle: null,
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
          }
        });
      });
    }

    dispatchMock.mockClear();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true })
      );
    });

    const clipboardCalls = dispatchMock.mock.calls.filter(
      ([name]) => name === "clipboard:copy"
    );
    expect(clipboardCalls.length).toBe(1);
    expect(clipboardCalls[0]?.[1]).toEqual({ captureId: imageRecord.id, preset: "low" });
  });
});

describe("FloatOverHost manual tag persistence", () => {
  test("add is optimistic, single-flight, and reconciles to the returned canonical tags", async () => {
    const api = installHostApi();
    const dispatchMock = window.pwrsnapApi!.dispatch as ReturnType<typeof vi.fn>;
    const success = {
      ok: true as const,
      value: enrichment({
        acceptedTags: ["external", "Canonical Tag"],
        suggestedTags: []
      })
    };
    const pending = deferred<typeof success>();
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:addTag") return pending.promise;
      return defaultHostDispatchResult(name);
    });
    const el = await renderHostRecord(api);
    const input = el.querySelector<HTMLInputElement>(".fo__tag-input");
    expect(input).not.toBeNull();

    await act(async () => {
      enterTag(input!, "  Canonical Tag  ", true);
      await Promise.resolve();
    });

    const addCalls = dispatchMock.mock.calls.filter(([name]) => name === "library:addTag");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]?.[1]).toEqual({ captureId: "cap_1", label: "Canonical Tag" });
    expect(el.querySelector(".fo__tags")?.getAttribute("aria-busy")).toBe("true");
    expect(el.textContent).toContain("Canonical Tag");

    // A full enrichment snapshot may arrive before the command Result.
    // Keep the in-flight optimistic tag overlaid on that newer truth.
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.aiRunUpdated, {
        enrichment: enrichment({ acceptedTags: ["external"], suggestedTags: [] })
      });
    });
    expect(el.textContent).toContain("external");
    expect(el.textContent).toContain("Canonical Tag");
    const bulkAccept = el.querySelector<HTMLButtonElement>(".fo__ai-accept");
    expect(bulkAccept?.textContent).toMatch(/Save|Use/);
    expect(bulkAccept?.disabled).toBe(true);
    bulkAccept?.click();
    expect(
      dispatchMock.mock.calls.filter(([name]) => name === "codex:acceptTag")
    ).toHaveLength(0);

    await act(async () => {
      pending.resolve(success);
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.querySelector(".fo__tags")?.getAttribute("aria-busy")).toBe("false");
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain("external");
    expect(el.textContent).toContain("Canonical Tag");

    // Server and renderer normalize case + repeated whitespace the same
    // way, so re-entering the persisted tag never issues a duplicate IPC.
    await act(async () => {
      enterTag(input!, "canonical   tag");
      await Promise.resolve();
    });
    expect(dispatchMock.mock.calls.filter(([name]) => name === "library:addTag")).toHaveLength(1);
  });

  test("add Result failure rolls back and Retry persists the same label", async () => {
    const api = installHostApi();
    const dispatchMock = window.pwrsnapApi!.dispatch as ReturnType<typeof vi.fn>;
    const failed = {
      ok: false as const,
      error: {
        kind: "persistence" as const,
        code: "db_busy",
        message: "The library is busy"
      }
    };
    const pending = deferred<typeof failed>();
    const retried = {
      ok: true as const,
      value: enrichment({ acceptedTags: ["triage"], suggestedTags: [] })
    };
    let addAttempt = 0;
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:addTag") {
        addAttempt += 1;
        return addAttempt === 1 ? pending.promise : retried;
      }
      return defaultHostDispatchResult(name);
    });
    const el = await renderHostRecord(api);
    const input = el.querySelector<HTMLInputElement>(".fo__tag-input");

    await act(async () => {
      enterTag(input!, "triage");
      await Promise.resolve();
    });
    expect(el.textContent).toContain("triage");

    await act(async () => {
      pending.resolve(failed);
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t add “triage”: The library is busy");
    expect(
      Array.from(el.querySelectorAll(".fo__tag")).some((tag) =>
        tag.textContent?.includes("triage")
      )
    ).toBe(false);

    await act(async () => {
      el.querySelector<HTMLButtonElement>(".fo__tag-retry")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatchMock.mock.calls.filter(([name]) => name === "library:addTag")).toHaveLength(2);
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain("triage");
  });

  test("remove is optimistic, single-flight, and stays removed after success", async () => {
    const api = installHostApi();
    const dispatchMock = window.pwrsnapApi!.dispatch as ReturnType<typeof vi.fn>;
    const success = {
      ok: true as const,
      value: enrichment({ acceptedTags: ["chat"], suggestedTags: [] })
    };
    const pending = deferred<typeof success>();
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:removeTag") return pending.promise;
      return defaultHostDispatchResult(name);
    });
    const el = await renderHostRecord(api);
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.aiRunUpdated, {
        enrichment: enrichment({ acceptedTags: ["chat", "triage"], suggestedTags: [] })
      });
    });
    const remove = el.querySelector<HTMLButtonElement>('[aria-label="remove triage"]');
    expect(remove).not.toBeNull();

    await act(async () => {
      remove?.click();
      remove?.click();
      await Promise.resolve();
    });

    const removeCalls = dispatchMock.mock.calls.filter(
      ([name]) => name === "library:removeTag"
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]?.[1]).toEqual({ captureId: "cap_1", label: "triage" });
    expect(el.querySelector('[aria-label="remove triage"]')).toBeNull();

    await act(async () => {
      pending.resolve(success);
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.querySelector('[aria-label="remove triage"]')).toBeNull();
    expect(el.querySelector('[aria-label="remove chat"]')).not.toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  test("remove Result failure restores the chip and Retry removes it", async () => {
    const api = installHostApi();
    const dispatchMock = window.pwrsnapApi!.dispatch as ReturnType<typeof vi.fn>;
    const failed = {
      ok: false as const,
      error: {
        kind: "persistence" as const,
        code: "db_busy",
        message: "The library is busy"
      }
    };
    const pending = deferred<typeof failed>();
    const retried = {
      ok: true as const,
      value: enrichment({ acceptedTags: ["chat"], suggestedTags: [] })
    };
    let removeAttempt = 0;
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:removeTag") {
        removeAttempt += 1;
        return removeAttempt === 1 ? pending.promise : retried;
      }
      return defaultHostDispatchResult(name);
    });
    const el = await renderHostRecord(api);
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.aiRunUpdated, {
        enrichment: enrichment({ acceptedTags: ["chat", "triage"], suggestedTags: [] })
      });
    });

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[aria-label="remove triage"]')?.click();
      await Promise.resolve();
    });
    expect(el.querySelector('[aria-label="remove triage"]')).toBeNull();

    await act(async () => {
      pending.resolve(failed);
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.querySelector('[aria-label="remove triage"]')).not.toBeNull();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t remove “triage”: The library is busy"
    );

    await act(async () => {
      el.querySelector<HTMLButtonElement>(".fo__tag-retry")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatchMock.mock.calls.filter(([name]) => name === "library:removeTag")).toHaveLength(2);
    expect(el.querySelector('[aria-label="remove triage"]')).toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  test("a late tag failure cannot leak into the next capture", async () => {
    const api = installHostApi();
    const dispatchMock = window.pwrsnapApi!.dispatch as ReturnType<typeof vi.fn>;
    const failed = {
      ok: false as const,
      error: {
        kind: "persistence" as const,
        code: "db_busy",
        message: "stale failure"
      }
    };
    const pending = deferred<typeof failed>();
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:addTag") return pending.promise;
      return defaultHostDispatchResult(name);
    });
    const el = await renderHostRecord(api);
    const input = el.querySelector<HTMLInputElement>(".fo__tag-input");
    await act(async () => {
      enterTag(input!, "old-capture-tag");
      await Promise.resolve();
    });

    const nextRecord = { ...imageRecord, id: "cap_2", sha256: "sha_cap_2" };
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.floatOverState, {
        kind: "show-loaded",
        captureId: nextRecord.id,
        record: nextRecord
      });
      await Promise.resolve();
    });

    await act(async () => {
      pending.resolve(failed);
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.textContent).not.toContain("old-capture-tag");
    expect(el.textContent).not.toContain("stale failure");
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("FloatOver AI suggestions", () => {
  test("shows Configure AI instead of Enable when the enrichment provider is unavailable", async () => {
    const onConfigureAi = vi.fn();
    const onEnableAi = vi.fn();
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      providerAvailable: false,
      aiEnabled: false,
      aiConsentAccepted: false,
      onConfigureAi,
      onEnableAi
    });

    const configure = Array.from(el.querySelectorAll("button")).find(
      (button) => button.textContent === "Configure AI"
    );
    expect(configure).toBeDefined();
    expect(el.textContent).not.toContain("Enable AI enrichment for new snaps?");

    await act(async () => {
      configure?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onConfigureAi).toHaveBeenCalledTimes(1);
    expect(onEnableAi).not.toHaveBeenCalled();
  });

  test("first-time Enable shows AI enrichment consent copy", async () => {
    const onEnableAi = vi.fn();
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      aiEnabled: false,
      aiConsentAccepted: false,
      onEnableAi
    });

    const enable = Array.from(el.querySelectorAll("button")).find(
      (button) => button.textContent === "Enable"
    );
    expect(enable).toBeDefined();

    await act(async () => {
      enable?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onEnableAi).not.toHaveBeenCalled();
    expect(el.textContent).toContain("Enable AI enrichment for new snaps?");
    expect(el.textContent).toContain("downsampled copy");
    expect(el.textContent).toContain("configured AI provider");

    const accept = Array.from(el.querySelectorAll("button")).find(
      (button) => button.textContent === "Enable AI enrichment"
    );
    expect(accept).toBeDefined();

    await act(async () => {
      accept?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onEnableAi).toHaveBeenCalledTimes(1);
  });

  test("previews Codex suggested description in the description field", async () => {
    const onAcceptDescription = vi.fn();
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment(),
      aiEnabled: true,
      aiConsentAccepted: true,
      onAcceptDescription
    });

    const textarea = el.querySelector<HTMLTextAreaElement>(".fo__desc");
    expect(textarea?.value).toBe("Dark-mode LINE desktop chat showing PwrAgent command help.");
    expect(textarea?.classList.contains("is-suggested")).toBe(true);

    textarea?.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    expect(onAcceptDescription).not.toHaveBeenCalled();
  });

  test("does not pause countdown just because a Codex description is previewed", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment(),
      aiEnabled: true,
      aiConsentAccepted: true
    });

    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(false);
  });

  test("does not repeat a previewed Codex description in the AI strip", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment(),
      aiEnabled: true,
      aiConsentAccepted: true
    });

    expect(el.querySelector<HTMLTextAreaElement>(".fo__desc")?.value).toBe(
      "Dark-mode LINE desktop chat showing PwrAgent command help."
    );
    // Pill says "Codex drafted a title + description" — it must NOT echo the
    // description text itself, because the textarea already shows it.
    const statusText = el.querySelector(".ps-codex-pill__text")?.textContent;
    expect(statusText).not.toContain(
      "Dark-mode LINE desktop chat showing PwrAgent command help."
    );
    expect(statusText).toContain("Codex drafted a title + description.");
    expect(el.querySelector(".fo__ai-accept")?.textContent).toBe("Save");
  });

  test("pauses countdown while Codex is still running", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment({
        status: "running",
        suggestedDescription: null,
        suggestedTags: []
      }),
      aiEnabled: true,
      aiConsentAccepted: true,
      onAddTag: async () => ({
        ok: true,
        value: enrichment({ acceptedTags: ["manual-tag"], suggestedTags: [] })
      })
    });

    expect(el.querySelector(".fo")?.classList.contains("is-thinking")).toBe(true);
    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(true);
  });

  test("shows ACP authentication failures instead of a generic read failure", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment({
        status: "failed",
        error: "This client is no longer supported for Gemini Code Assist for individuals.",
        suggestedDescription: null,
        suggestedTags: []
      }),
      aiEnabled: true,
      aiConsentAccepted: true,
      enrichmentProviderLabel: "Gemini"
    });

    expect(el.textContent).toContain("Gemini is not available");
    expect(el.textContent).toContain("This client is no longer supported");
  });

  test("accepts suggested description when the user clicks Use", async () => {
    const onAcceptDescription = vi.fn();
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment(),
      aiEnabled: true,
      aiConsentAccepted: true,
      onAcceptDescription
    });

    await act(async () => {
      el.querySelector<HTMLButtonElement>(".fo__ai-accept")?.click();
    });

    expect(onAcceptDescription).toHaveBeenCalledWith(
      "Dark-mode LINE desktop chat showing PwrAgent command help."
    );
  });

  test("renders the title input above the description and styles drafts as suggested", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment({ suggestedTitle: "LINE chat with PwrAgent help" }),
      aiEnabled: true,
      aiConsentAccepted: true
    });

    const titleInput = el.querySelector<HTMLInputElement>(".fo__title");
    const descTextarea = el.querySelector<HTMLTextAreaElement>(".fo__desc");
    expect(titleInput).not.toBeNull();
    expect(titleInput?.value).toBe("LINE chat with PwrAgent help");
    expect(titleInput?.classList.contains("is-suggested")).toBe(true);
    // Title sits above description in the DOM order.
    const annotateChildren = Array.from(
      el.querySelector(".fo__annotate")?.children ?? []
    );
    expect(annotateChildren.indexOf(titleInput as Element)).toBeLessThan(
      annotateChildren.indexOf(descTextarea as Element)
    );
  });

  test("typing into the title and blurring fires onAcceptTitle once", async () => {
    const onAcceptTitle = vi.fn();
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment({ suggestedTitle: null }),
      aiEnabled: true,
      aiConsentAccepted: true,
      onAcceptTitle
    });

    const titleInput = el.querySelector<HTMLInputElement>(".fo__title");
    expect(titleInput).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(titleInput, "Custom user title");
      titleInput?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
      // React 17+ delegates to root via `focusout`, not native `blur`.
      titleInput?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onAcceptTitle).toHaveBeenCalledTimes(1);
    expect(onAcceptTitle).toHaveBeenCalledWith("Custom user title");
  });

  test("blurring a suggested-but-untouched title does NOT fire onAcceptTitle", async () => {
    const onAcceptTitle = vi.fn();
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment({ suggestedTitle: "Codex draft headline" }),
      aiEnabled: true,
      aiConsentAccepted: true,
      onAcceptTitle
    });

    const titleInput = el.querySelector<HTMLInputElement>(".fo__title");
    await act(async () => {
      titleInput?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onAcceptTitle).not.toHaveBeenCalled();
  });

  test("Use draft fires both onAcceptTitle and onAcceptDescription", async () => {
    const onAcceptTitle = vi.fn();
    const onAcceptDescription = vi.fn();
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment({
        suggestedTitle: "Codex headline",
        suggestedDescription: "Codex body"
      }),
      aiEnabled: true,
      aiConsentAccepted: true,
      onAcceptTitle,
      onAcceptDescription
    });

    await act(async () => {
      el.querySelector<HTMLButtonElement>(".fo__ai-accept")?.click();
    });

    expect(onAcceptTitle).toHaveBeenCalledWith("Codex headline");
    expect(onAcceptDescription).toHaveBeenCalledWith("Codex body");
  });

  test("countdown is paused while AI is expected but no status has arrived", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      // startCountdown undefined → defaults to true, exercising the
      // actual ticker setup; the paused class is set from `isPaused`.
      enrichment: null,
      aiEnabled: true,
      aiConsentAccepted: true
    });

    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(true);
  });

  test("countdown stays paused after a 'queued' status arrives and resumes on 'completed'", async () => {
    let el = await renderFloatOver({
      src: "data:image/png;base64,",
      enrichment: enrichment({
        status: "queued",
        suggestedTitle: null,
        suggestedDescription: null,
        suggestedTags: []
      }),
      aiEnabled: true,
      aiConsentAccepted: true
    });
    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(true);

    await unmount();
    el = await renderFloatOver({
      src: "data:image/png;base64,",
      enrichment: enrichment({
        status: "completed",
        suggestedTitle: "Title",
        suggestedDescription: "Description body"
      }),
      aiEnabled: true,
      aiConsentAccepted: true
    });
    // Drafts are now ready and unaccepted; the countdown should NOT
    // be pinned just because a Codex draft is in the textarea.
    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(false);
  });

  test("auto-accept checkbox renders when AI is enabled and dispatches onSetAutoAccept", async () => {
    const onSetAutoAccept = vi.fn();
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: null,
      aiEnabled: true,
      aiConsentAccepted: true,
      autoAcceptSuggestions: false,
      onSetAutoAccept
    });

    const checkbox = el.querySelector<HTMLInputElement>(
      ".fo__auto-accept input[type='checkbox']"
    );
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
    const autoAccept = el.querySelector<HTMLLabelElement>(".fo__auto-accept");
    expect(autoAccept?.textContent).toContain("Auto-apply AI enrichment");
    expect(autoAccept?.getAttribute("title")).toBe(
      "Apply AI enrichment automatically when ready"
    );

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "checked"
      )?.set;
      setter?.call(checkbox, true);
      checkbox?.dispatchEvent(new Event("click", { bubbles: true }));
      checkbox?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onSetAutoAccept).toHaveBeenCalledWith(true);
  });

  test("auto-accept checkbox is hidden when AI consent is missing", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: null,
      aiEnabled: false,
      aiConsentAccepted: false,
      onSetAutoAccept: vi.fn()
    });

    expect(el.querySelector(".fo__auto-accept")).toBeNull();
  });

  test("Use button hides once the suggestion is already accepted (server-side auto-accept)", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment({
        suggestedTitle: "Auto title",
        acceptedTitle: "Auto title",
        suggestedDescription: "Auto body",
        acceptedDescription: "Auto body"
      }),
      aiEnabled: true,
      aiConsentAccepted: true,
      autoAcceptSuggestions: true
    });

    expect(el.querySelector(".fo__ai-accept")).toBeNull();
  });

  // Regression: bug vii — when enrichment lands with auto-accepted
  // tags, the countdown must NOT pause indefinitely. Previously the
  // `tags.length > initialTags.length` heuristic interpreted auto-
  // accept's setTags() as user engagement and stuck the toast on
  // screen until the user manually dismissed.
  test("auto-accepted tags from enrichment do NOT pin the countdown", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      enrichment: enrichment({
        status: "completed",
        suggestedTitle: "Auto title",
        acceptedTitle: "Auto title",
        suggestedDescription: "Auto body",
        acceptedDescription: "Auto body",
        acceptedTags: ["alpha", "beta"],
        suggestedTags: []
      }),
      aiEnabled: true,
      aiConsentAccepted: true,
      autoAcceptSuggestions: true
    });

    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(false);
  });

  // Regression: bug vii — user-added tags SHOULD pause the countdown.
  // The fix swapped a `tags.length > initialTags.length` heuristic for
  // a user-interaction counter; verify the new counter still tracks
  // explicit user actions.
  test("user-added tag pauses the countdown", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      enrichment: enrichment({
        status: "completed",
        suggestedTitle: "Title",
        acceptedTitle: "Title",
        suggestedDescription: "Body",
        acceptedDescription: "Body",
        suggestedTags: []
      }),
      aiEnabled: true,
      aiConsentAccepted: true
    });

    // Before user interaction: not paused.
    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(false);

    const tagInput = el.querySelector<HTMLInputElement>(".fo__tag-input");
    expect(tagInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(tagInput, "manual-tag");
      tagInput?.dispatchEvent(new Event("input", { bubbles: true }));
      tagInput?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(true);
  });

  // Regression: clicking the AI "Save"/"Use" button must NOT permanently
  // pin the countdown. Accepting drafts is a terminal action — interacting
  // with the toast pauses the timer while the pointer is over it, but once
  // the mouse moves off the auto-close timer has to resume. Previously the
  // Save click set a one-shot `aiAccepted` flag that fed `isPaused` and was
  // never reset, so the toast hung on screen forever after a single Save.
  test("clicking the AI Save button does not permanently pause the countdown", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      enrichment: enrichment(),
      aiEnabled: true,
      aiConsentAccepted: true
    });

    const fo = el.querySelector(".fo");
    // Previewed-but-unaccepted drafts alone don't pause.
    expect(fo?.classList.contains("is-paused")).toBe(false);

    const save = el.querySelector<HTMLButtonElement>(".fo__ai-accept");
    expect(save?.textContent).toBe("Save");

    await act(async () => {
      save?.click();
      await Promise.resolve();
    });

    // The pointer is not over the toast (this test never hovered). Simulate
    // the "click Save, then move the mouse off" flow for good measure — the
    // window-level mouseout handler clears any hover state. After that the
    // countdown must be running again, not pinned by the accept click.
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null, bubbles: true }));
      await Promise.resolve();
    });

    expect(fo?.classList.contains("is-paused")).toBe(false);
  });
});
