import { readFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SizzleTimelineSchema,
  resolveSizzleText,
  type Res
} from "@pwrsnap/shared";
import { timelineProcess, probeTimelineMedia } from "./timeline-process";
import {
  cachedTimelineTranscript,
  timelineTranscriptMatches
} from "./timeline-audio";

export async function inspectTimelineAudio(args: {
  outputPath: string;
  cacheRoot: string;
  ffmpeg: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<Res<"sizzle:audioQa">> {
  const { outputPath, cacheRoot, ffmpeg, apiKey, signal } = args;
  const probe = await probeTimelineMedia(ffmpeg, outputPath, signal);
  if (probe.durationSec > 600)
    throw new Error("Audio QA is limited to reels of ten minutes or less");
  await mkdir(cacheRoot, { recursive: true });
  const path = join(cacheRoot, `sizzle-audio-qa-${randomUUID()}.wav`);
  try {
    await timelineProcess(
      ffmpeg,
      [
        "-hide_banner",
        "-y",
        "-i",
        outputPath,
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        path
      ],
      signal
    );
    const transcript = await cachedTimelineTranscript(
      path,
      apiKey,
      cacheRoot,
      signal
    );
    const loudness = await timelineProcess(
      ffmpeg,
      [
        "-hide_banner",
        "-i",
        outputPath,
        "-vn",
        "-af",
        "loudnorm=I=-14:TP=-1:LRA=9:print_format=json",
        "-f",
        "null",
        "-"
      ],
      signal
    );
    const json = /\{\s*"input_i"[\s\S]*?\}/.exec(loudness)?.[0];
    const measured = json
      ? (JSON.parse(json) as { input_i: string; input_tp: string })
      : null;
    const raw = await readFile(`${outputPath}.timeline.json`, "utf8").catch(
      () => "null"
    );
    let data: unknown = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* A missing/damaged sidecar still permits transcription-only QA. */
    }
    const timeline = SizzleTimelineSchema.safeParse(data);
    const parts = timeline.success
      ? timeline.data.audio
          .filter((a) => a.role === "voice")
          .sort((a, b) => a.startFrame - b.startFrame)
          .map((track) => {
            if (track.expectedText)
              return resolveSizzleText(
                track.expectedText,
                timeline.data.bindings
              );
            if (track.source.kind !== "speech") return null;
            let text = resolveSizzleText(
              track.source.text,
              timeline.data.bindings
            );
            for (const [from, to] of Object.entries(
              track.source.pronunciation
            ).sort((a, b) => b[0].length - a[0].length))
              text = text.split(from).join(to);
            return text;
          })
      : [];
    const expectedText =
      parts.length && parts.every((p) => p !== null) ? parts.join(" ") : null;
    return {
      transcript,
      expectedText,
      matches: expectedText
        ? timelineTranscriptMatches(expectedText, transcript)
        : null,
      integratedLufs:
        measured && Number.isFinite(Number(measured.input_i))
          ? Number(measured.input_i)
          : null,
      truePeakDb:
        measured && Number.isFinite(Number(measured.input_tp))
          ? Number(measured.input_tp)
          : null
    };
  } finally {
    await unlink(path).catch(() => undefined);
  }
}
