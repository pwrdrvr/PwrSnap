// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type CaptureRecord, type SizzleProject, type SizzleScene } from "@pwrsnap/shared";
import {
  SizzleApp,
  formatSequencePreviewWarnings,
  formatTranscriptPhraseOptionLabel
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
    if (name in overrides) return overrides[name];
    if (name === "sizzle:list") return { ok: true, value: { projects } };
    if (name === "library:list") return { ok: true, value: { rows: [] } };
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
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return { dispatch, emit };
}

async function renderApp(
  initial: SizzleProject | SizzleProject[],
  overrides: Record<string, unknown> = {}
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
    root?.render(createElement(SizzleApp));
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

function typeIntoInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

    expect(el.textContent).not.toContain("Sequence · one narration block");

    await act(async () => {
      findButton(el, "Sequence").click();
    });

    expect(el.textContent).toContain("Sequence · one narration block");
    expect(scriptBox(el).value).toBe("one narration block");
    expect(el.querySelectorAll(".szl__sequence-beat")).toHaveLength(1);
    expect(el.textContent).toContain("Phrase anchors use timed transcript words from preview");
    expect(el.querySelector(".szl__sequence-timeline")).not.toBeNull();
    expect(el.textContent).toContain("unresolved");
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

    const play = el.querySelector<HTMLButtonElement>(".szl__sequence-preview-controls .szl__scene-mini--play");
    if (play === null) throw new Error("sequence preview play button not found");

    await act(async () => {
      play.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith("sizzle:previewSequenceScenePlan", {
      projectId: "sz_1",
      sceneId: "sc_a"
    });
    expect(dispatch).not.toHaveBeenCalledWith("sizzle:previewSceneAudio", {
      projectId: "sz_1",
      sceneId: "sc_a"
    });
    expect(el.textContent).toContain("approx timing");
    expect(el.textContent).toContain("4s");
    const phrase = el.querySelector<HTMLInputElement>(".szl__sequence-phrase");
    expect(phrase?.getAttribute("list")).toMatch(/^szl-transcript-phrases-/);
    const transcriptOption = el.querySelector<HTMLOptionElement>("datalist option");
    expect(transcriptOption?.value).toBe("the next screen");
    expect(transcriptOption?.label).toBe("1.5s - 2.4s");
    expect(el.textContent).toContain("Phrase anchors use timed transcript words from preview");
  });

  test("starts and stops the already-mounted first sequence video preview", async () => {
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
    const { el } = await renderApp(project({ scenes: [sequence] }), {
      "library:list": {
        ok: true,
        value: { rows: [videoCapture("cap_a"), videoCapture("cap_b")] }
      }
    });
    const playButton = el.querySelector<HTMLButtonElement>(".szl__sequence-preview-controls .szl__scene-mini--play");
    const firstVideo = el.querySelector<HTMLVideoElement>(".szl__sequence-preview-stage video");
    if (playButton === null) throw new Error("sequence preview play button not found");
    if (firstVideo === null) throw new Error("first sequence video not found");

    const playMock = vi.mocked(HTMLMediaElement.prototype.play);
    const pauseMock = vi.mocked(HTMLMediaElement.prototype.pause);
    playMock.mockClear();
    pauseMock.mockClear();

    await act(async () => {
      playButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(playMock.mock.contexts).toContain(firstVideo);

    await act(async () => {
      playButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pauseMock.mock.contexts).toContain(firstVideo);
  });

  test("syncs the first sequence video preview to the beat trim and narration time", async () => {
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
          mediaTrim: { startSec: 2, endSec: 6 },
          transition: "cut",
          videoFit: "trim"
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
    const { el } = await renderApp(project({ scenes: [sequence] }), {
      "library:list": {
        ok: true,
        value: { rows: [videoCapture("cap_a"), videoCapture("cap_b")] }
      }
    });
    const playButton = el.querySelector<HTMLButtonElement>(".szl__sequence-preview-controls .szl__scene-mini--play");
    const firstVideo = el.querySelector<HTMLVideoElement>(".szl__sequence-preview-stage video");
    const audio = el.querySelector<HTMLAudioElement>("audio");
    if (playButton === null) throw new Error("sequence preview play button not found");
    if (firstVideo === null) throw new Error("first sequence video not found");
    if (audio === null) throw new Error("preview audio not found");

    await act(async () => {
      playButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(firstVideo.currentTime).toBe(2);

    await act(async () => {
      audio.currentTime = 1;
      audio.dispatchEvent(new Event("timeupdate", { bubbles: true }));
      await Promise.resolve();
    });

    expect(firstVideo.currentTime).toBe(3);
  });

  test("holds the last trimmed frame for freeze-end sequence video preview", async () => {
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
          mediaTrim: { startSec: 2, endSec: 3 },
          transition: "cut",
          videoFit: "freeze-end"
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
    const { el } = await renderApp(project({ scenes: [sequence] }), {
      "library:list": {
        ok: true,
        value: { rows: [videoCapture("cap_a"), videoCapture("cap_b")] }
      }
    });
    const playButton = el.querySelector<HTMLButtonElement>(".szl__sequence-preview-controls .szl__scene-mini--play");
    const firstVideo = el.querySelector<HTMLVideoElement>(".szl__sequence-preview-stage video");
    const audio = el.querySelector<HTMLAudioElement>("audio");
    if (playButton === null) throw new Error("sequence preview play button not found");
    if (firstVideo === null) throw new Error("first sequence video not found");
    if (audio === null) throw new Error("preview audio not found");

    await act(async () => {
      playButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const pauseMock = vi.mocked(HTMLMediaElement.prototype.pause);
    pauseMock.mockClear();
    firstVideo.currentTime = 3.4;

    await act(async () => {
      audio.currentTime = 1.2;
      audio.dispatchEvent(new Event("timeupdate", { bubbles: true }));
      await Promise.resolve();
    });

    expect(firstVideo.currentTime).toBe(3);
    expect(pauseMock.mock.contexts).toContain(firstVideo);
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

    const play = el.querySelector<HTMLButtonElement>(".szl__sequence-preview-controls .szl__scene-mini--play");
    if (play === null) throw new Error("sequence preview play button not found");
    await act(async () => {
      play.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.textContent).toContain("approx timing");

    const phrase = el.querySelector<HTMLInputElement>(".szl__sequence-phrase");
    if (phrase === null) throw new Error("sequence phrase input not found");
    await act(async () => {
      typeIntoInput(phrase, "changed phrase");
    });

    expect(el.textContent).toContain("unresolved");
    expect(el.textContent).not.toContain("approx timing");
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
        label: "Beat 4",
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
        label: "Beat 4",
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

    expect(warnings[0]?.label).toBe("Beat 2");
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
        }
      ]
    });
    // Default mock: the cache-only load reports a miss, so the proactive
    // loader finds nothing and the honest flat baseline stays.
    const { el } = await renderApp(project({ scenes: [sequence] }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(el.querySelector(".szl__sequence-wave--idle")).not.toBeNull();
    expect(el.querySelector(".szl__sequence-wave-surfer")).toBeNull();
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
        }
      ]
    });
    const { el, dispatch } = await renderApp(project({ scenes: [sequence] }), {
      "sizzle:loadSequenceSceneAudio": {
        ok: true,
        value: { cached: true, audioBase64: "AA==", mimeType: "audio/mpeg" }
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
    expect(el.querySelector(".szl__sequence-wave-surfer")).not.toBeNull();
    expect(el.querySelector(".szl__sequence-wave--idle")).toBeNull();
  });
});

describe("auto beat timing UI", () => {
  test("converting a scene to a sequence seeds an auto beat (R4)", async () => {
    const { el } = await renderApp(project({ scenes: [scene({ scriptLine: "narration here" })] }));
    await act(async () => {
      findButton(el, "Sequence").click();
    });
    const timingSelect = el.querySelector<HTMLSelectElement>(".szl__sequence-beat select");
    expect(timingSelect?.value).toBe("auto");
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
    const beatRows = el.querySelectorAll(".szl__sequence-beat");
    expect(beatRows).toHaveLength(2);
    // The 2nd (non-first) auto beat keeps the timing <select> for promotion
    // but renders no value inputs.
    const second = beatRows[1]!;
    expect(second.querySelector<HTMLSelectElement>("select")?.value).toBe("auto");
    expect(second.querySelector(".szl__sequence-time")).toBeNull();
    expect(second.querySelector(".szl__sequence-phrase")).toBeNull();
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
  const order = (el: HTMLElement): (string | null)[] =>
    [...el.querySelectorAll(".szl__sequence-beat-title")].map((n) => n.textContent);
  const fireDrop = (row: Element, fromIndex: number): void => {
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
      value: { getData: () => String(fromIndex), dropEffect: "", effectAllowed: "" }
    });
    row.dispatchEvent(ev);
  };

  test("the ↓ button moves a beat down via a from→to splice", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }));
    expect(order(el)).toEqual(["cap_a", "cap_b", "cap_c"]);
    const firstRow = el.querySelectorAll(".szl__sequence-beat")[0]!;
    const down = [...firstRow.querySelectorAll("button")].find((b) => b.title === "Move beat down")!;
    await act(async () => {
      down.click();
    });
    expect(order(el)).toEqual(["cap_b", "cap_a", "cap_c"]);
  });

  test("dropping beat 0 onto beat 2 reorders by splice-and-insert (not swap)", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }));
    const thirdRow = el.querySelectorAll(".szl__sequence-beat")[2]!;
    await act(async () => {
      fireDrop(thirdRow, 0); // drag index 0 → drop on index 2
    });
    // splice: [a,b,c] remove a → [b,c] insert at 2 → [b,c,a] (swap would give [c,b,a])
    expect(order(el)).toEqual(["cap_b", "cap_c", "cap_a"]);
  });

  test("self-drop (drop a beat on itself) is a no-op", async () => {
    const { el } = await renderApp(project({ scenes: [seq()] }));
    const firstRow = el.querySelectorAll(".szl__sequence-beat")[0]!;
    await act(async () => {
      fireDrop(firstRow, 0); // from === to
    });
    expect(order(el)).toEqual(["cap_a", "cap_b", "cap_c"]);
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
    // reorder: first beat down → [b, a, c]
    const down = [...el.querySelectorAll(".szl__sequence-beat")[0]!.querySelectorAll("button")].find(
      (b) => b.title === "Move beat down"
    )!;
    await act(async () => {
      down.click();
    });
    expect(order(el)).toEqual(["cap_b", "cap_a", "cap_c"]);
    await act(async () => {
      fireKey(false); // ⌘Z → undo
    });
    expect(order(el)).toEqual(["cap_a", "cap_b", "cap_c"]);
    await act(async () => {
      fireKey(true); // ⌘⇧Z → redo
    });
    expect(order(el)).toEqual(["cap_b", "cap_a", "cap_c"]);
  });

  test("an external (chat) scenes change drops local undo history — no ⌘Z clobber", async () => {
    const { el, emit } = await renderApp(project({ scenes: [seq()] }));
    // local reorder → an undo entry + a pending debounced write
    const down = [...el.querySelectorAll(".szl__sequence-beat")[0]!.querySelectorAll("button")].find(
      (b) => b.title === "Move beat down"
    )!;
    await act(async () => {
      down.click();
    });
    expect(order(el)).toEqual(["cap_b", "cap_a", "cap_c"]);
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
    expect(order(el)).toEqual(["cap_c", "cap_b", "cap_a"]);
    // ⌘Z must NOT restore the pre-reorder order — the stale history was dropped.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })
      );
    });
    expect(order(el)).toEqual(["cap_c", "cap_b", "cap_a"]);
  });
});
