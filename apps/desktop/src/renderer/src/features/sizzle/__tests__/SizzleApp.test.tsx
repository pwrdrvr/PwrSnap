// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  EVENT_CHANNELS,
  type CaptureRecord,
  type ShortcutPlatform,
  type SizzleProject,
  type SizzleScene
} from "@pwrsnap/shared";
import {
  SizzleApp,
  formatSequencePreviewWarnings,
  formatTranscriptPhraseOptionLabel,
  resetSizzleChatWidthForTests
} from "../SizzleApp";

// The sequence preview draws its waveform with wavesurfer.js, which needs
// a real canvas + Web Audio. jsdom has neither, and we don't unit-test the
// third-party renderer — stub it so the preview path stays deterministic.
vi.mock("wavesurfer.js", () => ({
  default: {
    create: () => ({
      loadBlob: () => Promise.resolve(),
      destroy: () => undefined
    })
  }
}));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom implements neither of these; the composer touches them.
  Element.prototype.scrollIntoView = vi.fn();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn(async function play(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("timeupdate"));
  });
  HTMLMediaElement.prototype.pause = vi.fn(function pause(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  });
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

type Handler = (payload: unknown) => void;

function scene(patch: Partial<SizzleScene> = {}): SizzleScene {
  return {
    id: "sc_a",
    captureId: "cap_a",
    scriptLine: "",
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "auto",
    transition: "crossfade",
    ...patch
  };
}

function project(patch: Partial<SizzleProject> = {}): SizzleProject {
  return {
    id: "sz_1",
    name: "Demo Reel",
    createdAt: "2026-05-28T00:00:00.000Z",
    modifiedAt: "2026-05-28T00:00:00.000Z",
    coverCaptureId: null,
    scenes: [scene()],
    voice: "onyx",
    ttsModel: "tts-1-hd",
    ttsProvider: "openai",
    resolution: "1080p",
    outputPath: null,
    lastRenderedAt: null,
    ...patch
  };
}

function projects(count: number): SizzleProject[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return project({
      id: `sz_${n}`,
      name: `Reel ${n}`,
      createdAt: new Date(Date.UTC(2026, 4, n, 12, 0, 0)).toISOString(),
      modifiedAt: new Date(Date.UTC(2026, 4, n, 13, 0, 0)).toISOString()
    });
  });
}

function videoCapture(id: string, defaultRange = { start: 0, end: 5 }): CaptureRecord {
  return {
    id,
    kind: "video",
    captured_at: "2026-05-28T00:00:00.000Z",
    legacy_src_path: `/tmp/${id}.mp4`,
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 1,
    bundle_edits_version: 0,
    width_px: 1920,
    height_px: 1080,
    device_pixel_ratio: 1,
    byte_size: 1000,
    sha256: id,
    source_app_bundle_id: null,
    source_app_name: `Video ${id}`,
    edits_version: 0,
    has_alpha: false,
    deleted_at: null,
    video: {
      durationSec: 8,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      defaultRange,
      previewPath: null,
      previewStatus: "ready"
    }
  };
}

function installApi(
  projects: SizzleProject[],
  overrides: Record<string, unknown> = {}
): {
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
} {
  const handlers = new Map<string, Set<Handler>>();
  const dispatch = vi.fn(async (name: string, req?: unknown) => {
    if (name in overrides) {
      const override = overrides[name];
      // A function override runs per call (it can mutate the mock store,
      // the way a real create/duplicate changes what sizzle:list returns).
      return typeof override === "function" ? (override as (req: unknown) => unknown)(req) : override;
    }
    if (name === "sizzle:list") return { ok: true, value: { projects } };
    if (name === "library:list") return { ok: true, value: { rows: [] } };
    if (name === "library:listByIds") return { ok: true, value: { rows: [] } };
    // Cache-only waveform load defaults to a miss; specific tests
    // override it to return cached audio.
    if (name === "sizzle:loadSequenceSceneAudio") {
      return { ok: true, value: { cached: false } };
    }
    if (name === "sizzle:update") {
      const id = (req as { id?: string } | undefined)?.id;
      return { ok: true, value: projects.find((p) => p.id === id) ?? projects[0] };
    }
    if (name === "sizzle:previewSceneAudio") {
      return {
        ok: true,
        value: { audioBase64: "AA==", mimeType: "audio/mpeg", durationSec: 4 }
      };
    }
    if (name === "sizzle:previewSequenceScenePlan") {
      return {
        ok: true,
        value: {
          audioBase64: "AA==",
          mimeType: "audio/mpeg",
          durationSec: 4,
          timingQuality: "approximate",
          warnings: [],
          transcriptPhrases: [
            {
              text: "the next screen",
              startSec: 1.5,
              endSec: 2.4,
              wordStartIndex: 3,
              wordEndIndex: 5
            }
          ],
          words: [
            { index: 3, word: "the", normalized: "the", startSec: 1.5, endSec: 1.7 },
            { index: 4, word: "next", normalized: "next", startSec: 1.7, endSec: 2.0 },
            { index: 5, word: "screen", normalized: "screen", startSec: 2.0, endSec: 2.4 }
          ],
          beats: [
            {
              beatId: "bt_1",
              captureId: "cap_a",
              startSec: 0,
              endSec: 2,
              timing: { kind: "offset", startSec: 0, endSec: null },
              transition: "crossfade",
              videoFit: "smart-fit"
            },
            {
              beatId: "bt_2",
              captureId: "cap_b",
              startSec: 2,
              endSec: 4,
              timing: { kind: "phrase", phrase: "next", occurrence: 1, offsetSec: 0, durationSec: null },
              transition: "crossfade",
              videoFit: "smart-fit"
            }
          ]
        }
      };
    }
    return { ok: true, value: undefined };
  });
  const on = (channel: string, handler: Handler): (() => void) => {
    const set = handlers.get(channel) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(channel, set);
    return () => set.delete(handler);
  };
  const emit = (channel: string, payload: unknown): void => {
    for (const h of handlers.get(channel) ?? []) h(payload);
  };
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on,
    platform: "darwin",
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return { dispatch, emit };
}

async function renderApp(
  initial: SizzleProject | SizzleProject[],
  overrides: Record<string, unknown> = {},
  shortcutPlatform: ShortcutPlatform = "darwin"
): Promise<{
  el: HTMLDivElement;
  emit: (channel: string, payload: unknown) => void;
  dispatch: ReturnType<typeof vi.fn>;
}> {
  const { dispatch, emit } = installApi(
    Array.isArray(initial) ? initial : [initial],
    overrides
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SizzleApp, { shortcutPlatform }));
  });
  // Drain the mount-time sizzle:list / library:list dispatches.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { el: container, emit, dispatch };
}

function titleValue(el: HTMLElement): string {
  return el.querySelector<HTMLInputElement>(".szl__editor-title")?.value ?? "";
}

function scriptBox(el: HTMLElement): HTMLTextAreaElement {
  const box = el.querySelector<HTMLTextAreaElement>(".szl__scene-script");
  if (box === null) throw new Error("scene script textarea not found");
  return box;
}

/** Simulate a user keystroke into a React-controlled textarea. */
function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function projectRowNames(list: Element | null): string[] {
  return Array.from(list?.querySelectorAll(".szl__row-name") ?? []).map(
    (el) => el.textContent ?? ""
  );
}

function clickProjectRow(list: Element | null, name: string): void {
  const button = Array.from(list?.querySelectorAll<HTMLButtonElement>(".szl__row") ?? [])
    .find((row) => row.textContent?.includes(name) === true);
  if (button === undefined) throw new Error(`project row not found: ${name}`);
  button.click();
}

/** Select a clip on the timeline — the clip inspector (right rail) opens for it. */
async function selectClip(el: HTMLElement, beatId: string): Promise<void> {
  const clip = el.querySelector<HTMLButtonElement>(`[data-testid="sizzle-timeline-clip-${beatId}"]`);
  if (clip === null) throw new Error(`timeline clip ${beatId} not found`);
  await act(async () => {
    clip.click();
  });
}

/** Which timing the inspector shows for the selected clip ("pinned" = clip 0). */
function inspectorTiming(el: HTMLElement): "auto" | "phrase" | "offset" | "pinned" | null {
  if (el.querySelector('[data-testid="sizzle-inspector-pinned"]') !== null) return "pinned";
  for (const kind of ["auto", "phrase", "offset"] as const) {
    const button = el.querySelector(`[data-testid="sizzle-inspector-timing-${kind}"]`);
    if (button?.getAttribute("aria-pressed") === "true") return kind;
  }
  return null;
}

/** Load/refresh a scene's narration plan. The per-scene ▶ that used to do
 *  this is gone (one player now) — synthesis lives in the scene inspector. */
async function synthesizeScene(el: HTMLElement, sceneIndex = 0): Promise<void> {
  const region = el.querySelector<HTMLButtonElement>(`[data-testid="sizzle-timeline-scene-${sceneIndex}"]`);
  if (region === null) throw new Error(`scene region ${sceneIndex} not found`);
  await act(async () => {
    region.click();
  });
  const button = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-scene-inspector-synthesize"]');
  if (button === null) throw new Error("scene inspector synthesize button not found");
  await act(async () => {
    button.click();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function findButton(el: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (button === undefined) throw new Error(`button not found: ${label}`);
  return button;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  // jsdom shares window across a file's tests — reset the nav hash so one
  // test's projectId seed can't leak into the next.
  window.location.hash = "";
});

describe("SizzleApp live project sync", () => {
  test("renders the active project's scene script on mount", async () => {
    const { el } = await renderApp(project({ scenes: [scene({ scriptLine: "first line" })] }));
    expect(scriptBox(el).value).toBe("first line");
  });

  test("an external sizzle:projects:changed broadcast updates the editor live", async () => {
    // This is the agent-edit path: scene_set_script lands in the store,
    // main broadcasts, and the open composer must reflect it.
    const { el, emit } = await renderApp(project({ scenes: [scene({ scriptLine: "" })] }));
    expect(scriptBox(el).value).toBe("");

    await act(async () => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, {
        projects: [project({ scenes: [scene({ scriptLine: "agent-written narration" })] })]
      });
    });

    expect(scriptBox(el).value).toBe("agent-written narration");
  });

  test("a broadcast does NOT clobber the user's in-flight (debounced) edit", async () => {
    const { el, emit } = await renderApp(project({ scenes: [scene({ scriptLine: "" })] }));

    // User starts typing — optimistic local state + a pending debounced
    // patch for this project.
    await act(async () => {
      typeInto(scriptBox(el), "user is typing");
    });
    expect(scriptBox(el).value).toBe("user is typing");

    // An external broadcast for the SAME project arrives mid-edit.
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, {
        projects: [project({ scenes: [scene({ scriptLine: "stale broadcast value" })] })]
      });
    });

    // The user's in-flight text is preserved, not clobbered.
    expect(scriptBox(el).value).toBe("user is typing");
  });

  test("ignores malformed broadcast payloads", async () => {
    const { el, emit } = await renderApp(project({ scenes: [scene({ scriptLine: "kept" })] }));
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, { projects: "not-an-array" });
      emit(EVENT_CHANNELS.sizzleProjectsChanged, null);
    });
    expect(scriptBox(el).value).toBe("kept");
  });
});

