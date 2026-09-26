import { describe, expect, it } from "vitest";
import {
  videoEditPlaybackStep,
  cutVideoSegments,
  isFullClipEdit,
  joinVideoSegmentsAt,
  nextPlayableVideoTime,
  normalizeVideoSegments,
  splitVideoSegmentsAt,
  toggleVideoPiece,
  videoCuts,
  videoExportSpans,
  videoHasCuts,
  videoKeptDurationSec,
  videoPieceAt,
  videoPieces,
  videoSegmentsOrFull,
  videoSegmentsOuterRange,
  videoSpansKey,
  withVideoOuterRange
} from "../video-segments";

const D = 60;

describe("normalizeVideoSegments", () => {
  it("sorts, clamps, and drops junk", () => {
    expect(
      normalizeVideoSegments(
        [
          { start: 40, end: 70 },
          { start: -5, end: 3 },
          { start: Number.NaN, end: 4 },
          { start: 10, end: 10 },
          { start: 20, end: 12 }
        ],
        D
      )
    ).toEqual([
      { start: 0, end: 3 },
      { start: 40, end: 60 }
    ]);
  });

  it("merges overlaps but keeps touching spans as a split", () => {
    expect(
      normalizeVideoSegments(
        [
          { start: 0, end: 5 },
          { start: 4, end: 8 },
          { start: 8.0002, end: 12 }
        ],
        D
      )
    ).toEqual([
      { start: 0, end: 8 },
      // Snapped exactly onto the previous end so the split compares with ===.
      { start: 8, end: 12 }
    ]);
  });

  it("drops spans shorter than the minimum", () => {
    expect(normalizeVideoSegments([{ start: 1, end: 1.05 }, { start: 2, end: 3 }], D)).toEqual([
      { start: 2, end: 3 }
    ]);
  });

  it("never rounds a valid float — the recorder's exact end survives", () => {
    const d = 59.1123220920563;
    expect(normalizeVideoSegments([{ start: 0, end: d }], d)).toEqual([{ start: 0, end: d }]);
  });

  it("falls back to the whole clip when nothing survives", () => {
    expect(videoSegmentsOrFull([], D)).toEqual([{ start: 0, end: D }]);
    expect(videoSegmentsOrFull(null, D)).toEqual([{ start: 0, end: D }]);
  });
});

describe("spans, cuts and duration", () => {
  const edit = [
    { start: 2, end: 5 },
    { start: 5, end: 9 },
    { start: 20, end: 30 }
  ];

  it("merges touching spans for export", () => {
    expect(videoExportSpans(edit)).toEqual([
      { start: 2, end: 9 },
      { start: 20, end: 30 }
    ]);
    expect(videoKeptDurationSec(edit)).toBe(17);
    expect(videoHasCuts(edit)).toBe(true);
    expect(videoSpansKey(videoExportSpans(edit))).toBe("2.000-9.000,20.000-30.000");
  });

  it("a split with both sides kept is not a cut", () => {
    const split = [
      { start: 0, end: 30 },
      { start: 30, end: 60 }
    ];
    expect(videoHasCuts(split)).toBe(false);
    expect(isFullClipEdit(split, D)).toBe(true);
    expect(videoExportSpans(split)).toEqual([{ start: 0, end: 60 }]);
  });

  it("lists the removed regions, with and without the outer trim", () => {
    expect(videoCuts(edit, D)).toEqual([
      { start: 0, end: 2 },
      { start: 9, end: 20 },
      { start: 30, end: 60 }
    ]);
    expect(videoCuts(edit, D, { outer: false })).toEqual([{ start: 9, end: 20 }]);
    expect(videoSegmentsOuterRange(edit)).toEqual({ start: 2, end: 30 });
  });
});

describe("withVideoOuterRange", () => {
  const edit = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
    { start: 40, end: 60 }
  ];

  it("clips spans and drops the ones pushed outside", () => {
    expect(withVideoOuterRange(edit, { start: 25, end: 50 }, D)).toEqual([
      { start: 25, end: 30 },
      { start: 40, end: 50 }
    ]);
  });

  it("extends the first span back to an in-point dragged into a cut", () => {
    expect(withVideoOuterRange(edit, { start: 15, end: 60 }, D)).toEqual([
      { start: 15, end: 30 },
      { start: 40, end: 60 }
    ]);
  });

  it("collapses to the range itself when every span falls outside", () => {
    expect(withVideoOuterRange(edit, { start: 12, end: 18 }, D)).toEqual([{ start: 12, end: 18 }]);
  });
});

describe("split / join", () => {
  it("splits the kept span under the playhead", () => {
    expect(splitVideoSegmentsAt([{ start: 0, end: 60 }], 12.5)).toEqual([
      { start: 0, end: 12.5 },
      { start: 12.5, end: 60 }
    ]);
  });

  it("is a no-op in a cut or too close to a boundary", () => {
    const edit = [
      { start: 0, end: 10 },
      { start: 20, end: 30 }
    ];
    expect(splitVideoSegmentsAt(edit, 15)).toEqual(edit);
    expect(splitVideoSegmentsAt(edit, 10.05)).toEqual(edit);
  });

  it("joins the split at a boundary", () => {
    expect(
      joinVideoSegmentsAt(
        [
          { start: 0, end: 12.5 },
          { start: 12.5, end: 60 }
        ],
        12.5
      )
    ).toEqual([{ start: 0, end: 60 }]);
  });
});

