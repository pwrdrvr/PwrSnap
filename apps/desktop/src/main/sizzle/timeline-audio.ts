import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  unlink
} from "node:fs/promises";
import { join } from "node:path";
import {
  resolveSizzleText,
  sizzleTimelineFrames,
  type SizzleTimeline,
  type SizzleTimelineAudio,
  type SizzleAsset
} from "@pwrsnap/shared";
import { timelineAssetPath } from "./timeline-assets";
import { timelineProcess, probeTimelineMedia } from "./timeline-process";
import { synthesizeTimelineMusic } from "./timeline-music";

export type TimelineAudioReport = {
  trackId: string;
  inputDurationSec: number;
  slotDurationSec: number;
  playbackRate: number;
  transcript?: string;
  qa: "matched" | "not_requested";
};
export const TIMELINE_AUDIO_VERSION = 3;
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exists = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => null))?.isFile() ?? false;

export function fitTimelineAudio(
  durationSec: number,
  slotSec: number,
  fit: SizzleTimelineAudio["fit"],
  maxSpeed: number
): number {
  if (
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    !Number.isFinite(slotSec) ||
    slotSec <= 0
  )
    throw new Error("Audio has no measurable duration");
  if (durationSec <= slotSec + 0.015 || fit === "trim" || fit === "loop")
    return 1;
  const rate = durationSec / slotSec;
  if (fit !== "speed" || rate > maxSpeed)
    throw new Error(
      `Audio needs ${durationSec.toFixed(2)} s for a ${slotSec.toFixed(2)} s slot; required speed ${rate.toFixed(3)} exceeds the chosen fit policy`
    );
  return rate;
}

export function timelineTranscriptMatches(
  expected: string,
  actual: string,
  requiredAliases: readonly [string, string][] = []
): boolean {
  const tokens = (text: string): string[] => {
    const words = text
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[−-](?=\d)/g, " minus ")
      .replace(/-/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(/\s+/)
      .filter(Boolean)
      // ASR cannot distinguish these identical pronunciations. This is a
      // spelling normalization, never fuzzy matching of a hinted brand name.
      .map((word) =>
        word === "disc" ? "disk" : word === "discs" ? "disks" : word
      );
    // Narration may be transcribed as digits or spoken English. Canonicalize
    // integer phrases before checking them: one wrong metric must not fit
    // inside the sentence's general word-error allowance.
    const small = new Map([
      ...[
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen"
      ].map((word, value) => [word, value] as const),
      ...[
        "twenty",
        "thirty",
        "forty",
        "fifty",
        "sixty",
        "seventy",
        "eighty",
        "ninety"
      ].map((word, i) => [word, (i + 2) * 10] as const)
    ]);
    const scales = new Map([
      ["thousand", 1000],
      ["million", 1_000_000],
      ["billion", 1_000_000_000],
      ["trillion", 1_000_000_000_000]
    ]);
    const numeric = (word: string | undefined): boolean =>
      Boolean(
        word &&
        (small.has(word) ||
          scales.has(word) ||
          word === "hundred" ||
          /^\d+$/.test(word))
      );
    const result: string[] = [];
    for (let at = 0; at < words.length;) {
      const negative =
        (words[at] === "minus" || words[at] === "negative") &&
        numeric(words[at + 1]);
      let end = at + Number(negative),
        current = 0,
        total = 0,
        seen = false;
      while (end < words.length) {
        const word = words[end]!;
        if (word === "and" && seen && numeric(words[end + 1])) {
          end++;
          continue;
        }
        if (!numeric(word)) break;
        const previous = words[end - 1];
        if (
          seen &&
          previous &&
          (small.has(previous) || /^\d+$/.test(previous)) &&
          (small.has(word) || /^\d+$/.test(word)) &&
          !((small.get(previous) ?? 0) >= 20 && (small.get(word) ?? 100) < 10)
        )
          break;
        if (word === "hundred") current = (seen ? current : 1) * 100;
        else if (scales.has(word)) {
          total += (seen ? current : 1) * scales.get(word)!;
          current = 0;
        } else current += small.get(word) ?? Number(word);
        seen = true;
        end++;
      }
      if (seen && Number.isSafeInteger(total + current)) {
        result.push(String((negative ? -1 : 1) * (total + current)));
        at = end;
      } else result.push(words[at++]!);
    }
    return result;
  };
  let a = tokens(expected),
    b = tokens(actual);
  const starts = (words: string[], phrase: string[], at: number): boolean =>
    phrase.length > 0 && phrase.every((word, i) => words[at + i] === word);
  const rewrite = (words: string[], from: string[], to: string[]): string[] => {
    if (!from.length) return words;
    const result: string[] = [];
    for (let i = 0; i < words.length;) {
      if (starts(words, from, i)) {
        result.push(...to);
        i += from.length;
      } else {
        result.push(words[i]!);
        i++;
      }
    }
    return result;
  };
  // Brand/pronunciation hints are exact requirements. An overall word-error
  // allowance must not hide "Disk Free" inside an otherwise correct sentence.
  for (const [original, spoken] of requiredAliases) {
    const from = tokens(original),
      to = tokens(spoken);
    if (!to.length) continue;
    a = rewrite(a, from, to);
    b = rewrite(b, from, to);
    b = rewrite(b, [to.join("")], to);
    b = rewrite(
      b,
      [
        to
          .map((word) =>
            word === "disk" ? "disc" : word === "disks" ? "discs" : word
          )
          .join("")
      ],
      to
    );
    const count = (words: string[]): number =>
      words.reduce((sum, _word, at) => sum + Number(starts(words, to, at)), 0);
    if (count(b) < count(a)) return false;
  }
  const numbers = (words: string[]): string =>
    words.filter((word) => /^-?\d+$/.test(word)).join(" ");
  if (numbers(a) !== numbers(b)) return false;
  if (!a.length || !b.length) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    previous = current;
  }
  return previous[b.length]! / Math.max(a.length, b.length) <= 0.15;
}