describe("SizzleApp sequence authoring", () => {
  test("turns a simple scene into a visible grouped sequence", async () => {
    const { el } = await renderApp(
      project({ scenes: [scene({ scriptLine: "one narration block" })] })
    );

    expect(el.textContent).not.toContain("Scene · one voiceover");

    await act(async () => {
      findButton(el, "Convert to clips").click();
    });

    expect(el.textContent).toContain("Scene · one voiceover");
    expect(scriptBox(el).value).toBe("one narration block");
    // The clip lives on the timeline now (one clip); the form rows are gone.
    expect(el.querySelectorAll('[data-testid^="sizzle-timeline-clip-"]')).toHaveLength(1);
    expect(el.querySelector(".szl__sequence-beat")).toBeNull();
    expect(el.querySelector('[data-testid="sizzle-timeline"]')).not.toBeNull();
    // Not synthesized yet: the timeline says so and offers the fix.
    expect(el.querySelector('[data-testid="sizzle-timeline-estimated-0"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="sizzle-timeline-synthesize-0"]')).not.toBeNull();
  });

  test("Split into scenes gives every clip its own scene; the first keeps id + narration", async () => {
    const seq = scene({
      id: "sc_seq",
      kind: "sequence",
      captureId: "cap_a",
      scriptLine: "one voiceover",
      narration: "one voiceover",
      audioSource: "voiceover",
      beats: [
        { id: "bt_a", captureId: "cap_a", timing: { kind: "auto" }, mediaTrim: null, transition: "cut", videoFit: "smart-fit" },
        { id: "bt_b", captureId: "cap_b", timing: { kind: "offset", startSec: 3, endSec: null }, mediaTrim: { startSec: 1, endSec: 4 }, transition: "cut", videoFit: "loop" },
        { id: "bt_c", captureId: "cap_c", timing: { kind: "auto" }, mediaTrim: null, transition: "cut", videoFit: "smart-fit" }
      ]
    });
    const { el, dispatch } = await renderApp(project({ scenes: [seq] }));
    const split = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-split-scene-sc_seq"]');
    expect(split).not.toBeNull();
    await act(async () => {
      split!.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const updateCalls = dispatch.mock.calls.filter(([name]) => name === "sizzle:update");
    const payload = updateCalls.at(-1)?.[1] as { patch?: { scenes?: SizzleScene[] } } | undefined;
    const scenes = payload?.patch?.scenes ?? [];
    expect(scenes).toHaveLength(3);
    expect(scenes.map((s) => s.kind)).toEqual(["sequence", "sequence", "sequence"]);
    expect(scenes.map((s) => s.beats?.map((b) => b.captureId))).toEqual([["cap_a"], ["cap_b"], ["cap_c"]]);
    // First keeps the scene id + narration; the rest are fresh and empty.
    expect(scenes[0]!.id).toBe("sc_seq");
    expect(scenes[0]!.narration).toBe("one voiceover");
    expect(scenes[1]!.id).not.toBe("sc_seq");
    expect(scenes[1]!.narration).toBe("");
    // Clip timing resets to auto; trim + fit travel with the clip.
    expect(scenes[1]!.beats![0]).toMatchObject({
      id: "bt_b",
      timing: { kind: "auto" },
      mediaTrim: { startSec: 1, endSec: 4 },
      videoFit: "loop"
    });
    // A one-clip scene offers no split.
    expect(el.querySelector('[data-testid="sizzle-split-scene-sc_seq"]')).toBeNull();
  });

  test("hydrates active reel captures that are outside the initial library page", async () => {
    const sequence = scene({
      kind: "sequence",
      captureId: "cap_old",
      scriptLine: "show an older capture",
      narration: "show an older capture",
      audioSource: "voiceover",
      beats: [
        {
          id: "bt_1",
          captureId: "cap_old",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        }
      ]
    });
    const { el, dispatch } = await renderApp(project({ scenes: [sequence] }), {
      "library:list": {
        ok: true,
        value: { rows: [videoCapture("cap_recent")] }
      },
      "library:listByIds": {
        ok: true,
        value: { rows: [videoCapture("cap_old")] }
      }
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith("library:listByIds", { ids: ["cap_old"] });
    expect(
      el.querySelector('[data-testid^="sizzle-timeline-clip-"]')?.getAttribute("aria-label")
    ).toContain("Video cap_old");
  });

  test("loads a resolved sequence timeline when previewing", async () => {
    const sequence = scene({
      kind: "sequence",
      scriptLine: "show this then the next screen",
      narration: "show this then the next screen",
      audioSource: "voiceover",
      beats: [
        {
          id: "bt_1",
          captureId: "cap_a",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        {
          id: "bt_2",
          captureId: "cap_b",
          timing: { kind: "phrase", phrase: "next", occurrence: 1, offsetSec: 0, durationSec: null },
          mediaTrim: null,
          transition: "crossfade",
          videoFit: "smart-fit"
        }
      ]
    });
    const { el, dispatch } = await renderApp(project({ scenes: [sequence] }));

    await synthesizeScene(el);

    expect(dispatch).toHaveBeenCalledWith("sizzle:previewSequenceScenePlan", {
      projectId: "sz_1",
      sceneId: "sc_a"
    });
    expect(dispatch).not.toHaveBeenCalledWith("sizzle:previewSceneAudio", {
      projectId: "sz_1",
      sceneId: "sc_a"
    });
    expect(el.textContent).toContain("approx timing");
    expect(el.querySelector("select.szl__sequence-phrase")).toBeNull();
    expect(el.querySelector("datalist")).toBeNull();
    // The phrase picker lives in the clip inspector: select the clip first.
    await selectClip(el, "bt_2");
    const phrasePicker = el.querySelector<HTMLButtonElement>(".szl__sequence-phrase-button");
    expect(phrasePicker?.textContent).toContain("next");

    if (phrasePicker === null) throw new Error("sequence transcript phrase picker not found");
    await act(async () => {
      phrasePicker.click();
    });
    expect(el.querySelector(".szl__sequence-phrase-popover")).not.toBeNull();
    const option = [...el.querySelectorAll<HTMLButtonElement>(".szl__sequence-phrase-option")]
      .find((button) => button.textContent?.includes("the next screen") === true);
    expect(option?.textContent).toContain("1.5s - 2.4s");
    if (option === undefined) throw new Error("transcript phrase option not found");
    await act(async () => {
      option.click();
    });
    expect(el.querySelector<HTMLButtonElement>(".szl__sequence-phrase-button")?.textContent).toContain("the next screen");
  });

  test("stores the selected transcript occurrence when repeated phrases share the same text", async () => {
    const sequence = scene({
      kind: "sequence",
      scriptLine: "repeat phrase then repeat phrase",
      narration: "repeat phrase then repeat phrase",
      audioSource: "voiceover",
      beats: [
        {
          id: "bt_1",
          captureId: "cap_a",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        {
          id: "bt_2",
          captureId: "cap_b",
          timing: { kind: "phrase", phrase: "repeat phrase", occurrence: null, offsetSec: 0, durationSec: null },
          mediaTrim: null,
          transition: "crossfade",
          videoFit: "smart-fit"
        }
      ]
    });
    const { el, dispatch } = await renderApp(project({ scenes: [sequence] }), {
      "sizzle:previewSequenceScenePlan": {
        ok: true,
        value: {
          audioBase64: "AA==",
          mimeType: "audio/mpeg",
          durationSec: 4,
          timingQuality: "approximate",
          warnings: [],
          transcriptPhrases: [
            {
              text: "repeat phrase",
              startSec: 0.5,
              endSec: 1.2,
              wordStartIndex: 0,
              wordEndIndex: 1
            },
            {
              text: "repeat phrase",
              startSec: 2.4,
              endSec: 3.1,
              wordStartIndex: 3,
              wordEndIndex: 4
            }
          ],
          beats: [
            {
              beatId: "bt_1",
              captureId: "cap_a",
              startSec: 0,
              endSec: 2.4,
              timing: { kind: "offset", startSec: 0, endSec: null },
              transition: "crossfade",
              videoFit: "smart-fit"
            },
            {
              beatId: "bt_2",
              captureId: "cap_b",
              startSec: 2.4,
              endSec: 4,
              timing: { kind: "phrase", phrase: "repeat phrase", occurrence: 2, offsetSec: 0, durationSec: null },
              transition: "crossfade",
              videoFit: "smart-fit"
            }
          ]
        }
      }
    });
    await synthesizeScene(el);

    await selectClip(el, "bt_2");
    const phrasePicker = el.querySelector<HTMLButtonElement>(".szl__sequence-phrase-button");
    if (phrasePicker === null) throw new Error("sequence transcript phrase picker not found");
    await act(async () => {
      phrasePicker.click();
    });
    const laterOption = [...el.querySelectorAll<HTMLButtonElement>(".szl__sequence-phrase-option")]
      .find((button) => button.textContent?.includes("2.4s - 3.1s") === true);
    if (laterOption === undefined) throw new Error("later repeated phrase option not found");
    await act(async () => {
      laterOption.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    const updateCalls = dispatch.mock.calls.filter(([name]) => name === "sizzle:update");
    const payload = updateCalls.at(-1)?.[1] as { patch?: { scenes?: SizzleScene[] } } | undefined;
    const updatedBeat = payload?.patch?.scenes?.[0]?.beats?.[1];
    expect(updatedBeat?.timing).toEqual(
      expect.objectContaining({
        kind: "phrase",
        phrase: "repeat phrase",
        occurrence: 2
      })
    );
  });

  test("closes the transcript phrase picker when clicking outside", async () => {
    const sequence = scene({
      kind: "sequence",
      scriptLine: "show this then the next screen",
      narration: "show this then the next screen",
      audioSource: "voiceover",
      beats: [
        {
          id: "bt_1",
          captureId: "cap_a",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        {
          id: "bt_2",
          captureId: "cap_b",
          timing: { kind: "phrase", phrase: "next", occurrence: 1, offsetSec: 0, durationSec: null },
          mediaTrim: null,
          transition: "crossfade",
          videoFit: "smart-fit"
        }
      ]
    });
    const { el } = await renderApp(project({ scenes: [sequence] }));
    await synthesizeScene(el);

    await selectClip(el, "bt_2");
    const phrasePicker = el.querySelector<HTMLButtonElement>(".szl__sequence-phrase-button");
    if (phrasePicker === null) throw new Error("sequence transcript phrase picker not found");
    await act(async () => {
      phrasePicker.click();
    });
    expect(el.querySelector(".szl__sequence-phrase-popover")).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(el.querySelector(".szl__sequence-phrase-popover")).toBeNull();
  });

  test("invalidates a resolved sequence timeline when beat timing changes", async () => {
    const sequence = scene({
      kind: "sequence",
      scriptLine: "show this then the next screen",
      narration: "show this then the next screen",
      audioSource: "voiceover",
      beats: [
        {
          id: "bt_1",
          captureId: "cap_a",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        {
          id: "bt_2",
          captureId: "cap_b",
          timing: { kind: "phrase", phrase: "next", occurrence: 1, offsetSec: 0, durationSec: null },
          mediaTrim: null,
          transition: "crossfade",
          videoFit: "smart-fit"
        }
      ]
    });
    const { el } = await renderApp(project({ scenes: [sequence] }));

    await selectClip(el, "bt_2");
    expect(el.querySelector<HTMLButtonElement>(".szl__sequence-phrase-button")?.disabled).toBe(true);
    await synthesizeScene(el);
    expect(el.textContent).toContain("approx timing");

    // Synthesis selects the SCENE (its inspector owns that button); the
    // phrase picker belongs to the clip inspector, so re-select the clip.
    await selectClip(el, "bt_2");
    const phrase = el.querySelector<HTMLButtonElement>(".szl__sequence-phrase-button");
    if (phrase === null) throw new Error("sequence phrase picker not found");
    await act(async () => {
      phrase.click();
    });
    const option = [...el.querySelectorAll<HTMLButtonElement>(".szl__sequence-phrase-option")]
      .find((button) => button.textContent?.includes("the next screen") === true);
    if (option === undefined) throw new Error("transcript phrase option not found");
    await act(async () => {
      option.click();
    });

    // The plan is invalidated: the scene keeps its MEASURED narration length
    // (the script did not change) but loses the plan's word-timing quality,
    // which is what the readout reports.
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-scene-0"]')!.click();
    });
    expect(
      el.querySelector('[data-testid="sizzle-scene-inspector-status"]')?.textContent
    ).not.toContain("approx timing");
    await selectClip(el, "bt_2");
    const nextPhrase = el.querySelector<HTMLButtonElement>(".szl__sequence-phrase-button");
    expect(nextPhrase?.textContent).toContain("the next screen");
    await act(async () => {
      nextPhrase?.click();
    });
    expect(
      [...el.querySelectorAll<HTMLButtonElement>(".szl__sequence-phrase-option")]
        .some((button) => button.textContent?.includes("the next screen") === true)
    ).toBe(true);
  });
});

describe("sequence preview warnings", () => {
  test("coalesces auto-repaired trim and fit diagnostics into one adjusted note", () => {
    const warnings = formatSequencePreviewWarnings(
      [
        {
          beatId: "bt_4",
          code: "media_trim_clamped",
          message: "Media trim was clamped to the 4.204s source duration"
        },
        {
          beatId: "bt_4",
          code: "video_fit",
          message: "Requested speed-to-fit would exceed rate limits; using freeze-end"
        }
      ],
      ["bt_1", "bt_2", "bt_3", "bt_4"]
    );

    expect(warnings).toEqual([
      {
        key: "media_trim_clamped-bt_4-0",
        label: "Clip 4",
        message:
          "Media trim was clamped to the 4.204s source duration; using freeze-end because speed-to-fit would be too aggressive"
      }
    ]);
  });

  test("coalesces auto-repaired fit and trim diagnostics when the fit note arrives first", () => {
    const warnings = formatSequencePreviewWarnings(
      [
        {
          beatId: "bt_4",
          code: "video_fit",
          message: "Requested speed-to-fit would exceed rate limits; using freeze-end"
        },
        {
          beatId: "bt_4",
          code: "media_trim_clamped",
          message: "Media trim was clamped to the 4.204s source duration"
        }
      ],
      ["bt_1", "bt_2", "bt_3", "bt_4"]
    );

    expect(warnings).toEqual([
      {
        key: "video_fit-bt_4-0",
        label: "Clip 4",
        message:
          "Media trim was clamped to the 4.204s source duration; using freeze-end because speed-to-fit would be too aggressive"
      }
    ]);
  });

  test("phrases that fall back to automatic timing render as notes", () => {
    const warnings = formatSequencePreviewWarnings(
      [
        {
          beatId: "bt_2",
          code: "phrase_unresolved",
          message: 'Could not resolve phrase anchor "Once it is installed," — placing it automatically'
        }
      ],
      ["bt_1", "bt_2"]
    );

    expect(warnings[0]?.label).toBe("Clip 2");
  });
});

describe("sequence transcript phrase options", () => {
  test("labels transcript suggestions by timestamp", () => {
    expect(
      formatTranscriptPhraseOptionLabel({
        text: "Once It's installed",
        startSec: 1.25,
        endSec: 3.5,
        wordStartIndex: 4,
        wordEndIndex: 6
      })
    ).toBe("1.3s - 3.5s");
  });
});

describe("SizzleApp open-to-project navigation", () => {
  const first = project({ id: "sz_1", name: "First reel" });
  const second = project({ id: "sz_2", name: "Second reel" });

  test("events:sizzle:nav switches to the clicked reel when already open", async () => {
    // The reported bug: clicking the 2nd Sizzle Reel in the Library opened
    // the composer on the 1st project. With the nav subscription the open
    // window jumps to the clicked one.
    const { el, emit } = await renderApp([first, second]);
    expect(titleValue(el)).toBe("First reel"); // defaults to projects[0]

    await act(async () => {
      emit(EVENT_CHANNELS.sizzleNav, { projectId: "sz_2" });
    });
    expect(titleValue(el)).toBe("Second reel");
  });

  test("a newly-opened window honors the projectId in the URL hash", async () => {
    window.location.hash = "#stage=sizzle&projectId=sz_2";
    const { el } = await renderApp([first, second]);
    // Seeded from the hash → lands on the 2nd reel, not projects[0].
    expect(titleValue(el)).toBe("Second reel");
  });
});

describe("SizzleApp project rail", () => {
  test("shows creation and update dates on project rows", async () => {
    const p = project({
      scenes: [scene(), scene({ id: "sc_b" })],
      createdAt: "2026-05-24T12:00:00.000Z",
      modifiedAt: "2026-05-28T12:00:00.000Z"
    });
    const { el } = await renderApp(p);
    const activeRow = el.querySelector(".szl__row.is-active");
    expect(activeRow?.textContent).toContain("Demo Reel");
    expect(activeRow?.textContent).toContain("Created");
    expect(activeRow?.textContent).toContain("2 clips");
    expect(activeRow?.textContent).toContain("Updated");
    expect(activeRow?.textContent).toContain("2026");
  });

  test("caps the scrollable projects list while keeping an opened project visible in Recents", async () => {
    window.location.hash = "#stage=sizzle&projectId=sz_105";
    const { el } = await renderApp(projects(106));

    const recents = el.querySelector('[data-testid="sizzle-recents-list"]');
    const projectList = el.querySelector('[data-testid="sizzle-projects-list"]');
    expect(projectList?.classList.contains("szl__list--projects")).toBe(true);
    expect(projectList?.querySelectorAll(".szl__row")).toHaveLength(100);
    expect(recents?.textContent).toContain("Reel 105");
    expect(recents?.querySelector(".szl__row.is-active")?.textContent).toContain("Reel 105");
  });

  test("clicking an existing recent project does not reorder Recents", async () => {
    const { el } = await renderApp(projects(3));
    const recents = el.querySelector('[data-testid="sizzle-recents-list"]');
    const projectList = el.querySelector('[data-testid="sizzle-projects-list"]');
    expect(projectRowNames(recents)).toEqual(["Reel 1"]);

    await act(async () => {
      clickProjectRow(projectList, "Reel 2");
    });
    expect(projectRowNames(recents)).toEqual(["Reel 2", "Reel 1"]);

    await act(async () => {
      clickProjectRow(recents, "Reel 1");
    });
    expect(projectRowNames(recents)).toEqual(["Reel 2", "Reel 1"]);
    expect(recents?.querySelector(".szl__row.is-active")?.textContent).toContain("Reel 1");
  });
});

describe("render precondition", () => {
  test("a legacy simple video scene with no script stays renderable", async () => {
    // Native audio: the render path only rejects an empty script when the
    // scene resolves to VOICEOVER, and `auto` over a video with no script
    // resolves to `native`. Disabling Render here would strand every reel
    // built before the one-scene default.
    const { el } = await renderApp(
      project({ scenes: [scene({ captureId: "cap_a", scriptLine: "", audioSource: "auto" })] }),
      { "library:list": { ok: true, value: { rows: [videoCapture("cap_a")] } } }
    );
    const render = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]');
    expect(render).not.toBeNull();
    expect(render?.disabled).toBe(false);
  });

  test("a sequence scene with no narration blocks Render", async () => {
    const { el } = await renderApp(
      project({
        scenes: [
          scene({
            kind: "sequence",
            captureId: "cap_a",
            scriptLine: "",
            narration: "",
            audioSource: "voiceover",
            beats: [
              {
                id: "bt_a",
                captureId: "cap_a",
                timing: { kind: "auto" },
                mediaTrim: null,
                transition: "cut",
                videoFit: "smart-fit"
              }
            ]
          })
        ]
      }),
      { "library:list": { ok: true, value: { rows: [videoCapture("cap_a")] } } }
    );
    const render = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]');
    expect(render?.disabled).toBe(true);
    expect(render?.title ?? "").toContain("no narration");
  });
});

describe("render button reel length", () => {
  const sequenceScene = (narration: string): SizzleScene =>
    scene({
      kind: "sequence",
      captureId: "cap_a",
      scriptLine: narration,
      narration,
      audioSource: "voiceover",
      beats: [
        {
          id: "bt_a",
          captureId: "cap_a",
          timing: { kind: "auto" },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        }
      ]
    });

  test("shows an exact length with no tilde when every scene is determined", async () => {
    // Video + native audio: the scene is exactly its trim (0–5s), and
    // nothing here waits on a narration measurement.
    const { el } = await renderApp(
      project({ scenes: [scene({ captureId: "cap_a", scriptLine: "", audioSource: "auto" })] }),
      { "library:list": { ok: true, value: { rows: [videoCapture("cap_a")] } } }
    );
    const render = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]');
    expect(render?.textContent).toBe("Render · 0:05");
    expect(render?.title ?? "").toBe("");
  });

  test("marks an unpreviewed sequence scene's length with a tilde and explains why", async () => {
    const { el } = await renderApp(
      project({
        scenes: [
          scene({
            kind: "sequence",
            captureId: "cap_a",
            scriptLine: "hello",
            narration: "hello",
            audioSource: "voiceover",
            beats: [
              {
                id: "bt_a",
                captureId: "cap_a",
                timing: { kind: "auto" },
                mediaTrim: null,
                transition: "cut",
                videoFit: "smart-fit"
              }
            ]
          })
        ]
      }),
      { "library:list": { ok: true, value: { rows: [videoCapture("cap_a")] } } }
    );
    const render = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]');
    expect(render?.textContent).toBe("Render · ~0:01");
    expect(render?.title ?? "").toContain("narration length isn't known until it's synthesized");
  });

  test("goes exact after a preview measures the voiceover, and back to estimated when the script changes", async () => {
    // Video trimmed to 2s with a script — the scene resolves to voiceover,
    // so its true length is the narration (4s + tail pad), not the trim.
    const { el } = await renderApp(
      project({
        scenes: [scene({ captureId: "cap_a", scriptLine: "hello", audioSource: "auto" })]
      }),
      {
        "library:list": {
          ok: true,
          value: { rows: [videoCapture("cap_a", { start: 0, end: 2 })] }
        }
      }
    );
    const render = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]');
    // Unmeasured: a one-word script doesn't overrun the 2s trim.
    expect(render?.textContent).toBe("Render · ~0:02");

    await synthesizeScene(el);
    // Measured at 4s → 4.35s with the tail pad, and now exact.
    expect(render?.textContent).toBe("Render · 0:04");

    const script = el.querySelector<HTMLTextAreaElement>("textarea.szl__scene-script");
    if (script === null) throw new Error("scene script textarea not found");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!;
      setValue.call(script, "a much longer narration than before");
      script.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The measurement belongs to the OLD script — reporting it as exact
    // would be a confidently wrong number. Falls back to the word-count
    // estimate for the NEW script: 6 words at 160 wpm + 0.35s pad = 2.6s,
    // which now overruns the 2s trim.
    expect(render?.textContent).toBe("Render · ~0:03");
  });

  test("is exact on open when the narration is already in the TTS cache", async () => {
    // A reel previewed or rendered in a PAST session: the cache-only
    // load that runs on open carries the measured narration length, so
    // the label is exact without the user previewing again.
    const { el } = await renderApp(
      project({
        scenes: [
          scene({
            kind: "sequence",
            captureId: "cap_a",
            scriptLine: "hello",
            narration: "hello",
            audioSource: "voiceover",
            beats: [
              {
                id: "bt_a",
                captureId: "cap_a",
                timing: { kind: "auto" },
                mediaTrim: null,
                transition: "cut",
                videoFit: "smart-fit"
              }
            ]
          })
        ]
      }),
      {
        "library:list": { ok: true, value: { rows: [videoCapture("cap_a")] } },
        "sizzle:loadSequenceSceneAudio": {
          ok: true,
          value: {
            cached: true,
            audioBase64: "AA==",
            mimeType: "audio/mpeg",
            transcriptPhrases: [],
            durationSec: 19
          }
        }
      }
    );
    const render = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]');
    expect(render?.textContent).toBe("Render · 0:19");
    expect(render?.title ?? "").toBe("");
  });

  test("drops back to estimated when the voice changes under a cached measurement", async () => {
    // The measurement was taken with the reel's previous voice; a
    // different voice speaks at a different rate, so keeping the old
    // number AND the exactness claim would be a confidently wrong label.
    const { el } = await renderApp(
      project({ scenes: [sequenceScene("hello there")] }),
      {
        "library:list": { ok: true, value: { rows: [videoCapture("cap_a")] } },
        "sizzle:loadSequenceSceneAudio": {
          ok: true,
          value: {
            cached: true,
            audioBase64: "AA==",
            mimeType: "audio/mpeg",
            transcriptPhrases: [],
            durationSec: 19
          }
        }
      }
    );
    const render = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]');
    expect(render?.textContent).toBe("Render · 0:19");

    const settings = el.querySelector<HTMLButtonElement>(
      '[data-testid="sizzle-reel-settings-toggle"]'
    );
    await act(async () => settings?.click());
    const voice = [...el.querySelectorAll<HTMLSelectElement>("select")].find(
      (s) => s.value === "onyx"
    );
    if (voice === undefined) throw new Error("voice select not found");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value"
      )!.set!;
      setValue.call(voice, "nova");
      voice.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // 2 words at 160 wpm = 0.75s, floored to the 1s minimum.
    expect(render?.textContent).toBe("Render · ~0:01");
  });

  test("ignores a zero-length cached measurement instead of calling it exact", async () => {
    // A failed duration probe writes `durationSec: 0` into the timing
    // sidecar, and the read path does not validate it.
    const { el } = await renderApp(
      project({ scenes: [sequenceScene("one two three four")] }),
      {
        "library:list": { ok: true, value: { rows: [videoCapture("cap_a")] } },
        "sizzle:loadSequenceSceneAudio": {
          ok: true,
          value: {
            cached: true,
            audioBase64: "AA==",
            mimeType: "audio/mpeg",
            transcriptPhrases: [],
            durationSec: 0
          }
        }
      }
    );
    const render = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]');
    // Falls through to the word-count estimate (4 words = 1.5s), NOT an
    // exact zero-second scene.
    expect(render?.textContent).toBe("Render · ~0:02");
  });

  test("keeps a bare Render label when the reel has no scenes", async () => {
    const { el } = await renderApp(project({ scenes: [] }));
    const render = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]');
    expect(render?.textContent).toBe("Render");
    expect(render?.disabled).toBe(true);
  });
});