describe("pieces and toggling", () => {
  const edit = [
    { start: 5, end: 10 },
    { start: 10, end: 20 },
    { start: 30, end: 50 }
  ];

  it("enumerates every region in order", () => {
    expect(videoPieces(edit, D)).toEqual([
      { kind: "cut", where: "head", start: 0, end: 5 },
      { kind: "kept", index: 0, start: 5, end: 10 },
      { kind: "kept", index: 1, start: 10, end: 20 },
      { kind: "cut", where: "inner", start: 20, end: 30 },
      { kind: "kept", index: 2, start: 30, end: 50 },
      { kind: "cut", where: "tail", start: 50, end: 60 }
    ]);
  });

  it("cuts a kept piece and restores a cut one", () => {
    const piece = videoPieceAt(edit, D, 12)!;
    expect(piece).toMatchObject({ kind: "kept", index: 1 });
    const cut = toggleVideoPiece(edit, D, piece);
    expect(cut).toEqual([
      { start: 5, end: 10 },
      { start: 30, end: 50 }
    ]);
    const restored = toggleVideoPiece(cut, D, videoPieceAt(cut, D, 12)!);
    // Restored as its own span: both boundaries survive as splits.
    expect(restored).toEqual([
      { start: 5, end: 10 },
      { start: 10, end: 30 },
      { start: 30, end: 50 }
    ]);
  });

  it("restores a trimmed head", () => {
    expect(toggleVideoPiece(edit, D, videoPieceAt(edit, D, 1)!)[0]).toEqual({ start: 0, end: 5 });
  });

  it("refuses to cut the only kept span", () => {
    const only = [{ start: 0, end: 60 }];
    expect(toggleVideoPiece(only, D, videoPieceAt(only, D, 30)!)).toEqual(only);
  });
});

describe("cutVideoSegments", () => {
  it("cuts inside, across, and at the edges of spans", () => {
    expect(
      cutVideoSegments(
        [{ start: 0, end: 60 }],
        [
          { start: 5, end: 12 },
          { start: 30, end: 41 },
          { start: 55, end: 70 }
        ],
        D
      )
    ).toEqual([
      { start: 0, end: 5 },
      { start: 12, end: 30 },
      { start: 41, end: 55 }
    ]);
  });

  it("composes with existing cuts", () => {
    expect(
      cutVideoSegments(
        [
          { start: 0, end: 10 },
          { start: 20, end: 60 }
        ],
        [{ start: 8, end: 25 }],
        D
      )
    ).toEqual([
      { start: 0, end: 8 },
      { start: 25, end: 60 }
    ]);
  });

  it("never cuts everything", () => {
    const edit = [{ start: 0, end: 60 }];
    expect(cutVideoSegments(edit, [{ start: 0, end: 60 }], D)).toEqual(edit);
  });
});

describe("nextPlayableVideoTime", () => {
  const edit = [
    { start: 5, end: 10 },
    { start: 20, end: 30 }
  ];

  it("skips the head and cuts, and ends after the last span", () => {
    expect(nextPlayableVideoTime(edit, 0)).toBe(5);
    expect(nextPlayableVideoTime(edit, 7)).toBe(7);
    expect(nextPlayableVideoTime(edit, 10)).toBe(20);
    expect(nextPlayableVideoTime(edit, 15)).toBe(20);
    expect(nextPlayableVideoTime(edit, 30)).toBeNull();
  });
});

describe("videoEditPlaybackStep", () => {
  const SPANS = [
    { start: 0, end: 2 },
    { start: 8, end: 11 },
    { start: 16, end: 20 }
  ];

  describe("the element is the clock (Library stage)", () => {
    it("plays inside a kept part", () => {
      expect(videoEditPlaybackStep(SPANS, 9)).toEqual({ kind: "play" });
    });

    it("jumps a cut to the next part, and the head from before the first part", () => {
      expect(videoEditPlaybackStep(SPANS, 2)).toEqual({ kind: "seek", sec: 8 });
      expect(videoEditPlaybackStep(SPANS, 12.5)).toEqual({ kind: "seek", sec: 16 });
      expect(videoEditPlaybackStep([{ start: 3, end: 5 }], 1)).toEqual({ kind: "seek", sec: 3 });
    });

    it("does not re-seek a landing a hair short of the part's start", () => {
      expect(videoEditPlaybackStep(SPANS, 7.997)).toEqual({ kind: "play" });
    });

    it("ends at the last kept instant", () => {
      expect(videoEditPlaybackStep(SPANS, 19.996)).toEqual({ kind: "end" });
      expect(videoEditPlaybackStep(SPANS, 25)).toEqual({ kind: "end" });
    });
  });

  describe("a separate head is the clock (reel preview)", () => {
    it("leaves the element alone inside the head's part, drift and all", () => {
      expect(videoEditPlaybackStep(SPANS, 9.4, 9)).toEqual({ kind: "play" });
      expect(videoEditPlaybackStep(SPANS, 8.9, 9.4)).toEqual({ kind: "play" });
    });

    it("jumps an element that ran into a cut to the next part", () => {
      expect(videoEditPlaybackStep(SPANS, 2.05, 1.95)).toEqual({ kind: "seek", sec: 8 });
    });

    it("sends a lagging element to where the head crossed to", () => {
      expect(videoEditPlaybackStep(SPANS, 1.98, 8.05)).toEqual({ kind: "seek", sec: 8.05 });
    });

    it("does not drag an element that is one cut AHEAD back into the old part", () => {
      expect(videoEditPlaybackStep(SPANS, 8.02, 1.95)).toEqual({ kind: "play" });
    });

    it("follows the head when a loop wraps back to the first part", () => {
      expect(videoEditPlaybackStep(SPANS, 19.9, 0.1)).toEqual({ kind: "seek", sec: 0.1 });
    });

    it("leaves the element parked on the last kept instant", () => {
      expect(videoEditPlaybackStep(SPANS, 20, 20)).toEqual({ kind: "play" });
    });
  });
});
