// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, SizzleScene, SizzleSequenceBeat, SizzleWordTiming } from "@pwrsnap/shared";
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
    activeSceneId: null,
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
});