describe("SizzleApp shell layout", () => {
  test("with a reel open the project rail is a dropdown under the crumb; picking a reel closes it", async () => {
    const first = project({ id: "p1", name: "First reel" });
    const second = project({ id: "p2", name: "Second reel" });
    const { el } = await renderApp([first, second]);
    const shell = el.querySelector(".szl")!;
    expect(shell.classList.contains("szl--rail-popover")).toBe(true);
    expect(shell.classList.contains("is-rail-open")).toBe(false);
    const rail = el.querySelector("#szl-rail")!;
    expect(rail.getAttribute("aria-hidden")).toBe("true");

    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-rail-toggle"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      toggle.click();
    });
    expect(shell.classList.contains("is-rail-open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rail.getAttribute("aria-hidden")).toBeNull();

    // Picking a reel from the dropdown lands on it and closes the rail.
    await act(async () => {
      clickProjectRow(el.querySelector('[data-testid="sizzle-projects-list"]'), "Second reel");
    });
    expect(titleValue(el)).toBe("Second reel");
    expect(shell.classList.contains("is-rail-open")).toBe(false);
  });

  test("⌘⇧L is ignored while typing in the editor", async () => {
    const { el } = await renderApp(project());
    const shell = el.querySelector(".szl")!;
    const box = scriptBox(el);
    box.focus();
    await act(async () => {
      box.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "L",
          metaKey: true,
          shiftKey: true,
          bubbles: true
        })
      );
    });
    expect(shell.classList.contains("is-rail-open")).toBe(false);
  });

  test("Esc closes the rail dropdown; ⌘⇧L toggles it", async () => {
    const { el } = await renderApp(project());
    const shell = el.querySelector(".szl")!;
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "L", metaKey: true, shiftKey: true, bubbles: true })
      );
    });
    expect(shell.classList.contains("is-rail-open")).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(shell.classList.contains("is-rail-open")).toBe(false);
  });

  test("win32 uses Ctrl+Shift+L and ignores Command+Shift+L", async () => {
    const { el } = await renderApp(project(), {}, "win32");
    const shell = el.querySelector(".szl")!;
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "L", metaKey: true, shiftKey: true, bubbles: true })
      );
    });
    expect(shell.classList.contains("is-rail-open")).toBe(false);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "L",
          metaKey: true,
          ctrlKey: true,
          shiftKey: true,
          bubbles: true
        })
      );
    });
    expect(shell.classList.contains("is-rail-open")).toBe(false);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "L", ctrlKey: true, shiftKey: true, bubbles: true })
      );
    });
    expect(shell.classList.contains("is-rail-open")).toBe(true);
  });

  test("the chat pane resizes by dragging its divider (left widens), clamped, and double-click resets", async () => {
    resetSizzleChatWidthForTests();
    const { el } = await renderApp(project());
    const chat = el.querySelector<HTMLElement>(".szl__chat")!;
    expect(chat.style.flexBasis).toBe("400px");
    const grip = el.querySelector<HTMLElement>('[data-testid="sizzle-chat-resizer"]')!;
    // jsdom lacks pointer capture — stub it.
    grip.setPointerCapture = () => undefined;
    grip.releasePointerCapture = () => undefined;
    // `buttons: 1` mirrors a real drag — the resizer treats buttons === 0
    // as "the gesture ended" so a lost capture can't leave it sticky.
    const pointer = (type: string, clientX: number): void => {
      grip.dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX, buttons: 1, button: 0 }) as unknown as PointerEvent
      );
    };
    await act(async () => {
      pointer("pointerdown", 1000);
      pointer("pointermove", 900); // drag left 100px → wider
    });
    expect(chat.style.flexBasis).toBe("500px");
    await act(async () => {
      pointer("pointermove", 200); // way past max → clamped
      pointer("pointerup", 200);
    });
    expect(chat.style.flexBasis).toBe("720px");
    await act(async () => {
      grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(chat.style.flexBasis).toBe("400px");
    resetSizzleChatWidthForTests();
  });

  test("a cancelled drag does not leave the resizer stuck in drag mode", async () => {
    resetSizzleChatWidthForTests();
    const { el } = await renderApp(project());
    const chat = el.querySelector<HTMLElement>(".szl__chat")!;
    const grip = el.querySelector<HTMLElement>('[data-testid="sizzle-chat-resizer"]')!;
    grip.setPointerCapture = () => undefined;
    grip.releasePointerCapture = () => undefined;
    const send = (type: string, clientX: number, buttons = 1): void => {
      grip.dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX, buttons, button: 0 }) as unknown as PointerEvent
      );
    };
    await act(async () => {
      send("pointerdown", 1000);
      send("pointermove", 950);
    });
    expect(chat.style.flexBasis).toBe("450px");
    // Gesture ends without a pointerup (OS cancel / lost capture).
    await act(async () => {
      grip.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true }) as unknown as PointerEvent);
      send("pointermove", 400, 0); // plain hover, no button held
    });
    expect(chat.style.flexBasis).toBe("450px");
    resetSizzleChatWidthForTests();
  });

  test("reel settings hide behind a summary chip and disclose on click", async () => {
    const { el } = await renderApp(project({ voice: "onyx", resolution: "720p" }));
    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-reel-settings-toggle"]')!;
    expect(toggle.textContent).toContain("onyx");
    expect(toggle.textContent).toContain("OpenAI");
    expect(toggle.textContent).toContain("720p");
    const fields = el.querySelector<HTMLElement>("#szl-reel-settings")!;
    expect(fields.hidden).toBe(true);
    await act(async () => {
      toggle.click();
    });
    expect(fields.hidden).toBe(false);
    expect(fields.querySelectorAll("select")).toHaveLength(3);
  });
});

