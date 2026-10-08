// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { AvatarStyle, CaptureRecord, SizzleScene, SizzleSequenceBeat, SizzleWordTiming } from "@pwrsnap/shared";
import { createPlayheadSource } from "../../shared/playhead";
import { ReelPlayer } from "../ReelPlayer";
import { buildTimelineModel, type TimelineModel } from "../timeline/timeline-model";
import type { ReelPlayback } from "../useReelPlayback";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

const SCRIPT = "one two three four five six seven eight nine ten eleven twelve";
const WORDS: SizzleWordTiming[] = SCRIPT.split(" ").map((word, index) => ({
  index,
  word,
  normalized: word,
  startSec: index * 0.5,
  endSec: index * 0.5 + 0.4
}));
const beat = (id: string): SizzleSequenceBeat => ({
  id,
  captureId: `cap_${id}`,
  timing: { kind: "auto" },
  mediaTrim: null,
  transition: "cut",
  videoFit: "smart-fit"
});
const scene = (id: string, beatId: string): SizzleScene => ({
  id,
  kind: "sequence",
  captureId: `cap_${beatId}`,
  scriptLine: SCRIPT,
  narration: SCRIPT,
  beats: [beat(beatId)],
  durationOverrideSec: null,
  mediaTrim: null,
  audioSource: "voiceover",
  transition: "crossfade"
});
const imageCapture = (id: string): CaptureRecord =>
  ({ id, kind: "image", source_app_name: `App ${id}`, edits_version: 0 }) as unknown as CaptureRecord;

// Two 8 s scenes with a 0.4 s crossfade between them, so scene 2 starts at
// 7.6 on the project axis and the dissolve runs [7.6, 8.0).
const model = (): TimelineModel =>
  buildTimelineModel({
    scenes: [scene("s1", "a"), scene("s2", "b")],
    sourceFor: () => ({ words: WORDS, context: { capture: null, narrationDurationSec: 8 } })
  });
const CAPTURES = new Map<string, CaptureRecord>([
  ["cap_a", imageCapture("cap_a")],
  ["cap_b", imageCapture("cap_b")]
]);

function stubPlayback(over: Partial<ReelPlayback> = {}): ReelPlayback {
  return {
    playing: false,
    activeSceneId: "s1",
    activeSceneHasAudio: true,
    volume: 1,
    muted: false,
    setVolume: () => undefined,
    toggleMuted: () => undefined,
    play: () => undefined,
    pause: () => undefined,
    toggle: () => undefined,
    seek: () => undefined,
    ...over
  };
}

async function render(args: {
  head: ReturnType<typeof createPlayheadSource>;
  playback?: ReelPlayback;
  renderLabel?: string | null;
  onRender?: () => void;
}): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(ReelPlayer, {
        model: model(),
        captureMap: CAPTURES,
        beatById: new Map(),
        head: args.head,
        playback: args.playback ?? stubPlayback(),
        renderLabel: args.renderLabel ?? "Render · 0:15",
        renderDisabled: false,
        renderTitle: undefined,
        onRender: args.onRender ?? (() => undefined)
      })
    );
  });
  return container;
}

