import { describe, expect, test } from "vitest";
import {
  buildRecordingAudioArgs,
  buildRecordingAudioSpanArgs,
  selectedRecordingAudioStreams
} from "../recording-audio";

const BOTH = { includeSystemAudio: true, includeMicrophone: true };

describe("selectedRecordingAudioStreams", () => {
  // The recorder adds a writer input when a source is ARMED, so that — not
  // whether samples later arrived — is what fixes each track's position.
  test("a silent-but-armed system track still holds the microphone's slot", () => {
    expect(
      selectedRecordingAudioStreams(
        {
          hasSystemAudio: false,
          hasMicrophoneAudio: true,
          requestedSystemAudio: true,
          requestedMicrophone: true
        },
        BOTH,
        2
      )
    ).toEqual([1]);
  });

  test("an unarmed system source leaves the microphone at index 0", () => {
    expect(
      selectedRecordingAudioStreams(
        {
          hasSystemAudio: false,
          hasMicrophoneAudio: true,
          requestedSystemAudio: false,
          requestedMicrophone: true
        },
        BOTH,
        1
      )
    ).toEqual([0]);
  });

  // Pre-0033 recordings have no arm record at all; `hasX` is the only
  // evidence a track exists, which is exactly how they were written.
  test("legacy metadata with no arm record positions by samples", () => {
    expect(
      selectedRecordingAudioStreams({ hasSystemAudio: true, hasMicrophoneAudio: true }, BOTH, 2)
    ).toEqual([0, 1]);
    expect(
      selectedRecordingAudioStreams({ hasSystemAudio: false, hasMicrophoneAudio: true }, BOTH, 1)
    ).toEqual([0]);
  });

  // A file with fewer tracks than the arm record claims cannot have had an
  // input per armed source. Relocating beats deleting: filtering an
  // out-of-range index would drop the microphone entirely.
  test("a file shorter than its arm record falls back to sample positions", () => {
    expect(
      selectedRecordingAudioStreams(
        {
          hasSystemAudio: false,
          hasMicrophoneAudio: true,
          requestedSystemAudio: true,
          requestedMicrophone: true
        },
        BOTH,
        1
      )
    ).toEqual([0]);
  });

  test("export toggles still subtract from whatever was recorded", () => {
    const dual = {
      hasSystemAudio: true,
      hasMicrophoneAudio: true,
      requestedSystemAudio: true,
      requestedMicrophone: true
    };
    expect(
      selectedRecordingAudioStreams(dual, { includeSystemAudio: false, includeMicrophone: true }, 2)
    ).toEqual([1]);
    expect(
      selectedRecordingAudioStreams(dual, { includeSystemAudio: true, includeMicrophone: false }, 2)
    ).toEqual([0]);
    expect(
      selectedRecordingAudioStreams(dual, { includeSystemAudio: false, includeMicrophone: false }, 2)
    ).toEqual([]);
  });
});

describe("buildRecordingAudioArgs", () => {
  test("a mix never attenuates by input count", () => {
    // amix's default divides every input by `inputs`, which made a two-source
    // export exactly 6 dB quieter than the same content exported from one
    // source — loudness as a function of how many sources were armed.
    const args = buildRecordingAudioArgs([0, 1]).join(" ");
    expect(args).toContain("normalize=0");
    expect(args).not.toContain("normalize=1");
  });

  test("one stream maps optionally and never builds a filter graph", () => {
    // Filter labels cannot be optional, so a lone stream has to stay on the
    // `-map` path for recordings whose metadata promised more than it holds.
    expect(buildRecordingAudioArgs([1])).toEqual(["-map", "0:a:1?"]);
  });

  test("no streams disables audio outright", () => {
    expect(buildRecordingAudioArgs([])).toEqual(["-an"]);
  });
});

describe("buildRecordingAudioSpanArgs", () => {
  const SPANS = [
    { start: 1, end: 2.5 },
    { start: 6, end: 8.25 }
  ];

  test("one track: resampled onto the video clock, cut per span, joined", () => {
    const args = buildRecordingAudioSpanArgs([0], SPANS);
    expect(args[0]).toBe("-filter_complex");
    expect(args[1]!.split(";")).toEqual([
      "[0:a:0]aresample=async=1:first_pts=0[recorded_audio_0]",
      "[recorded_audio_0]asplit=2[span_audio_0][span_audio_1]",
      "[span_audio_0]atrim=start=1.000:end=2.500,asetpts=PTS-STARTPTS[kept_audio_0]",
      "[span_audio_1]atrim=start=6.000:end=8.250,asetpts=PTS-STARTPTS[kept_audio_1]",
      "[kept_audio_0][kept_audio_1]concat=n=2:v=0:a=1[recorded_audio]"
    ]);
    expect(args.slice(2)).toEqual(["-map", "[recorded_audio]"]);
  });

  test("two tracks: the same un-normalized mix as the uncut path, then cut", () => {
    const graph = buildRecordingAudioSpanArgs([0, 1], SPANS)[1]!;
    expect(graph).toContain(
      "[recorded_audio_0][recorded_audio_1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,asplit=2"
    );
  });

  test("no tracks: no audio", () => {
    expect(buildRecordingAudioSpanArgs([], SPANS)).toEqual(["-an"]);
  });
});