describe("sequence waveform", () => {
  test("renders the idle baseline until a preview decodes the narration", async () => {
    const sequence = scene({
      kind: "sequence",
      scriptLine: "show this then the next screen",
      narration: "show this then the next screen",
      beats: [
        {
          id: "bt_1",
          captureId: "cap_a",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        {
          id: "bt_2",
          captureId: "cap_b",
          timing: { kind: "phrase", phrase: "", occurrence: 1, offsetSec: 0, durationSec: null },
          mediaTrim: null,
          transition: "crossfade",
          videoFit: "smart-fit"
        }
      ]
    });
    // Default mock: the cache-only load reports a miss, so the proactive
    // loader finds nothing and the honest flat baseline stays.
    const { el } = await renderApp(project({ scenes: [sequence] }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(el.querySelector('[data-testid="sizzle-timeline-wave-idle-0"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="sizzle-timeline-wave-0"]')).toBeNull();
  });

  test("loads the waveform on open from already-cached audio, no Play click", async () => {
    const sequence = scene({
      kind: "sequence",
      scriptLine: "show this then the next screen",
      narration: "show this then the next screen",
      beats: [
        {
          id: "bt_1",
          captureId: "cap_a",
          timing: { kind: "offset", startSec: 0, endSec: null },
          mediaTrim: null,
          transition: "cut",
          videoFit: "smart-fit"
        },
        {
          id: "bt_2",
          captureId: "cap_b",
          timing: { kind: "phrase", phrase: "", occurrence: 1, offsetSec: 0, durationSec: null },
          mediaTrim: null,
          transition: "crossfade",
          videoFit: "smart-fit"
        }
      ]
    });
    const { el, dispatch } = await renderApp(project({ scenes: [sequence] }), {
      "sizzle:loadSequenceSceneAudio": {
        ok: true,
        value: {
          cached: true,
          audioBase64: "AA==",
          mimeType: "audio/mpeg",
          transcriptPhrases: [
            {
              text: "the next screen",
              startSec: 1.5,
              endSec: 2.4,
              wordStartIndex: 3,
              wordEndIndex: 5
            }
          ],
          durationSec: 4,
          words: []
        }
      }
    });
    // Let the bounded-concurrency queue drain (enqueue → fetch → setState).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The waveform was filled from the cache-only verb proactively — never
    // the expensive previewSequenceScenePlan, and without a ▶ click.
    expect(dispatch).toHaveBeenCalledWith("sizzle:loadSequenceSceneAudio", {
      projectId: "sz_1",
      sceneId: "sc_a"
    });
    expect(dispatch).not.toHaveBeenCalledWith("sizzle:previewSequenceScenePlan", {
      projectId: "sz_1",
      sceneId: "sc_a"
    });
    expect(el.querySelector('[data-testid="sizzle-timeline-wave-0"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="sizzle-timeline-wave-idle-0"]')).toBeNull();
    await selectClip(el, "bt_2");
    const phrasePicker = el.querySelector<HTMLButtonElement>(".szl__sequence-phrase-button");
    expect(phrasePicker?.textContent).toContain("Choose transcript phrase");
    await act(async () => {
      phrasePicker?.click();
    });
    expect(el.querySelector(".szl__sequence-phrase-option")?.textContent).toContain("the next screen");
  });
});

describe("auto beat timing UI", () => {
  test("converting a scene to a sequence seeds an auto beat (R4)", async () => {
    const { el } = await renderApp(project({ scenes: [scene({ scriptLine: "narration here" })] }));
    await act(async () => {
      findButton(el, "Convert to clips").click();
    });
    // One clip on the timeline; selecting it opens the inspector, where the
    // first clip reads as pinned at 0 (its seeded timing is auto).
    const clip = el.querySelector<HTMLButtonElement>('[data-testid^="sizzle-timeline-clip-"]');
    expect(clip).not.toBeNull();
    await act(async () => {
      clip!.click();
    });
    expect(inspectorTiming(el)).toBe("pinned");
    expect(el.querySelector('[data-testid="sizzle-inspector-start"]')).toBeNull();
    expect(el.querySelector(".szl__sequence-phrase-button")).toBeNull();
  });

  test("an auto beat shows the timing select but no start/length/phrase inputs (R9)", async () => {
    const sequence = scene({
      kind: "sequence",
      scriptLine: "show this then the next screen",
      narration: "show this then the next screen",
      beats: [
        { id: "bt_1", captureId: "cap_a", timing: { kind: "auto" }, mediaTrim: null, transition: "cut", videoFit: "smart-fit" },
        { id: "bt_2", captureId: "cap_b", timing: { kind: "auto" }, mediaTrim: null, transition: "cut", videoFit: "smart-fit" }
      ]
    });
    const { el } = await renderApp(project({ scenes: [sequence] }));
    expect(el.querySelectorAll('[data-testid^="sizzle-timeline-clip-"]')).toHaveLength(2);
    // The 2nd (non-first) auto clip: the inspector offers Auto · Word ·
    // Offset with Auto pressed, and renders no value inputs.
    await selectClip(el, "bt_2");
    expect(inspectorTiming(el)).toBe("auto");
    expect(el.querySelector('[data-testid="sizzle-inspector-start"]')).toBeNull();
    expect(el.querySelector('[data-testid="sizzle-inspector-offset"]')).toBeNull();
    expect(el.querySelector(".szl__sequence-phrase")).toBeNull();
  });
});

describe("beat reorder", () => {
  const autoBeat = (id: string, captureId: string): NonNullable<SizzleScene["beats"]>[number] => ({
    id,
    captureId,
    timing: { kind: "auto" },
    mediaTrim: null,
    transition: "cut",
    videoFit: "smart-fit"
  });
  const seq = (): SizzleScene =>
    scene({
      kind: "sequence",
      scriptLine: "n",
      narration: "n",
      beats: [autoBeat("bt_a", "cap_a"), autoBeat("bt_b", "cap_b"), autoBeat("bt_c", "cap_c")]
    });
  // Clip order as the TIMELINE draws it (beat ids, left to right).
  const order = (el: HTMLElement): string[] =>
    [...el.querySelectorAll('[data-testid^="sizzle-timeline-clip-"]')].map((n) =>
      (n.getAttribute("data-testid") ?? "").replace("sizzle-timeline-clip-", "")
    );
  const moveLater = async (el: HTMLElement): Promise<void> => {
    const later = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-inspector-move-later"]');
    if (later === null) throw new Error("inspector 'Move clip later' not found");
    await act(async () => {
      later.click();
    });
  };

  test("the inspector's ▶ moves the selected clip later via a from→to splice", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }));
    expect(order(el)).toEqual(["bt_a", "bt_b", "bt_c"]);
    await selectClip(el, "bt_a");
    await moveLater(el);
    expect(order(el)).toEqual(["bt_b", "bt_a", "bt_c"]);
  });

  test("moving a clip later twice walks it to the end — splice-and-insert, not swap", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }));
    await selectClip(el, "bt_a");
    await moveLater(el); // [b, a, c] — the selection follows the clip
    await moveLater(el); // [b, c, a] (a swap of 0↔2 would give [c, b, a])
    expect(order(el)).toEqual(["bt_b", "bt_c", "bt_a"]);
  });

  test("◀ is disabled on the first clip and ▶ on the last: no-op moves are not offered", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }));
    await selectClip(el, "bt_a");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="sizzle-inspector-move-earlier"]')?.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="sizzle-inspector-move-later"]')?.disabled).toBe(false);
    await selectClip(el, "bt_c");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="sizzle-inspector-move-later"]')?.disabled).toBe(true);
    expect(order(el)).toEqual(["bt_a", "bt_b", "bt_c"]);
  });

  test("⌘Z restores a reorder and ⌘⇧Z re-applies it (AE16)", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }));
    const fireKey = (shift: boolean): void => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          metaKey: true,
          shiftKey: shift,
          bubbles: true,
          cancelable: true
        })
      );
    };
    // reorder: first clip later → [b, a, c]
    await selectClip(el, "bt_a");
    await moveLater(el);
    expect(order(el)).toEqual(["bt_b", "bt_a", "bt_c"]);
    await act(async () => {
      fireKey(false); // ⌘Z → undo
    });
    expect(order(el)).toEqual(["bt_a", "bt_b", "bt_c"]);
    await act(async () => {
      fireKey(true); // ⌘⇧Z → redo
    });
    expect(order(el)).toEqual(["bt_b", "bt_a", "bt_c"]);
  });

  test("an external (chat) scenes change drops local undo history — no ⌘Z clobber", async () => {
    const { el, emit } = await renderApp(project({ scenes: [seq()] }));
    // local reorder → an undo entry + a pending debounced write
    await selectClip(el, "bt_a");
    await moveLater(el);
    expect(order(el)).toEqual(["bt_b", "bt_a", "bt_c"]);
    // let the debounced write flush so the project is no longer "pending"
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    // an external actor (the chat agent) reorders differently and broadcasts
    const external = project({
      scenes: [
        scene({
          kind: "sequence",
          scriptLine: "n",
          narration: "n",
          beats: [autoBeat("bt_c", "cap_c"), autoBeat("bt_b", "cap_b"), autoBeat("bt_a", "cap_a")]
        })
      ]
    });
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, { projects: [external] });
    });
    expect(order(el)).toEqual(["bt_c", "bt_b", "bt_a"]);
    // ⌘Z must NOT restore the pre-reorder order — the stale history was dropped.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })
      );
    });
    expect(order(el)).toEqual(["bt_c", "bt_b", "bt_a"]);
  });
});

