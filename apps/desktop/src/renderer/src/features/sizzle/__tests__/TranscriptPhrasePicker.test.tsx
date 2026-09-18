// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { SizzleSequenceTranscriptPhrase } from "@pwrsnap/shared";
import {
  PHRASE_POPOVER_MAX_HEIGHT_PX,
  phrasePopoverStyle,
  TranscriptPhrasePicker
} from "../TranscriptPhrasePicker";

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
  vi.restoreAllMocks();
});

const PHRASES: SizzleSequenceTranscriptPhrase[] = [
  "Crunchy Oat Rings stay crunchy",
  "pour a bowl",
  "add a banana",
  "Maple Clusters for weekends"
].map((text, index) => ({
  text,
  startSec: index * 2,
  endSec: index * 2 + 1.5,
  wordStartIndex: index * 5,
  wordEndIndex: index * 5 + 4
}));

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  new DOMRect(left, top, width, height);
const VIEWPORT = { width: 1280, height: 820 };
const WHOLE_WINDOW = rect(0, 0, VIEWPORT.width, VIEWPORT.height);

describe("phrasePopoverStyle", () => {
  test("opens below the button when the whole popover fits there", () => {
    const style = phrasePopoverStyle(rect(900, 200, 300, 26), WHOLE_WINDOW, VIEWPORT);
    expect(style.top).toBe(230);
    expect(style.bottom).toBeUndefined();
    expect(style.maxHeight).toBe(PHRASE_POPOVER_MAX_HEIGHT_PX);
  });

  test("flips above a button in the bottom drawer, anchored by its bottom edge", () => {
    // The clip inspector drawer puts the Word picker around y≈612–638 of an
    // 820 px window: only ~170 px below it, ~600 px above.
    const style = phrasePopoverStyle(rect(900, 612, 300, 26), WHOLE_WINDOW, VIEWPORT);
    expect(style.top).toBeUndefined();
    expect(style.bottom).toBe(820 - 612 + 4);
    expect(style.maxHeight).toBe(PHRASE_POPOVER_MAX_HEIGHT_PX);
  });

  test("with room for the full popover on neither side, takes the larger side and caps to it", () => {
    const short = { width: 1280, height: 400 };
    // 212 px below, 138 px above: stays below, capped to what is there.
    const below = phrasePopoverStyle(rect(900, 150, 300, 26), rect(0, 0, 1280, 400), short);
    expect(below.top).toBe(180);
    expect(below.maxHeight).toBe(400 - 176 - 4 - 8);
    // 110 px below, 240 px above: flips, capped to the room above.
    const above = phrasePopoverStyle(rect(900, 252, 300, 26), rect(0, 0, 1280, 400), short);
    expect(above.bottom).toBe(400 - 252 + 4);
    expect(above.maxHeight).toBe(252 - 4 - 8);
  });

  test("keeps the horizontal clamp inside the boundary", () => {
    // A button hard against the window's right edge still gets a popover
    // that ends a gutter short of it.
    const style = phrasePopoverStyle(rect(1200, 200, 70, 26), WHOLE_WINDOW, VIEWPORT);
    expect(style.width).toBe(420);
    expect(style.left).toBe(1280 - 8 - 420);
  });
});

describe("TranscriptPhrasePicker", () => {
  test("opened from the bottom drawer, the popover renders above the button", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(VIEWPORT.width);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(VIEWPORT.height);
    const realRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("szl__sequence-phrase-control")
        ? rect(900, 612, 300, 26)
        : realRect.call(this);
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(TranscriptPhrasePicker, { currentPhrase: "", phrases: PHRASES, onSelect: () => undefined })
      );
    });
    await act(async () => {
      container!.querySelector<HTMLButtonElement>(".szl__sequence-phrase-button")!.click();
    });

    const popover = container.querySelector<HTMLElement>(".szl__sequence-phrase-popover");
    expect(popover).not.toBeNull();
    expect(popover!.style.top).toBe("");
    expect(popover!.style.bottom).toBe(`${820 - 612 + 4}px`);
    expect(popover!.style.maxHeight).toBe(`${PHRASE_POPOVER_MAX_HEIGHT_PX}px`);
    expect(popover!.querySelectorAll('[role="option"]')).toHaveLength(PHRASES.length);
  });
});
