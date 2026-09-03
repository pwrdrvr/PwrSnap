import { describe, expect, test } from "vitest";
import { FfmpegProgressParser } from "../ffmpeg-progress";

describe("FfmpegProgressParser", () => {
  test("parses arbitrary Buffer and string chunks with LF and CRLF records", () => {
    const parser = new FfmpegProgressParser(10);

    expect(parser.push(Buffer.from("out_time_us=1"))).toEqual([]);
    expect(parser.push("000000\r\nprogress=cont")).toEqual([]);
    expect(
      parser.push(
        Buffer.from(
          "inue\r\nout_time_us=2000000=invalid\nout_time_ms=2500000\nprogress=end\n"
        )
      )
    ).toEqual([
      { progress: "continue", outTimeSec: 1, ratio: 0.1 },
      { progress: "end", outTimeSec: 2.5, ratio: 0.25 }
    ]);
  });

  test("prefers out_time_us over the legacy microsecond-valued out_time_ms and clock time", () => {
    const parser = new FfmpegProgressParser(20);

    expect(
      parser.push(
        "out_time_us=2500000\nout_time_ms=7000000\nout_time=00:00:09.000000\nprogress=continue\n"
      )
    ).toEqual([{ progress: "continue", outTimeSec: 2.5, ratio: 0.125 }]);
  });

  test("falls back from invalid microsecond fields to out_time_ms and then out_time", () => {
    const parser = new FfmpegProgressParser(100);

    expect(
      parser.push(
        [
          "out_time_us=N/A",
          "out_time_ms=1250000",
          "out_time=00:00:09.000000",
          "progress=continue",
          "out_time_us=-1",
          "out_time_ms=N/A",
          "out_time=00:01:02.500000",
          "progress=end",
          ""
        ].join("\n")
      )
    ).toEqual([
      { progress: "continue", outTimeSec: 1.25, ratio: 0.0125 },
      { progress: "end", outTimeSec: 62.5, ratio: 0.625 }
    ]);
  });

  test("ignores invalid timestamps and keeps ratios clamped and monotonic", () => {
    const parser = new FfmpegProgressParser(10);

    expect(
      parser.push(
        [
          "out_time_us=8000000",
          "progress=continue",
          "out_time_us=-1",
          "out_time_ms=N/A",
          "out_time=invalid",
          "progress=continue",
          "out_time_us=3000000",
          "progress=continue",
          "out_time_us=15000000",
          "progress=end",
          ""
        ].join("\n")
      )
    ).toEqual([
      { progress: "continue", outTimeSec: 8, ratio: 0.8 },
      { progress: "continue", outTimeSec: null, ratio: 0.8 },
      { progress: "continue", outTimeSec: 3, ratio: 0.8 },
      { progress: "end", outTimeSec: 15, ratio: 1 }
    ]);
  });

  test.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns a null ratio for invalid duration %s",
    (durationSec) => {
      const parser = new FfmpegProgressParser(durationSec);
      expect(parser.push("out_time_us=5000000\nprogress=continue\n")).toEqual([
        { progress: "continue", outTimeSec: 5, ratio: null }
      ]);
    }
  );

  test("finish parses a final CRLF-compatible record without a trailing newline", () => {
    const parser = new FfmpegProgressParser(10);

    expect(parser.push("out_time=00:00:04.500000\r\nprogress=end\r")).toEqual([]);
    expect(parser.finish()).toEqual([
      { progress: "end", outTimeSec: 4.5, ratio: 0.45 }
    ]);
    expect(parser.finish()).toEqual([]);
  });

  test("does not emit fields without a progress record terminator", () => {
    const parser = new FfmpegProgressParser(10);

    expect(parser.push("out_time_us=1000000\nunknown=value=with=equals")).toEqual([]);
    expect(parser.finish()).toEqual([]);
  });

  test("rejects chunks pushed after finish", () => {
    const parser = new FfmpegProgressParser(10);
    parser.finish();

    expect(() => parser.push("progress=end\n")).toThrow(
      "cannot push FFmpeg progress after finish()"
    );
  });
});
