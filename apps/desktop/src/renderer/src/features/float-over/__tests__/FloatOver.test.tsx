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
      arrow: { color: "accent", thickness: "auto", endStyle: "filled-triangle", stemStyle: "solid", doubleEnded: false },
      text: { color: "accent", fontSize: "auto", weight: "regular" },
      shape: { color: "accent", thickness: "auto", filled: false, shape: "rect", skewDeg: 15 },
      blur: { mode: "gaussian", radius: { mode: "auto" } },
      highlight: { color: "yellow", opacity: 0.3, blend: "multiply" }
    },
    coachmarks: { stoplightSeen: false },
    matchingText: { enabled: true },
    sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
  },
  library: { detailRail: { pinned: true, lastSelectedTab: "info" } }
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

  test("video asset renders <video> in fo__preview and the 6-card export grid", async () => {
    const el = await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/abc",
      captureId: "abc",
      durationSec: 12.5
    });

    const preview = el.querySelector(".fo__preview");
    expect(preview?.querySelector("video")).not.toBeNull();
    expect(preview?.querySelector("img")).toBeNull();
    expect(preview?.querySelector("video")?.getAttribute("src")).toBe("pwrsnap-capture://r/abc");

    expect(el.querySelector(".fo__hdr-title")?.textContent).toBe("Recording saved");
    expect(el.querySelector(".fo__hdr-sub")?.textContent).toContain("12.5s");

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

describe("FloatOver Codex suggestions", () => {
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
    expect(el.textContent).not.toContain("Let Codex read new snaps?");

    await act(async () => {
      configure?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onConfigureAi).toHaveBeenCalledTimes(1);
    expect(onEnableAi).not.toHaveBeenCalled();
  });

  test("first-time Enable shows consent copy before enabling Codex", async () => {
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
    expect(el.textContent).toContain("Let Codex read new snaps?");
    expect(el.textContent).toContain("downsampled copy");

    const accept = Array.from(el.querySelectorAll("button")).find(
      (button) => button.textContent === "Enable Codex"
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
    expect(el.querySelector(".ps-codex-pill__text")?.textContent).not.toContain(
      "Dark-mode LINE desktop chat showing PwrAgent command help."
    );
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
      aiConsentAccepted: true
    });

    expect(el.querySelector(".fo")?.classList.contains("is-thinking")).toBe(true);
    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(true);
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
});
