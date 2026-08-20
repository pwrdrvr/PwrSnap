// Renderer-CPU bench for the Library video stage playhead loop.
//
// Mounts the REAL `VideoStage` (transport + timeline) against a fake
// media element so the only work under measurement is React render +
// DOM commit + layout/paint driven by the playhead. No decode, no IPC.
//
// Drive it from `run.mjs`: `window.__bench.start()` / `.stop()`.

import { StrictMode, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { VideoStage } from "../src/renderer/src/features/library/VideoStage";
import { useVideoTrimRange } from "../src/renderer/src/features/shared/useVideoTrimRange";
import "../src/renderer/src/styles/tokens.css";
import "../src/renderer/src/styles/video-timeline.css";

const DURATION_SEC = 7200; // the 2 h looping clip from the CPU report

// ── fake media element ──────────────────────────────────────────────
// Real <video> with its clock replaced: `currentTime` advances off
// performance.now() while "playing". Deterministic and decode-free.
type Clock = { playing: boolean; base: number; wall: number };
const clock: Clock = { playing: false, base: 0, wall: 0 };

function readClock(): number {
  if (!clock.playing) return clock.base;
  return clock.base + (performance.now() - clock.wall) / 1000;
}

Object.defineProperty(HTMLVideoElement.prototype, "currentTime", {
  configurable: true,
  get(): number {
    return readClock();
  },
  set(this: HTMLVideoElement, value: number) {
    clock.base = value;
    clock.wall = performance.now();
  }
});
Object.defineProperty(HTMLVideoElement.prototype, "paused", {
  configurable: true,
  get(): boolean {
    return !clock.playing;
  }
});
HTMLVideoElement.prototype.play = function play(this: HTMLVideoElement): Promise<void> {
  clock.base = readClock();
  clock.wall = performance.now();
  clock.playing = true;
  this.dispatchEvent(new Event("play"));
  return Promise.resolve();
};
HTMLVideoElement.prototype.pause = function pause(this: HTMLVideoElement): void {
  clock.base = readClock();
  clock.playing = false;
  this.dispatchEvent(new Event("pause"));
};

// ── harness ─────────────────────────────────────────────────────────

const RECORD = {
  id: "bench-capture",
  kind: "video",
  width_px: 1920,
  height_px: 1080
} as never;

const VIDEO = {
  durationSec: DURATION_SEC,
  hasSystemAudio: false,
  hasMicrophoneAudio: false,
  defaultRange: { start: 0, end: DURATION_SEC }
} as never;

function Bench(): ReactElement {
  const trim = useVideoTrimRange({
    captureId: "bench-capture",
    durationSec: DURATION_SEC,
    persistedRange: { start: 0, end: DURATION_SEC }
  });
  const [mounted] = useState(true);
  return mounted ? <VideoStage record={RECORD} video={VIDEO} trim={trim} /> : <div />;
}

const host = document.getElementById("root");
if (host === null) throw new Error("no #root");
createRoot(host).render(
  <StrictMode>
    <Bench />
  </StrictMode>
);

// Frame counter + DOM-mutation counter so a run can prove the loop
// actually re-rendered (and how much DOM it touched doing it).
let frames = 0;
let rafId = 0;
let mutations = 0;
const countFrame = (): void => {
  frames += 1;
  rafId = requestAnimationFrame(countFrame);
};
const observer = new MutationObserver((records) => {
  mutations += records.length;
});

declare global {
  interface Window {
    __bench: {
      start: () => void;
      stop: () => { frames: number; mutations: number };
      playing: () => boolean;
    };
  }
}

window.__bench = {
  start: (): void => {
    frames = 0;
    mutations = 0;
    const el = document.querySelector("video");
    if (el === null) throw new Error("no <video> mounted");
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
    void el.play();
    rafId = requestAnimationFrame(countFrame);
  },
  stop: (): { frames: number; mutations: number } => {
    cancelAnimationFrame(rafId);
    observer.disconnect();
    const el = document.querySelector("video");
    el?.pause();
    return { frames, mutations };
  },
  playing: (): boolean => clock.playing
};