describe("ReelPlayer", () => {
  test("shows the clip under the head and moves the timecode WITHOUT a re-render", async () => {
    const head = createPlayheadSource(2);
    const el = await render({ head });
    const out = el.querySelector<HTMLElement>('[data-testid="sizzle-reel-outgoing"]')!;
    expect(out.dataset.beat).toBe("a");
    expect(el.querySelector('[data-testid="sizzle-reel-incoming"]')).toBeNull();
    expect(el.querySelector('[data-testid="sizzle-reel-time"]')?.textContent).toContain("0:02.0");
    expect(el.querySelector('[data-testid="sizzle-reel-where"]')?.textContent).toBe("Scene 1 · clip 1");
    // A head move inside the same clip only rewrites the clock text.
    await act(async () => {
      head.set(3);
    });
    expect(el.querySelector('[data-testid="sizzle-reel-time"]')?.textContent).toContain("0:03.0");
    expect(el.querySelector<HTMLElement>('[data-testid="sizzle-reel-outgoing"]')!.dataset.beat).toBe("a");
  });

  test("inside the scene-boundary crossfade both layers are on stage", async () => {
    // Scene 2 starts at 7.6 (8 − the 0.4 s crossfade); the dissolve runs
    // [7.6, 8.0).
    const head = createPlayheadSource(7.8);
    const el = await render({ head });
    const out = el.querySelector<HTMLElement>('[data-testid="sizzle-reel-outgoing"]')!;
    const inc = el.querySelector<HTMLElement>('[data-testid="sizzle-reel-incoming"]')!;
    expect(out.dataset.beat).toBe("a");
    expect(inc.dataset.beat).toBe("b");
    expect(inc.classList.contains("is-crossfade")).toBe(true);
    expect(inc.dataset.progress).toBe("0.500");
    expect(inc.style.animationName).toBe("szl-xf-incoming-crossfade");
    // Paused: the animations are parked so the frame is exact.
    expect(inc.style.animationPlayState).toBe("paused");
  });

  test("the transport toggles playback and the Render button lives here, next to the reel", async () => {
    const toggle = vi.fn();
    const onRender = vi.fn();
    const el = await render({
      head: createPlayheadSource(0),
      playback: stubPlayback({ toggle }),
      onRender
    });
    const play = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-reel-play"]')!;
    expect(play.textContent).toBe("▶");
    await act(async () => {
      play.click();
    });
    expect(toggle).toHaveBeenCalledTimes(1);
    const renderBtn = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-render"]')!;
    expect(renderBtn.textContent).toBe("Render · 0:15");
    await act(async () => {
      renderBtn.click();
    });
    expect(onRender).toHaveBeenCalledTimes(1);
  });

  test("while playing, the button is a stop and the animations run", async () => {
    const el = await render({
      head: createPlayheadSource(7.8),
      playback: stubPlayback({ playing: true })
    });
    expect(el.querySelector('[data-testid="sizzle-reel-play"]')?.textContent).toBe("■");
    const inc = el.querySelector<HTMLElement>('[data-testid="sizzle-reel-incoming"]')!;
    expect(inc.style.animationPlayState).toBe("running");
  });

  test("the transport carries a mute toggle and a volume slider, and says when a scene is silent", async () => {
    const setVolume = vi.fn();
    const toggleMuted = vi.fn();
    const el = await render({
      head: createPlayheadSource(0),
      playback: stubPlayback({ setVolume, toggleMuted })
    });
    expect(el.querySelector('[data-testid="sizzle-reel-silent"]')).toBeNull();
    const vol = el.querySelector<HTMLInputElement>('[data-testid="sizzle-reel-volume"]')!;
    expect(vol.value).toBe("1");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(vol, "0.4");
      vol.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(setVolume).toHaveBeenCalledWith(0.4);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-reel-mute"]')!.click();
    });
    expect(toggleMuted).toHaveBeenCalledTimes(1);
  });

  test("a scene with no narration audio says so instead of looking broken", async () => {
    const el = await render({
      head: createPlayheadSource(0),
      playback: stubPlayback({ activeSceneHasAudio: false })
    });
    expect(el.querySelector('[data-testid="sizzle-reel-silent"]')?.textContent).toBe("no narration audio");
  });

  test("muting drives the slider to zero without losing the stored level", async () => {
    const el = await render({
      head: createPlayheadSource(0),
      playback: stubPlayback({ muted: true, volume: 0.8 })
    });
    expect(el.querySelector<HTMLInputElement>('[data-testid="sizzle-reel-volume"]')!.value).toBe("0");
    expect(el.querySelector('[data-testid="sizzle-reel-mute"]')?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("editing a scene's presenter on the reel stage", () => {
  const cameraCapture = (id: string): CaptureRecord =>
    ({
      id,
      kind: "video",
      width_px: 1600,
      height_px: 900,
      edits_version: 0,
      video: {
        durationSec: 8,
        defaultRange: { start: 0, end: 8 },
        segments: [{ start: 0, end: 8 }],
        camera: { version: 1, durationSec: 8, width: 1280, height: 720, offsetSec: 0, sha256: "a".repeat(64), mimeType: "video/mp4" },
        avatar: { visible: true, background: "original", x: 0.7, y: 0.7, width: 0.25, mirror: false, crop: { x: 0, y: 0, width: 1, height: 1 } }
      }
    }) as unknown as CaptureRecord;
  const VIDEO_CAPTURES = new Map<string, CaptureRecord>([
    ["cap_a", cameraCapture("cap_a")],
    ["cap_b", cameraCapture("cap_b")]
  ]);
  const FRAME = { width: 800, height: 450 };

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
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountStage(head: ReturnType<typeof createPlayheadSource>) {
    const onScenePresenter = vi.fn<(sceneId: string, avatar: AvatarStyle | null) => void>();
    const tree = (playing: boolean) =>
      createElement(ReelPlayer, {
        model: model(),
        captureMap: VIDEO_CAPTURES,
        beatById: new Map(),
        head,
        playback: stubPlayback({ playing }),
        renderLabel: "Render · 0:15",
        renderDisabled: false,
        renderTitle: undefined,
        onRender: () => undefined,
        onScenePresenter
      });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(tree(false));
    });
    const el = container;
    return {
      el,
      onScenePresenter,
      setPlaying: async (playing: boolean) => {
        await act(async () => {
          root?.render(tree(playing));
        });
      },
      select: async () => {
        const obj = el.querySelector<HTMLElement>('[data-testid="sizzle-reel-outgoing"] [data-testid="presenter-object"]')!;
        await act(async () => {
          obj.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 650, clientY: 380 }));
          obj.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 650, clientY: 380 }));
        });
      },
      toolbar: () => el.querySelector('[data-testid="presenter-toolbar"]')
    };
  }

  test("paused, a press selects it and a toolbar change writes that scene's presenter", async () => {
    const stage = await mountStage(createPlayheadSource(2));
    expect(stage.toolbar()).toBeNull();
    await stage.select();
    expect(stage.toolbar()).not.toBeNull();
    await act(async () => {
      stage.el.querySelector<HTMLButtonElement>('[data-testid="presenter-mirror"]')!.click();
    });
    expect(stage.onScenePresenter).toHaveBeenCalledTimes(1);
    const [sceneId, avatar] = stage.onScenePresenter.mock.calls[0]!;
    expect(sceneId).toBe("s1");
    expect(avatar?.mirror).toBe(true);
  });

  test("playing lets go, and the presenter is not selectable until paused again", async () => {
    const stage = await mountStage(createPlayheadSource(2));
    await stage.select();
    expect(stage.toolbar()).not.toBeNull();
    await stage.setPlaying(true);
    expect(stage.toolbar()).toBeNull();
    await stage.setPlaying(false);
    // Pausing does not bring the old selection back.
    expect(stage.toolbar()).toBeNull();
    // While playing, a press on it selects nothing.
    await stage.setPlaying(true);
    await stage.select();
    await stage.setPlaying(false);
    expect(stage.toolbar()).toBeNull();
    await stage.select();
    expect(stage.toolbar()).not.toBeNull();
  });

  test("moving to another clip lets go", async () => {
    const head = createPlayheadSource(2);
    const stage = await mountStage(head);
    await stage.select();
    expect(stage.toolbar()).not.toBeNull();
    await act(async () => {
      head.set(10);
    });
    expect(stage.el.querySelector<HTMLElement>('[data-testid="sizzle-reel-outgoing"]')!.dataset.beat).toBe("b");
    expect(stage.toolbar()).toBeNull();
  });

  test("a press elsewhere on the stage lets go", async () => {
    const stage = await mountStage(createPlayheadSource(2));
    await stage.select();
    expect(stage.toolbar()).not.toBeNull();
    await act(async () => {
      stage.el
        .querySelector<HTMLElement>('[data-testid="sizzle-reel-stage"]')!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    expect(stage.toolbar()).toBeNull();
  });

  test("inside a transition the presenter is only shown", async () => {
    const stage = await mountStage(createPlayheadSource(7.8));
    expect(stage.el.querySelector('[data-testid="sizzle-reel-incoming"]')).not.toBeNull();
    await stage.select();
    expect(stage.toolbar()).toBeNull();
    expect(stage.onScenePresenter).not.toHaveBeenCalled();
  });
});