describe("scene transition chip", () => {
  test("offers every transition type, not just cut and crossfade, and writes the object form", async () => {
    const { el } = await renderApp(
      project({
        scenes: [scene({ id: "sc_a", captureId: "cap_a" }), scene({ id: "sc_b", captureId: "cap_b" })]
      })
    );
    const select = el.querySelector<HTMLSelectElement>('[data-testid="sizzle-scene-transition-1"]');
    expect(select).not.toBeNull();
    expect([...select!.options].map((o) => o.value)).toEqual([
      "none",
      "cut",
      "crossfade",
      "dip-black",
      "dip-white",
      "push-left",
      "slide-left",
      "zoom-cut"
    ]);
    expect(select!.value).toBe("crossfade");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "push-left");
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select!.value).toBe("push-left");
    // Fade-like types light the chip in accent; a hard cut does not.
    expect(select!.closest(".szl__transition")?.classList.contains("szl__transition--fade")).toBe(true);
  });
});

// ── Characterization tests for the shell surfaces the component extraction
// moves (project rail + context menu, editor head, capture picker, render
// footer, simple-scene card). Written against the pre-extraction DOM so the
// refactor has something to keep green.
describe("characterization — shell surfaces", () => {
  /** Drain the microtasks an async click handler chains after its first
   *  `await dispatch(...)` so the state it sets afterwards is rendered. */
  const drain = async (): Promise<void> => {
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
  };

  test("no projects: the empty pane renders and the rail invites creation", async () => {
    const { el } = await renderApp([]);
    expect(el.querySelector(".szl__empty-pane")?.textContent).toContain("Sizzle Reels");
    expect(el.querySelector(".szl__list--projects")?.textContent).toContain("No projects yet");
    expect(el.querySelector(".szl__editor")).toBeNull();
  });

  test("an invalid project file is visible and Retry load recovers after repair", async () => {
    const loaded = project({ name: "Recovered Reel" });
    let attempts = 0;
    const { el, dispatch } = await renderApp([loaded], {
      "sizzle:list": () => {
        attempts += 1;
        return attempts === 1
          ? {
              ok: false,
              error: {
                kind: "persistence",
                code: "sizzle_project_file_invalid",
                message: "the original was preserved in a corrupt-file backup"
              }
            }
          : { ok: true, value: { projects: [loaded] } };
      }
    });

    const firstAlert = el.querySelector<HTMLElement>('[role="alert"].szl__failure-notice');
    expect(firstAlert?.textContent).toContain(
      "Could not load Sizzle Reels: the original was preserved in a corrupt-file backup"
    );
    expect(findButton(el, "+ New Sizzle Reel").disabled).toBe(true);
    expect(el.querySelector(".szl__list--recents")?.textContent).toContain(
      "Projects are unavailable."
    );

    await act(async () => {
      findButton(el, "Retry load").click();
    });
    await drain();

    expect(
      dispatch.mock.calls.filter(([name]) => name === "sizzle:list")
    ).toHaveLength(2);
    expect(el.querySelector('[role="alert"].szl__failure-notice')).toBeNull();
    expect(titleValue(el)).toBe("Recovered Reel");
    expect(findButton(el, "+ New Sizzle Reel").disabled).toBe(false);
  });

  test("a failed create is actionable and Try again creates the reel", async () => {
    const fresh = project({ id: "sz_new", name: "Untitled Sizzle" });
    let attempts = 0;
    const { el, dispatch } = await renderApp([], {
      "sizzle:create": () => {
        attempts += 1;
        return attempts === 1
          ? {
              ok: false,
              error: {
                kind: "persistence",
                code: "sizzle_create_failed",
                message: "project directory is read-only"
              }
            }
          : { ok: true, value: fresh };
      }
    });

    await act(async () => {
      findButton(el, "+ New Sizzle Reel").click();
    });
    await drain();

    const alert = el.querySelector<HTMLElement>('[role="alert"].szl__failure-notice');
    expect(alert?.textContent).toContain(
      "Could not create the reel: project directory is read-only"
    );
    expect(el.querySelector(".szl__editor")).toBeNull();

    await act(async () => {
      findButton(el, "Try again").click();
    });
    await drain();

    expect(
      dispatch.mock.calls.filter(([name]) => name === "sizzle:create")
    ).toHaveLength(2);
    expect(el.querySelector('[role="alert"].szl__failure-notice')).toBeNull();
    expect(titleValue(el)).toBe("Untitled Sizzle");
  });

  test("+ New Sizzle Reel creates, selects, and focuses the title of the new reel", async () => {
    const fresh = project({ id: "sz_new", name: "Untitled Sizzle" });
    const store = [project()];
    const { el, dispatch } = await renderApp(store, {
      // Mirror the committed store even though this harness does not emit
      // the main process's projects-changed broadcast for create.
      "sizzle:create": () => {
        store.unshift(fresh);
        return { ok: true, value: fresh };
      }
    });
    await act(async () => {
      findButton(el, "+ New Sizzle Reel").click();
    });
    await drain();
    expect(dispatch).toHaveBeenCalledWith("sizzle:create", { name: "Untitled Sizzle" });
    expect(titleValue(el)).toBe("Untitled Sizzle");
    expect(document.activeElement).toBe(el.querySelector(".szl__editor-title"));
  });

  test("right-clicking a project row opens Open / Duplicate; Esc closes it; Duplicate dispatches", async () => {
    const copy = project({ id: "sz_copy", name: "Demo Reel copy" });
    const store = projects(2);
    const { el, dispatch } = await renderApp(store, {
      "sizzle:duplicate": () => {
        store.unshift(copy);
        return { ok: true, value: copy };
      }
    });
    const row = el.querySelector<HTMLElement>(".szl__row-wrap");
    expect(row).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    });
    const menu = el.querySelector(".szl__context-menu");
    expect(menu).not.toBeNull();
    expect([...menu!.querySelectorAll("[role=menuitem]")].map((b) => b.textContent)).toEqual(["Open", "Duplicate"]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(el.querySelector(".szl__context-menu")).toBeNull();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    });
    await act(async () => {
      findButton(el, "Duplicate").click();
    });
    await drain();
    expect(dispatch).toHaveBeenCalledWith("sizzle:duplicate", { id: "sz_1" });
    // The copy becomes the active reel.
    expect(titleValue(el)).toBe("Demo Reel copy");
  });

  test("a failed duplicate preserves the source reel and Try again selects the copy", async () => {
    const copy = project({ id: "sz_copy", name: "Demo Reel copy" });
    let attempts = 0;
    const { el, dispatch } = await renderApp(project(), {
      "sizzle:duplicate": () => {
        attempts += 1;
        return attempts === 1
          ? {
              ok: false,
              error: {
                kind: "persistence",
                code: "sizzle_duplicate_failed",
                message: "copy could not be written"
              }
            }
          : { ok: true, value: copy };
      }
    });

    await act(async () => {
      findButton(el, "Duplicate").click();
    });
    await drain();

    expect(titleValue(el)).toBe("Demo Reel");
    expect(
      el.querySelector<HTMLElement>('[role="alert"].szl__failure-notice')?.textContent
    ).toContain("Could not duplicate the reel: copy could not be written");

    await act(async () => {
      findButton(el, "Try again").click();
    });
    await drain();

    expect(
      dispatch.mock.calls.filter(([name]) => name === "sizzle:duplicate")
    ).toHaveLength(2);
    expect(el.querySelector('[role="alert"].szl__failure-notice')).toBeNull();
    expect(titleValue(el)).toBe("Demo Reel copy");
  });

  test("the editor exposes dirty, saving, failed, and recovered save states", async () => {
    const initial = project();
    const pendingUpdates: Array<(result: unknown) => void> = [];
    const { el, dispatch } = await renderApp(initial, {
      "sizzle:update": () =>
        new Promise<unknown>((resolve) => {
          pendingUpdates.push(resolve);
        })
    });
    const title = el.querySelector<HTMLInputElement>(".szl__editor-title");
    if (title === null) throw new Error("editor title not found");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set!;
      setter.call(title, "Unsaved title");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.querySelector('[data-testid="sizzle-save-state"]')?.textContent).toBe(
      "Unsaved changes"
    );

    await act(async () => {
      findButton(el, "Duplicate").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pendingUpdates).toHaveLength(1);
    expect(el.querySelector('[data-testid="sizzle-save-state"]')?.textContent).toBe(
      "Saving…"
    );

    await act(async () => {
      pendingUpdates[0]!({
        ok: false,
        error: {
          kind: "persistence",
          code: "sizzle_update_failed",
          message: "project file is locked"
        }
      });
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    expect(
      el.querySelector<HTMLElement>('[data-testid="sizzle-save-state"]')?.textContent
    ).toContain("Save failed: project file is locked");
    expect(
      dispatch.mock.calls.filter(([name]) => name === "sizzle:duplicate")
    ).toHaveLength(0);

    await act(async () => {
      findButton(el, "Retry save").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pendingUpdates).toHaveLength(2);
    expect(el.querySelector('[data-testid="sizzle-save-state"]')?.textContent).toBe(
      "Saving…"
    );

    await act(async () => {
      pendingUpdates[1]!({
        ok: true,
        value: { ...initial, name: "Unsaved title", modifiedAt: "2026-08-23T12:01:00.000Z" }
      });
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="sizzle-save-state"]')?.textContent).toBe(
      "Saved"
    );
  });

  test("the editor's Delete confirms, dispatches, and falls back to another reel", async () => {
    const confirm = vi.spyOn(window, "confirm").mockImplementation(() => true);
    try {
      const { el, dispatch } = await renderApp(projects(2), {
        "sizzle:delete": { ok: true, value: undefined }
      });
      expect(titleValue(el)).toBe("Reel 1");
      await act(async () => {
        findButton(el, "Delete").click();
      });
      await drain();
      expect(confirm).toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith("sizzle:delete", { id: "sz_1" });
      expect(titleValue(el)).toBe("Reel 2");
    } finally {
      confirm.mockRestore();
    }
  });

  test("a failed delete preserves the active reel and Try again deletes it", async () => {
    const confirm = vi.spyOn(window, "confirm").mockImplementation(() => true);
    let attempts = 0;
    try {
      const { el, dispatch } = await renderApp(projects(2), {
        "sizzle:delete": () => {
          attempts += 1;
          return attempts === 1
            ? {
                ok: false,
                error: {
                  kind: "persistence",
                  code: "sizzle_delete_failed",
                  message: "project file is locked"
                }
              }
            : { ok: true, value: undefined };
        }
      });

      await act(async () => {
        findButton(el, "Delete").click();
      });
      await drain();

      expect(titleValue(el)).toBe("Reel 1");
      expect(
        el.querySelector<HTMLElement>('[role="alert"].szl__failure-notice')?.textContent
      ).toContain("Could not delete the reel: project file is locked");

      await act(async () => {
        findButton(el, "Try again").click();
      });
      await drain();

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(
        dispatch.mock.calls.filter(([name]) => name === "sizzle:delete")
      ).toHaveLength(2);
      expect(el.querySelector('[role="alert"].szl__failure-notice')).toBeNull();
      expect(titleValue(el)).toBe("Reel 2");
    } finally {
      confirm.mockRestore();
    }
  });

  test("render progress events drive the Render button and footer; Reveal in Finder dispatches", async () => {
    const { el, emit, dispatch } = await renderApp(
      project({ outputPath: "/tmp/out.mp4", scenes: [scene({ scriptLine: "hi" })] })
    );
    const render = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]')!;
    expect(render.textContent?.startsWith("Render")).toBe(true);
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleRenderProgress, {
        projectId: "sz_1",
        phase: "tts",
        message: "Synthesizing",
        ratio: 0.4
      });
    });
    expect(render.textContent).toBe("Rendering… 40%");
    expect(render.disabled).toBe(true);
    expect(el.querySelector(".szl__status-bar-fill")).not.toBeNull();
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleRenderProgress, {
        projectId: "sz_1",
        phase: "done",
        message: "Done",
        ratio: 1
      });
    });
    expect(el.querySelector(".szl__status--ok")?.textContent).toBe("Render complete.");
    await act(async () => {
      findButton(el, "Reveal in Finder").click();
    });
    expect(dispatch).toHaveBeenCalledWith("sizzle:revealOutput", { id: "sz_1" });
  });

  test("a failed reveal is actionable and Try again clears the alert on success", async () => {
    let attempts = 0;
    const { el, dispatch } = await renderApp(
      project({ outputPath: "/tmp/out.mp4", scenes: [scene({ scriptLine: "hi" })] }),
      {
        "sizzle:revealOutput": () => {
          attempts += 1;
          return attempts === 1
            ? {
                ok: false,
                error: {
                  kind: "persistence",
                  code: "sizzle_reveal_failed",
                  message: "rendered output is missing"
                }
              }
            : { ok: true, value: undefined };
        }
      }
    );

    await act(async () => {
      findButton(el, "Reveal in Finder").click();
    });
    await drain();

    expect(
      el.querySelector<HTMLElement>('[role="alert"].szl__failure-notice')?.textContent
    ).toContain("Could not reveal the rendered output: rendered output is missing");
    expect(titleValue(el)).toBe("Demo Reel");

    await act(async () => {
      findButton(el, "Try again").click();
    });
    await drain();

    expect(
      dispatch.mock.calls.filter(([name]) => name === "sizzle:revealOutput")
    ).toHaveLength(2);
    expect(el.querySelector('[role="alert"].szl__failure-notice')).toBeNull();
    expect(titleValue(el)).toBe("Demo Reel");
  });

  test("+ Add scene opens the capture picker; picking a capture appends a sequence scene", async () => {
    const { el, dispatch } = await renderApp(project({ scenes: [] }), {
      "library:list": { ok: true, value: { rows: [videoCapture("cap_v")] } },
      "codex:enrichment": { ok: true, value: null }
    });
    expect(el.querySelector(".szl__scene-empty")).not.toBeNull();
    await act(async () => {
      findButton(el, "+ Add scene").click();
    });
    const cell = el.querySelector<HTMLButtonElement>(".szl__modal .szl__picker-cell");
    expect(cell).not.toBeNull();
    await act(async () => {
      cell!.click();
    });
    await drain();
    expect(dispatch).toHaveBeenCalledWith("codex:enrichment", { captureId: "cap_v" });
    expect(el.querySelector(".szl__modal")).toBeNull();
    const cards = el.querySelectorAll(".szl__scene");
    expect(cards.length).toBe(1);
    expect(cards[0]!.classList.contains("szl__scene--sequence")).toBe(true);
    expect(el.querySelector('[data-testid^="sizzle-timeline-clip-"]')?.getAttribute("aria-label")).toBe("Clip 1, Video cap_v");
  });

  test("a legacy simple video scene shows trim + audio controls seeded from the capture", async () => {
    const { el } = await renderApp(
      project({ scenes: [scene({ captureId: "cap_v", scriptLine: "" })] }),
      { "library:list": { ok: true, value: { rows: [videoCapture("cap_v", { start: 1, end: 4 })] } } }
    );
    const numbers = [...el.querySelectorAll<HTMLInputElement>(".szl__scene-dur input[type=number]")];
    expect(numbers.map((n) => n.value)).toEqual(["1", "4"]);
    const audio = el.querySelector<HTMLSelectElement>(".szl__scene-dur select");
    expect([...audio!.options].map((o) => o.value)).toEqual(["auto", "native", "voiceover", "muted"]);
    expect(audio!.options[0]!.textContent).toBe("Auto (native)");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(numbers[0], "2");
      numbers[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.querySelector<HTMLInputElement>(".szl__scene-dur input[type=number]")!.value).toBe("2");
    expect(findButton(el, "Convert to clips")).toBeTruthy();
  });

  test("Hide chat removes the chat pane and flips the toggle label", async () => {
    const { el } = await renderApp(project());
    expect(el.querySelector(".szl__chat")).not.toBeNull();
    await act(async () => {
      findButton(el, "Hide chat").click();
    });
    expect(el.querySelector(".szl__chat")).toBeNull();
    expect(findButton(el, "Chat with agent")).toBeTruthy();
  });
});