export function timelinePronunciationAliases(
  source: SizzleTimelineAudio["source"],
  bindings: SizzleTimeline["bindings"]
): [string, string][] {
  if (source.kind !== "speech") return [];
  const script = resolveSizzleText(source.text, bindings);
  return Object.entries(source.pronunciation).filter(([original]) =>
    script.includes(original)
  );
}

export async function transcribeTimelineAudio(
  path: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string> {
  if ((await stat(path)).size > 24 * 1024 ** 2)
    throw new Error(
      "Transcription input exceeds 24 MiB; use a shorter narration take"
    );
  const form = new FormData();
  form.append(
    "file",
    new Blob([await readFile(path)], { type: "audio/wav" }),
    "narration.wav"
  );
  form.append("model", "whisper-1");
  form.append("response_format", "json");
  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000)
    }
  );
  if (!response.ok)
    throw new Error(`Narration transcription failed (HTTP ${response.status})`);
  const result = (await response.json()) as { text?: unknown };
  if (typeof result.text !== "string" || result.text.length > 20_000)
    throw new Error("Narration transcription returned invalid text");
  return result.text;
}

/** Transcript identity is the audio, not its slot, gain, fades, or caption.
 * Re-fitting or remixing a take must not spend another transcription request. */
export async function cachedTimelineTranscript(
  path: string,
  apiKey: string,
  cacheRoot: string,
  signal?: AbortSignal
): Promise<string> {
  if ((await stat(path)).size > 24 * 1024 ** 2)
    throw new Error(
      "Transcription input exceeds 24 MiB; use a shorter narration take"
    );
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  const destination = join(cacheRoot, `transcript-whisper-1-${digest}.json`);
  const cached = await readFile(destination, "utf8").catch(() => "null");
  try {
    const value: unknown = JSON.parse(cached);
    if (typeof value === "string" && value.length <= 20_000) return value;
  } catch {
    /* Rebuild an invalid derived transcript. */
  }
  const transcript = await transcribeTimelineAudio(path, apiKey, signal);
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, JSON.stringify(transcript));
    signal?.throwIfAborted();
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return transcript;
}

async function speech(
  source: Extract<SizzleTimelineAudio["source"], { kind: "speech" }>,
  bindings: SizzleTimeline["bindings"],
  root: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<{ path: string; spokenText: string }> {
  let spokenText = resolveSizzleText(source.text, bindings);
  // Longer substitutions run first, so 'PwrDisk Pro' cannot be consumed by
  // a shorter 'PwrDisk' hint. Substitutions are literal, never regex/code.
  for (const [from, to] of Object.entries(source.pronunciation).sort(
    (a, b) => b[0].length - a[0].length
  ))
    spokenText = spokenText.split(from).join(to);
  if (!spokenText.trim() || spokenText.length > 4096)
    throw new Error(
      "Spoken text must contain 1–4096 characters after substitutions"
    );
  const body = {
    model: source.model,
    voice: source.voice,
    input: spokenText,
    instructions: source.instructions,
    speed: source.speed,
    response_format: "wav"
  };
  const path = join(
    root,
    `speech-${hash({ body, takeId: source.takeId })}.wav`
  );
  if (!(await exists(path))) {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000)
    });
    if (!response.ok)
      throw new Error(`Speech generation failed (HTTP ${response.status})`);
    const audio = Buffer.from(await response.arrayBuffer());
    if (
      audio.length < 44 ||
      audio.length > 64 * 1024 ** 2 ||
      audio.toString("ascii", 0, 4) !== "RIFF"
    )
      throw new Error("Speech generation returned invalid WAV audio");
    const temporary = `${path}.${randomUUID()}.partial`;
    try {
      await writeFile(temporary, audio);
      signal?.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  return { path, spokenText };
}

