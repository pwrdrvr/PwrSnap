// Table-driven tests for `resolveSizzleAudioSource` — the policy
// resolver that decides per-scene audio handling at render time.
//
// This function is load-bearing: both the main-process render
// handler and the renderer's editor UI call it to gate the preview
// button, the script-line placeholder, and the actual ffmpeg audio
// concat list. Before the refactor that hoisted it into shared,
// the two processes had separate implementations — exactly the kind
// of duplication that quietly diverges over time. These tests pin
// the contract centrally so any future change has to update one
// place AND its tests, not two implementations independently.

import { describe, expect, test } from "vitest";
import { resolveSizzleAudioSource } from "../protocol";
import type { SizzleAudioSource } from "../protocol";

type Resolved = "native" | "voiceover" | "muted";
type Case = {
  audioSource: SizzleAudioSource;
  captureKind: "image" | "video";
  script: string;
  expected: Resolved;
  comment: string;
};

const CASES: Case[] = [
  // ── auto resolution ───────────────────────────────────────────────
  {
    audioSource: "auto",
    captureKind: "image",
    script: "",
    expected: "voiceover",
    comment:
      "image + auto + no script — voiceover anyway (image has no native audio to play, and a muted image with no narration would be a 3s blank)"
  },
  {
    audioSource: "auto",
    captureKind: "image",
    script: "Hello world",
    expected: "voiceover",
    comment: "image + auto + script — voiceover (the only meaningful option)"
  },
  {
    audioSource: "auto",
    captureKind: "video",
    script: "",
    expected: "native",
    comment:
      "video + auto + no script — native (let the clip's recorded audio play)"
  },
  {
    audioSource: "auto",
    captureKind: "video",
    script: "Let me show you the bug",
    expected: "voiceover",
    comment:
      "video + auto + script — voiceover (TTS over the clip, video audio muted)"
  },
  // ── explicit native ───────────────────────────────────────────────
  {
    audioSource: "native",
    captureKind: "image",
    script: "ignored",
    expected: "muted",
    comment:
      "image + explicit native — fall back to muted (image has no native audio to extract)"
  },
  {
    audioSource: "native",
    captureKind: "video",
    script: "ignored",
    expected: "native",
    comment: "video + explicit native — pass through (the case it was designed for)"
  },
  // ── explicit voiceover ────────────────────────────────────────────
  {
    audioSource: "voiceover",
    captureKind: "image",
    script: "Sample text",
    expected: "voiceover",
    comment:
      "image + explicit voiceover — pass through (handler still validates the script is non-empty)"
  },
  {
    audioSource: "voiceover",
    captureKind: "video",
    script: "Sample text",
    expected: "voiceover",
    comment:
      "video + explicit voiceover — pass through (video audio gets muted by the composer)"
  },
  // ── explicit muted ────────────────────────────────────────────────
  {
    audioSource: "muted",
    captureKind: "image",
    script: "Sample text",
    expected: "muted",
    comment:
      "image + explicit muted — pass through (composer feeds a silent mp3 of scene duration)"
  },
  {
    audioSource: "muted",
    captureKind: "video",
    script: "Sample text",
    expected: "muted",
    comment:
      "video + explicit muted — pass through (composer mutes both video audio and TTS)"
  }
];

describe("resolveSizzleAudioSource — full case matrix", () => {
  test.each(CASES)(
    "$audioSource × $captureKind × script=$script → $expected",
    ({ audioSource, captureKind, script, expected }) => {
      expect(resolveSizzleAudioSource(audioSource, captureKind, script)).toBe(
        expected
      );
    }
  );
});

describe("resolveSizzleAudioSource — script-trim semantics", () => {
  // The `auto` resolver tests scriptLine.trim().length, NOT the raw
  // string. A user-typed whitespace-only "script line" should
  // collapse to native (for video) — matching the validator's
  // empty-script rejection, which also trims. Without this, "  "
  // would push a video scene into voiceover mode and the render
  // handler would then reject it as empty-script downstream — a
  // confusing mismatch.

  test("whitespace-only script counts as empty (video → native)", () => {
    expect(resolveSizzleAudioSource("auto", "video", "   ")).toBe("native");
    expect(resolveSizzleAudioSource("auto", "video", "\t\n")).toBe("native");
  });

  test("non-empty after trim counts as filled (video → voiceover)", () => {
    expect(resolveSizzleAudioSource("auto", "video", "  hi  ")).toBe(
      "voiceover"
    );
  });
});

describe("resolveSizzleAudioSource — return type narrows", () => {
  // The return type is the narrow `"native" | "voiceover" | "muted"`
  // — `auto` is INPUT only, never output. This test pins the
  // exhaustiveness so a future case that accidentally returns "auto"
  // fails the type check at the consumer side AND the test signal
  // here.

  test("never returns auto, regardless of input", () => {
    for (const audio of ["auto", "native", "voiceover", "muted"] as const) {
      for (const kind of ["image", "video"] as const) {
        for (const script of ["", "hello"]) {
          const out = resolveSizzleAudioSource(audio, kind, script);
          expect(out).not.toBe("auto");
          expect(["native", "voiceover", "muted"]).toContain(out);
        }
      }
    }
  });
});