describe("timeline word ribbon — click to anchor", () => {
  const autoBeat = (id: string, captureId: string): NonNullable<SizzleScene["beats"]>[number] => ({
    id,
    captureId,
    timing: { kind: "auto" },
    mediaTrim: null,
    transition: "cut",
    videoFit: "smart-fit"
  });
  // 8 words over 4 s, resolved from the speech-timing cache on open.
  const WORDS = ["Open", "the", "Library", "to", "find", "every", "capture", "fast"].map((word, index) => ({
    index,
    word,
    normalized: word.toLowerCase(),
    startSec: index * 0.5,
    endSec: index * 0.5 + 0.4
  }));
  const cachedAudio = {
    ok: true,
    value: {
      cached: true,
      audioBase64: "AA==",
      mimeType: "audio/mpeg",
      transcriptPhrases: [],
      durationSec: 4,
      words: WORDS
    }
  };
  const seq = (): SizzleScene =>
    scene({
      kind: "sequence",
      scriptLine: "Open the Library to find every capture fast",
      narration: "Open the Library to find every capture fast",
      beats: [autoBeat("bt_a", "cap_a"), autoBeat("bt_b", "cap_b"), autoBeat("bt_c", "cap_c")]
    });
  test("clicking a word anchors the clip covering that moment (not clip 0), and clicking it again un-anchors", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }), {
      "sizzle:loadSequenceSceneAudio": cachedAudio
    });
    // Wait for the cache-only load to land: the ribbon draws words.
    for (let i = 0; i < 10 && el.querySelector('[data-testid="sizzle-timeline-word-0-4"]') === null; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    const find = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-word-0-4"]');
    expect(find).not.toBeNull();
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')).toBeNull(); // nothing selected yet
    // "find" is at 2.0 s — inside clip 2 (auto clips split 4 s three ways:
    // 0–1.33, 1.33–2.67, 2.67–4). The click anchors it AND selects it, so
    // the inspector opens on clip 2.
    await act(async () => {
      find!.click();
    });
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')?.textContent).toContain("Clip 2 of 3");
    expect(inspectorTiming(el)).toBe("phrase");
    expect(el.querySelector(".szl__sequence-phrase-button")?.textContent).toContain("find");
    // The anchored word now carries the clip's badge in the ribbon.
    expect(el.querySelector('[data-testid="sizzle-timeline-word-0-4"] .szt__badge')?.textContent).toBe("2");
    // Clicking the same word again releases the anchor — back to auto.
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-word-0-4"]')!.click();
    });
    expect(inspectorTiming(el)).toBe("auto");
  });

  test("with a clip selected, the click anchors THAT clip; clip 0 is never anchored", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }), {
      "sizzle:loadSequenceSceneAudio": cachedAudio
    });
    for (let i = 0; i < 10 && el.querySelector('[data-testid="sizzle-timeline-word-0-2"]') === null; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    // Select clip 3, then click "Library" (1.0 s, which is inside clip 1).
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-clip-bt_c"]')!.click();
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-word-0-2"]')!.click();
    });
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')?.textContent).toContain("Clip 3 of 3");
    expect(inspectorTiming(el)).toBe("phrase");
    // Selecting clip 0 and clicking a word is a no-op: clip 0 is pinned to 0.
    await selectClip(el, "bt_a");
    expect(inspectorTiming(el)).toBe("pinned");
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-word-0-0"]')!.click();
    });
    expect(inspectorTiming(el)).toBe("pinned");
    expect(el.querySelector('[data-testid="sizzle-timeline-word-0-0"] .szt__badge')).toBeNull();
  });

  test("an unsynthesized scene shows the Synthesize affordance instead of words, and it previews the scene", async () => {
    const { el, dispatch } = await renderApp(project({ scenes: [seq()] }));
    expect(el.querySelector('[data-testid^="sizzle-timeline-word-"]')).toBeNull();
    const cta = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-synthesize-0"]');
    expect(cta).not.toBeNull();
    await act(async () => {
      cta!.click();
    });
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(dispatch).toHaveBeenCalledWith("sizzle:previewSequenceScenePlan", { projectId: "sz_1", sceneId: "sc_a" });
  });
});