export async function prepareTimelineAudio(args: {
  timeline: SizzleTimeline;
  assets: SizzleAsset[];
  assetsRoot: string;
  cacheRoot: string;
  ffmpeg: string;
  apiKey: string | null;
  signal?: AbortSignal;
}): Promise<{ path?: string; reports: TimelineAudioReport[] }> {
  const { timeline, assets, assetsRoot, cacheRoot, ffmpeg, apiKey, signal } =
    args;
  if (!timeline.audio.length) return { reports: [] };
  await mkdir(cacheRoot, { recursive: true });
  const reports: TimelineAudioReport[] = [];
  const prepared: Array<{ track: SizzleTimelineAudio; path: string }> = [];
  for (const track of timeline.audio) {
    signal?.throwIfAborted();
    let input: string,
      sourceStart = 0,
      expectedText = track.expectedText
        ? resolveSizzleText(track.expectedText, timeline.bindings)
        : null;
    if (track.source.kind === "speech") {
      if (!apiKey)
        throw new Error(
          "Set an OpenAI API key in Settings before generating narration"
        );
      const generated = await speech(
        track.source,
        timeline.bindings,
        cacheRoot,
        apiKey,
        signal
      );
      input = generated.path;
      expectedText ??= generated.spokenText;
    } else if (track.source.kind === "synth") {
      input = join(
        cacheRoot,
        `music-${hash({ source: track.source, duration: track.durationFrames, fps: timeline.fps })}.wav`
      );
      if (!(await exists(input))) {
        const { bpm, dropFrame, finalHitFrame, seed } = track.source;
        const temporary = `${input}.${randomUUID()}.partial`;
        try {
          await writeFile(
            temporary,
            await synthesizeTimelineMusic(
              {
                durationSec: track.durationFrames / timeline.fps,
                bpm,
                dropSec: dropFrame / timeline.fps,
                seed,
                ...(finalHitFrame === undefined
                  ? {}
                  : { finalHitSec: finalHitFrame / timeline.fps })
              },
              signal
            )
          );
          signal?.throwIfAborted();
          await rename(temporary, input);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      }
    } else {
      const assetId = track.source.assetId;
      const source = assets.find((a) => a.id === assetId);
      if (!source || !["audio", "video"].includes(source.kind))
        throw new Error(`Missing audio asset: ${track.id}`);
      input = timelineAssetPath(assetsRoot, source);
      sourceStart = track.source.trimStartSec;
      if (sourceStart >= source.durationSec)
        throw new Error(`Audio starts beyond source end: ${track.id}`);
    }
    const slotSec = track.durationFrames / timeline.fps;
    const key = hash({
      version: TIMELINE_AUDIO_VERSION,
      track,
      bindings:
        track.source.kind === "speech"
          ? resolveSizzleText(track.source.text, timeline.bindings)
          : null,
      input,
      expectedText,
      fps: timeline.fps
    });
    const path = join(cacheRoot, `track-${key}.wav`);
    const reportPath = join(cacheRoot, `track-${key}.json`);
    if ((await exists(path)) && (await exists(reportPath))) {
      reports.push(
        JSON.parse(await readFile(reportPath, "utf8")) as TimelineAudioReport
      );
      prepared.push({ track, path });
      continue;
    }
    const raw = join(cacheRoot, `.audio-${randomUUID()}.wav`);
    try {
      const probe = await probeTimelineMedia(ffmpeg, input, signal);
      if (track.role === "voice" && probe.durationSec - sourceStart > 600)
        throw new Error(`Narration source exceeds 10 minutes: ${track.id}`);
      const trim = track.trimSilence
        ? ",silenceremove=start_periods=1:start_duration=0.03:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-45dB,areverse"
        : "";
      await timelineProcess(
        ffmpeg,
        [
          "-hide_banner",
          "-y",
          "-protocol_whitelist",
          "file,pipe",
          "-ss",
          String(sourceStart),
          "-i",
          input,
          "-vn",
          "-t",
          String(
            track.fit === "trim" || track.fit === "loop"
              ? slotSec
              : Math.min(600, probe.durationSec)
          ),
          "-af",
          `aresample=48000,aformat=channel_layouts=stereo${trim}`,
          "-c:a",
          "pcm_s16le",
          raw
        ],
        signal
      );
      const inputDurationSec = (await probeTimelineMedia(ffmpeg, raw, signal))
        .durationSec;
      const playbackRate = fitTimelineAudio(
        inputDurationSec,
        slotSec,
        track.fit,
        track.maxSpeed
      );
      let transcript: string | undefined;
      if (expectedText) {
        if (!apiKey)
          throw new Error(
            "Set an OpenAI API key to verify the expected narration transcript"
          );
        transcript = await cachedTimelineTranscript(
          raw,
          apiKey,
          cacheRoot,
          signal
        );
        const aliases = timelinePronunciationAliases(
          track.source,
          timeline.bindings
        );
        if (!timelineTranscriptMatches(expectedText, transcript, aliases))
          throw new Error(
            `Narration QA failed for ${track.id}; expected ${JSON.stringify(expectedText.slice(0, 300))}; heard ${JSON.stringify(transcript.slice(0, 300))}`
          );
      }
      const filters = [
        `atempo=${playbackRate.toFixed(8)}`,
        `apad=whole_dur=${slotSec}`,
        `atrim=duration=${slotSec}`,
        `volume=${track.volume}`
      ];
      if (track.fadeInFrames)
        filters.push(`afade=t=in:st=0:d=${track.fadeInFrames / timeline.fps}`);
      if (track.fadeOutFrames)
        filters.push(
          `afade=t=out:st=${Math.max(0, slotSec - track.fadeOutFrames / timeline.fps)}:d=${track.fadeOutFrames / timeline.fps}`
        );
      const temporary = `${path}.${randomUUID()}.wav`;
      try {
        await timelineProcess(
          ffmpeg,
          [
            "-hide_banner",
            "-y",
            ...(track.fit === "loop" ? ["-stream_loop", "-1"] : []),
            "-i",
            raw,
            "-af",
            filters.join(","),
            "-t",
            String(slotSec),
            "-c:a",
            "pcm_s16le",
            temporary
          ],
          signal
        );
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      const report: TimelineAudioReport = {
        trackId: track.id,
        inputDurationSec,
        slotDurationSec: slotSec,
        playbackRate,
        qa: transcript === undefined ? "not_requested" : "matched",
        ...(transcript === undefined ? {} : { transcript })
      };
      await writeFile(reportPath, JSON.stringify(report, null, 2));
      reports.push(report);
      prepared.push({ track, path });
    } finally {
      await unlink(raw).catch(() => undefined);
    }
  }
  const duration = sizzleTimelineFrames(timeline) / timeline.fps;
  const mixPath = join(
    cacheRoot,
    `mix-${hash({ version: 1, paths: prepared, mix: timeline.mix, duration })}.wav`
  );
  if (!(await exists(mixPath))) {
    const inputs = prepared.flatMap((p) => ["-i", p.path]);
    const filters = prepared.map(
      ({ track }, i) =>
        `[${i}:a]adelay=${Math.round((track.startFrame / timeline.fps) * 48000)}S:all=1,apad,atrim=duration=${duration}[t${i}]`
    );
    const voice = prepared.flatMap((p, i) =>
      p.track.role === "voice" ? [`[t${i}]`] : []
    );
    const music = prepared.flatMap((p, i) =>
      p.track.role === "music" ? [`[t${i}]`] : []
    );
    const other = prepared.flatMap((p, i) =>
      p.track.role === "sound" ? [`[t${i}]`] : []
    );
    const sum = (labels: string[], name: string): void => {
      filters.push(
        `${labels.join("")}amix=inputs=${labels.length}:normalize=0[${name}]`
      );
    };
    const outputs: string[] = [];
    if (voice.length && music.length && timeline.mix.duckMusic) {
      sum(voice, "voice");
      sum(music, "music");
      filters.push(
        "[voice]asplit[spoken][sidechain]",
        "[music][sidechain]sidechaincompress=threshold=0.04:ratio=6:attack=15:release=250[ducked]"
      );
      outputs.push("[spoken]", "[ducked]");
    } else outputs.push(...voice, ...music);
    outputs.push(...other);
    sum(outputs, "mixed");
    filters.push(
      `[mixed]loudnorm=I=${timeline.mix.loudnessLufs}:TP=-1:LRA=9,aresample=48000,atrim=duration=${duration}[out]`
    );
    const temporary = `${mixPath}.${randomUUID()}.wav`;
    try {
      await timelineProcess(
        ffmpeg,
        [
          "-hide_banner",
          "-y",
          ...inputs,
          "-filter_complex",
          filters.join(";"),
          "-map",
          "[out]",
          "-c:a",
          "pcm_s16le",
          temporary
        ],
        signal
      );
      await rename(temporary, mixPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  return { path: mixPath, reports };
}