describe("timeline drag — move / retime commits once", () => {
  // jsdom has no layout: give the timeline a 1000 px strip for this block.
  const realRect = Element.prototype.getBoundingClientRect;
  beforeAll(() => {
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
      const width =
        this.classList.contains("szt__scroll") || this.classList.contains("szt__lanes") ? 1000 : 0;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) } as DOMRect;
    };
  });
  afterAll(() => {
    Element.prototype.getBoundingClientRect = realRect;
  });
  const autoBeat = (id: string, captureId: string): NonNullable<SizzleScene["beats"]>[number] => ({
    id,
    captureId,
    timing: { kind: "auto" },
    mediaTrim: null,
    transition: "cut",
    videoFit: "smart-fit"
  });
  // 8 words over 4 s, resolved from the speech-timing cache on open.
  const WORDS = ["Open", "the", "Library", "to", "find", "every", "capture", "fast"].map((word, index) => ({
    index,
    word,
    normalized: word.toLowerCase(),
    startSec: index * 0.5,
    endSec: index * 0.5 + 0.4
  }));
  const cachedAudio = {
    ok: true,
    value: {
      cached: true,
      audioBase64: "AA==",
      mimeType: "audio/mpeg",
      transcriptPhrases: [],
      durationSec: 4,
      words: WORDS
    }
  };
  const seq = (): SizzleScene =>
    scene({
      kind: "sequence",
      scriptLine: "Open the Library to find every capture fast",
      narration: "Open the Library to find every capture fast",
      beats: [autoBeat("bt_a", "cap_a"), autoBeat("bt_b", "cap_b"), autoBeat("bt_c", "cap_c")]
    });
  const pointer = async (target: Element, type: string, clientX: number): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX }));
    });
  };

  test("dragging a boundary writes ONE scenes patch — a phrase anchor on the nearest word + residual — and ⌘Z undoes it in one step", async () => {
    const { el, dispatch } = await renderApp(project({ scenes: [seq()] }), {
      "sizzle:loadSequenceSceneAudio": cachedAudio
    });
    // Wait for the cache-only load: the lane is resolved and has grips.
    for (let i = 0; i < 10 && el.querySelector('[data-testid="sizzle-timeline-grip-bt_b"]') === null; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    const grip = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-grip-bt_b"]');
    expect(grip).not.toBeNull();
    const lanes = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-lanes"]')!;
    // 4 s over 1000 px = 250 px/s. Auto clips split 4 s three ways, so clip
    // 2 starts at 1.333 s (333 px). Drag its boundary to 2.0 s (500 px):
    // "find" starts at exactly 2.0 s → phrase "find", no residual.
    await pointer(grip!, "pointerdown", 333);
    await pointer(lanes, "pointermove", 420);
    await pointer(lanes, "pointermove", 500);
    // Nothing written mid-drag.
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:update")).toHaveLength(0);
    await pointer(lanes, "pointerup", 500);
    // The commit selects the dragged clip; the inspector shows the anchor.
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')?.textContent).toContain("Clip 2 of 3");
    expect(inspectorTiming(el)).toBe("phrase");
    expect(el.querySelector(".szl__sequence-phrase-button")?.textContent).toContain("find");
    // The lane re-lays out from the committed anchor through the SAME
    // planner: clip 2 now starts at 2.0 s.
    const clipB = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-clip-bt_b"]')!;
    expect(parseFloat(clipB.style.left)).toBeCloseTo(500, 0);
    expect(clipB.querySelector(".szt__pin")).not.toBeNull();
    // One debounced write carrying the anchor, with the residual field present.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const updates = dispatch.mock.calls.filter(([name]) => name === "sizzle:update");
    expect(updates).toHaveLength(1);
    const payload = updates[0]![1] as { patch?: { scenes?: SizzleScene[] } };
    const beats = payload.patch?.scenes?.[0]?.beats ?? [];
    expect(beats[1]!.timing).toEqual({ kind: "phrase", phrase: "find", occurrence: 1, offsetSec: 0, durationSec: null });
    expect(beats[0]!.timing).toEqual({ kind: "auto" }); // pin only what you touch
    expect(beats[2]!.timing).toEqual({ kind: "auto" });
    // ⌘Z: one step back to auto — the drag did not litter the history.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(inspectorTiming(el)).toBe("auto");
  });
});

import { setSavedChatWidth } from "../ChatResizer";

describe("clip inspector (right-rail drawer)", () => {
  const autoBeat = (
    id: string,
    captureId: string,
    patch: Partial<NonNullable<SizzleScene["beats"]>[number]> = {}
  ): NonNullable<SizzleScene["beats"]>[number] => ({
    id,
    captureId,
    timing: { kind: "auto" },
    mediaTrim: null,
    transition: "cut",
    videoFit: "smart-fit",
    ...patch
  });
  const WORDS = ["Open", "the", "Library", "to", "find", "every", "capture", "fast"].map((word, index) => ({
    index,
    word,
    normalized: word.toLowerCase(),
    startSec: index * 0.5,
    endSec: index * 0.5 + 0.4
  }));
  const cachedAudio = {
    ok: true,
    value: { cached: true, audioBase64: "AA==", mimeType: "audio/mpeg", transcriptPhrases: [], durationSec: 4, words: WORDS }
  };
  const seq = (): SizzleScene =>
    scene({
      kind: "sequence",
      scriptLine: "Open the Library to find every capture fast",
      narration: "Open the Library to find every capture fast",
      beats: [autoBeat("bt_a", "cap_a"), autoBeat("bt_b", "cap_b", { transition: "crossfade" }), autoBeat("bt_c", "cap_c")]
    });
  const lastScenesPatch = (dispatch: { mock: { calls: unknown[][] } }): SizzleScene[] => {
    const updates = dispatch.mock.calls.filter(([name]) => name === "sizzle:update");
    const payload = updates.at(-1)?.[1] as { patch?: { scenes?: SizzleScene[] } } | undefined;
    return payload?.patch?.scenes ?? [];
  };
  const setNumber = async (input: HTMLInputElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const setSelect = async (select: HTMLSelectElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  test("opens beside the chat for the selected clip and closes on ✕, Esc, or bare-track click", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }));
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')).toBeNull();
    await selectClip(el, "bt_b");
    const insp = el.querySelector<HTMLElement>('[data-testid="sizzle-clip-inspector"]');
    expect(insp).not.toBeNull();
    expect(insp!.textContent).toContain("Clip 2 of 3");
    // It lives in the right rail's slot, next to the chat — not in place of it.
    expect(el.querySelector('[data-testid="sizzle-inspector-host"] [data-testid="sizzle-clip-inspector"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="sizzle-chat-panel"]')).not.toBeNull();
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-inspector-close"]')!.click();
    });
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')).toBeNull();
    await selectClip(el, "bt_c");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')).toBeNull();
    await selectClip(el, "bt_c");
    await act(async () => {
      el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-lanes"]')!.click();
    });
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')).toBeNull();
  });

  test("edits the transition INTO the clip — type AND duration — and changing the type keeps a duration the user set", async () => {
    const { el, dispatch } = await renderApp(project({ scenes: [seq()] }));
    await selectClip(el, "bt_b");
    const type = el.querySelector<HTMLSelectElement>('[data-testid="sizzle-inspector-transition"]')!;
    const dur = el.querySelector<HTMLInputElement>('[data-testid="sizzle-inspector-transition-duration"]')!;
    expect([...type.options].map((o) => o.value)).toEqual([
      "none", "cut", "crossfade", "dip-black", "dip-white", "push-left", "slide-left", "zoom-cut"
    ]);
    expect(type.value).toBe("crossfade");
    expect(dur.value).toBe("0.4");
    expect(dur.disabled).toBe(false);
    // Duration is now reachable (plan §4.7 defect 3).
    await setNumber(dur, "0.75");
    expect(el.querySelector<HTMLInputElement>('[data-testid="sizzle-inspector-transition-duration"]')!.value).toBe("0.75");
    // Switching the type carries the user's duration over.
    await setSelect(el.querySelector<HTMLSelectElement>('[data-testid="sizzle-inspector-transition"]')!, "dip-black");
    expect(el.querySelector<HTMLInputElement>('[data-testid="sizzle-inspector-transition-duration"]')!.value).toBe("0.75");
    // A cut has no duration.
    await setSelect(el.querySelector<HTMLSelectElement>('[data-testid="sizzle-inspector-transition"]')!, "cut");
    expect(el.querySelector<HTMLInputElement>('[data-testid="sizzle-inspector-transition-duration"]')!.disabled).toBe(true);
    await setSelect(el.querySelector<HTMLSelectElement>('[data-testid="sizzle-inspector-transition"]')!, "slide-left");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const beats = lastScenesPatch(dispatch)[0]!.beats!;
    expect(beats[1]!.transition).toEqual({ type: "slide-left", durationSec: 0.18 }); // from a cut: the type default
    expect(beats[0]!.transition).toBe("cut");
  });

  test("Word pins the clip where it is (nearest word + residual); Offset pins it at its current start; Auto releases it", async () => {
    const { el, dispatch } = await renderApp(project({ scenes: [seq()] }), {
      "sizzle:loadSequenceSceneAudio": cachedAudio
    });
    for (let i = 0; i < 10 && el.querySelector('[data-testid="sizzle-timeline-word-0-3"]') === null; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    await selectClip(el, "bt_b"); // auto, at 1.333 s (4 s split three ways)
    expect(inspectorTiming(el)).toBe("auto");
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-inspector-timing-phrase"]')!.click();
    });
    // Nearest word to 1.333 s is "to" (1.5 s): residual −0.167, so the clip does not move.
    expect(inspectorTiming(el)).toBe("phrase");
    expect(el.querySelector(".szl__sequence-phrase-button")?.textContent).toContain("to");
    expect(el.querySelector<HTMLInputElement>('[data-testid="sizzle-inspector-offset"]')!.value).toBe("-0.167");
    expect(el.querySelector<HTMLElement>('[data-testid="sizzle-inspector-window"]')!.textContent).toContain("0:01.3 → 0:02.6");
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-inspector-timing-offset"]')!.click();
    });
    expect(inspectorTiming(el)).toBe("offset");
    expect(el.querySelector<HTMLInputElement>('[data-testid="sizzle-inspector-start"]')!.value).toBe("1.333");
    expect(el.querySelector('[data-testid="sizzle-inspector-end"]')).toBeNull(); // not the final clip
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-inspector-timing-auto"]')!.click();
    });
    expect(inspectorTiming(el)).toBe("auto");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(lastScenesPatch(dispatch)[0]!.beats![1]!.timing).toEqual({ kind: "auto" });
  });

  test("video fit shows for video captures only; Remove clip removes it and closes the inspector", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }), {
      "library:list": { ok: true, value: { rows: [videoCapture("cap_b")] } }
    });
    await selectClip(el, "bt_a");
    expect(el.querySelector('[data-testid="sizzle-inspector-fit"]')).toBeNull();
    await selectClip(el, "bt_b");
    const fit = el.querySelector<HTMLSelectElement>('[data-testid="sizzle-inspector-fit"]');
    expect(fit).not.toBeNull();
    expect([...fit!.options].map((o) => o.value)).toEqual(["smart-fit", "loop", "ping-pong", "speed-to-fit", "freeze-end", "trim"]);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-inspector-remove"]')!.click();
    });
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')).toBeNull();
    expect([...el.querySelectorAll('[data-testid^="sizzle-timeline-clip-"]')].map((n) => n.getAttribute("data-testid"))).toEqual([
      "sizzle-timeline-clip-bt_a",
      "sizzle-timeline-clip-bt_c"
    ]);
  });

  test("a narrow rail folds the chat (still mounted) while the inspector is open; closing it unfolds", async () => {
    setSavedChatWidth(330);
    try {
      const { el } = await renderApp(project({ scenes: [seq()] }));
      expect(el.querySelector('[data-testid="sizzle-chat-folded"]')).toBeNull();
      await selectClip(el, "bt_b");
      expect(el.querySelector('[data-testid="sizzle-chat-folded"]')).not.toBeNull();
      expect(el.querySelector(".szl__chat-pane.is-folded [data-testid=\"sizzle-chat-panel\"]")).not.toBeNull();
      await act(async () => {
        el.querySelector<HTMLButtonElement>('[data-testid="sizzle-chat-folded"] button')!.click();
      });
      expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')).toBeNull();
      expect(el.querySelector('[data-testid="sizzle-chat-folded"]')).toBeNull();
      expect(el.querySelector(".szl__chat-pane.is-folded")).toBeNull();
    } finally {
      resetSizzleChatWidthForTests();
    }
  });
});

describe("scene inspector — multi-scene operations (plan PR 8)", () => {
  // jsdom has no layout: give the timeline a 1000 px strip for this block.
  const realRect = Element.prototype.getBoundingClientRect;
  beforeAll(() => {
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
      const width =
        this.classList.contains("szt__scroll") || this.classList.contains("szt__lanes") ? 1000 : 0;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) } as DOMRect;
    };
  });
  afterAll(() => {
    Element.prototype.getBoundingClientRect = realRect;
  });
  const autoBeat = (
    id: string,
    captureId: string,
    patch: Partial<NonNullable<SizzleScene["beats"]>[number]> = {}
  ): NonNullable<SizzleScene["beats"]>[number] => ({
    id,
    captureId,
    timing: { kind: "auto" },
    mediaTrim: null,
    transition: "cut",
    videoFit: "smart-fit",
    ...patch
  });
  const WORDS = ["Open", "the", "Library", "to", "find", "every", "capture", "fast"].map((word, index) => ({
    index,
    word,
    normalized: word.toLowerCase(),
    startSec: index * 0.5,
    endSec: index * 0.5 + 0.4
  }));
  const cachedAudio = {
    ok: true,
    value: { cached: true, audioBase64: "AA==", mimeType: "audio/mpeg", transcriptPhrases: [], durationSec: 4, words: WORDS }
  };
  const seqA = (): SizzleScene =>
    scene({
      id: "sc_a",
      kind: "sequence",
      scriptLine: "Open the Library to find every capture fast",
      narration: "Open the Library to find every capture fast",
      beats: [autoBeat("bt_a", "cap_a"), autoBeat("bt_b", "cap_b"), autoBeat("bt_c", "cap_c")]
    });
  const seqB = (): SizzleScene =>
    scene({
      id: "sc_b",
      kind: "sequence",
      scriptLine: "Then share it",
      narration: "Then share it",
      beats: [autoBeat("bt_d", "cap_d"), autoBeat("bt_e", "cap_e")],
      transition: "crossfade"
    });
  const lastScenes = (dispatch: { mock: { calls: unknown[][] } }): SizzleScene[] => {
    const updates = dispatch.mock.calls.filter(([name]) => name === "sizzle:update");
    const payload = updates.at(-1)?.[1] as { patch?: { scenes?: SizzleScene[] } } | undefined;
    return payload?.patch?.scenes ?? [];
  };
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
  };
  const selectScene = async (el: HTMLElement, index: number): Promise<void> => {
    const region = el.querySelector<HTMLButtonElement>(`[data-testid="sizzle-timeline-scene-${index}"]`);
    if (region === null) throw new Error(`scene region ${index} not found`);
    await act(async () => {
      region.click();
    });
  };
  const setSelect = async (select: HTMLSelectElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  test("a region (or its transition pill) opens the scene inspector; a clip swaps to the clip inspector; Esc closes", async () => {
    const { el } = await renderApp(project({ scenes: [seqA(), seqB()] }));
    await selectScene(el, 1);
    const insp = el.querySelector<HTMLElement>('[data-testid="sizzle-scene-inspector"]');
    expect(insp).not.toBeNull();
    expect(insp!.textContent).toContain("Scene 2 of 2");
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')).toBeNull();
    // Selecting a clip replaces it with the clip inspector…
    await selectClip(el, "bt_d");
    expect(el.querySelector('[data-testid="sizzle-scene-inspector"]')).toBeNull();
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')).not.toBeNull();
    // …and the pill brings the scene back.
    await act(async () => {
      el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-transition-1"]')!.click();
    });
    expect(el.querySelector('[data-testid="sizzle-scene-inspector"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="sizzle-clip-inspector"]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(el.querySelector('[data-testid="sizzle-scene-inspector"]')).toBeNull();
  });

  test("the transition INTO a scene is editable as type + duration (all eight types); the first scene has none", async () => {
    const { el, dispatch } = await renderApp(project({ scenes: [seqA(), seqB()] }));
    await selectScene(el, 0);
    expect(el.querySelector('[data-testid="sizzle-scene-inspector-transition"]')).toBeNull();
    await selectScene(el, 1);
    const type = el.querySelector<HTMLSelectElement>('[data-testid="sizzle-scene-inspector-transition"]')!;
    expect([...type.options].map((o) => o.value)).toEqual([
      "none", "cut", "crossfade", "dip-black", "dip-white", "push-left", "slide-left", "zoom-cut"
    ]);
    expect(type.value).toBe("crossfade");
    expect(el.querySelector<HTMLInputElement>('[data-testid="sizzle-scene-inspector-transition-duration"]')!.value).toBe("0.4");
    await setSelect(type, "dip-white");
    await settle();
    expect(lastScenes(dispatch)[1]!.transition).toEqual({ type: "dip-white", durationSec: 0.4 }); // keeps the duration
    // The timeline pill reflects it.
    expect(el.querySelector('[data-testid="sizzle-timeline-transition-1"]')?.textContent).toContain("dip white");
  });

  test("move later reorders scenes; merge with previous joins narration + clips and selects the merged scene", async () => {
    const { el, dispatch } = await renderApp(project({ scenes: [seqA(), seqB()] }));
    await selectScene(el, 0);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-scene-inspector-move-later"]')!.click();
    });
    await settle();
    expect(lastScenes(dispatch).map((s) => s.id)).toEqual(["sc_b", "sc_a"]);
    // Now sc_a is second: merge it into sc_b.
    await selectScene(el, 1);
    expect(el.querySelector<HTMLElement>('[data-testid="sizzle-scene-inspector"]')!.textContent).toContain("Scene 2 of 2");
    const merge = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-scene-inspector-merge"]')!;
    expect(merge.disabled).toBe(false);
    await act(async () => {
      merge.click();
    });
    await settle();
    const scenes = lastScenes(dispatch);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.id).toBe("sc_b");
    expect(scenes[0]!.narration).toBe("Then share it Open the Library to find every capture fast");
    expect(scenes[0]!.beats!.map((b) => b.id)).toEqual(["bt_d", "bt_e", "bt_a", "bt_b", "bt_c"]);
    // The boundary clip is pinned to the merged-in narration's first word.
    expect(scenes[0]!.beats![2]!.timing).toEqual({ kind: "phrase", phrase: "Open", occurrence: 1, offsetSec: 0, durationSec: null });
    // The inspector follows the merged scene.
    expect(el.querySelector<HTMLElement>('[data-testid="sizzle-scene-inspector"]')!.textContent).toContain("Scene 1 of 1");
  });

  test("split at playhead needs a resolved scene + the playhead inside; it divides the script at the spoken word", async () => {
    const { el, dispatch } = await renderApp(project({ scenes: [seqA()] }), {
      "sizzle:loadSequenceSceneAudio": cachedAudio
    });
    for (let i = 0; i < 10 && el.querySelector('[data-testid="sizzle-timeline-word-0-3"]') === null; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    await selectScene(el, 0);
    const split = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-scene-inspector-split-at-playhead"]')!;
    expect(split.disabled).toBe(true); // no playhead in the scene yet
    // Scrub to 2.2 s (250 px/s): between "find" (2.0) and "every" (2.5).
    const lanes = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-lanes"]')!;
    await act(async () => {
      lanes.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 550 }));
      lanes.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 7, clientX: 550 }));
    });
    // Scrubbing bare track clears the selection (direct manipulation); select the scene again.
    await selectScene(el, 0);
    const split2 = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-scene-inspector-split-at-playhead"]')!;
    expect(split2.disabled).toBe(false);
    await act(async () => {
      split2.click();
    });
    await settle();
    const scenes = lastScenes(dispatch);
    expect(scenes).toHaveLength(2);
    expect(scenes[0]!.narration).toBe("Open the Library to find");
    expect(scenes[1]!.narration).toBe("every capture fast");
    // Clips starting before 2.2 s stay (0, 1.333); the one at 2.667 moves.
    expect(scenes[0]!.beats!.map((b) => b.id)).toEqual(["bt_a", "bt_b"]);
    expect(scenes[1]!.beats!.map((b) => b.id)).toEqual(["bt_c"]);
    expect(scenes[1]!.transition).toBe("cut");
    expect(el.querySelectorAll('[data-testid^="sizzle-timeline-scene-"]').length).toBe(2);
  });

  test("a re-synthesis that changes the narration length offers Re-fit for offset anchors, and applying it scales them", async () => {
    const withOffset = scene({
      id: "sc_a",
      kind: "sequence",
      scriptLine: "Open the Library to find every capture fast",
      narration: "Open the Library to find every capture fast",
      beats: [autoBeat("bt_a", "cap_a"), autoBeat("bt_b", "cap_b", { timing: { kind: "offset", startSec: 2, endSec: null } })]
    });
    const { el, dispatch } = await renderApp(project({ scenes: [withOffset] }), {
      "sizzle:loadSequenceSceneAudio": cachedAudio, // baseline: 4 s
      "sizzle:previewSequenceScenePlan": {
        ok: true,
        value: {
          audioBase64: "AA==",
          mimeType: "audio/mpeg",
          durationSec: 8, // the re-synthesis came back twice as long
          timingQuality: "precise",
          warnings: [],
          transcriptPhrases: [],
          words: WORDS.map((w) => ({ ...w, startSec: w.startSec * 2, endSec: w.endSec * 2 })),
          beats: [
            { beatId: "bt_a", captureId: "cap_a", startSec: 0, endSec: 2, timing: { kind: "auto" }, transition: "crossfade", videoFit: "smart-fit" },
            { beatId: "bt_b", captureId: "cap_b", startSec: 2, endSec: 8, timing: { kind: "offset", startSec: 2, endSec: null }, transition: "cut", videoFit: "smart-fit" }
          ]
        }
      }
    });
    for (let i = 0; i < 10 && el.querySelector('[data-testid="sizzle-timeline-word-0-3"]') === null; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    await selectScene(el, 0);
    expect(el.querySelector('[data-testid="sizzle-scene-inspector-refit"]')).toBeNull();
    // Re-synthesize from the inspector (explicit click).
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-scene-inspector-synthesize"]')!.click();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(dispatch).toHaveBeenCalledWith("sizzle:previewSequenceScenePlan", { projectId: "sz_1", sceneId: "sc_a" });
    const offer = el.querySelector<HTMLElement>('[data-testid="sizzle-scene-inspector-refit"]');
    expect(offer).not.toBeNull();
    expect(offer!.textContent).toContain("4 s");
    expect(offer!.textContent).toContain("8 s");
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-scene-inspector-refit-apply"]')!.click();
    });
    await settle();
    expect(lastScenes(dispatch)[0]!.beats![1]!.timing).toEqual({ kind: "offset", startSec: 4, endSec: null });
    expect(el.querySelector('[data-testid="sizzle-scene-inspector-refit"]')).toBeNull();
  });
});
