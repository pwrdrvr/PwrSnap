import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { app } from "electron";
import type {
  SizzleResolvedPhraseTiming,
  SizzleSpeechTiming,
  SizzleSpeechTimingWarning,
  SizzleTtsModel,
  SizzleTtsProvider,
  SizzleVoice,
  SizzleWordTiming
} from "@pwrsnap/shared";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:sizzle-speech-timing");

type RawTranscribedWord = {
  word: string;
  startSec: number;
  endSec: number;
};

export type SpeechTimingTranscriber = (args: {
  apiKey: string;
  audioPath: string;
}) => Promise<RawTranscribedWord[]>;

export type SpeechTimingRequest = {
  provider: SizzleTtsProvider;
  model: SizzleTtsModel;
  voice: SizzleVoice;
  text: string;
  audioPath: string;
  durationSec: number;
  apiKey: string | null;
  transcribe?: SpeechTimingTranscriber;
};

export type SpeechTimingResult = SizzleSpeechTiming & {
  cached: boolean;
};

export async function resolveSpeechTiming(
  req: SpeechTimingRequest
): Promise<SpeechTimingResult> {
  const text = req.text.trim();
  const warnings: SizzleSpeechTimingWarning[] = [];
  const audioHash = await hashFile(req.audioPath).catch((cause) => {
    warnings.push({
      code: "timing_cache_failed",
      message: `Could not hash narration audio for timing cache: ${messageOf(cause)}`
    });
    return "";
  });
  const cachePath = join(speechTimingCacheDir(), `${speechTimingCacheKey(req, audioHash)}.json`);
  const cached = audioHash.length > 0 ? await readCachedTiming(cachePath) : null;
  if (cached !== null) return { ...cached, cached: true };

  let timing: SizzleSpeechTiming | null = null;
  if (req.provider === "openai" && req.apiKey !== null && req.apiKey.length > 0) {
    try {
      const words = await (req.transcribe ?? transcribeWithOpenAi)({
        apiKey: req.apiKey,
        audioPath: req.audioPath
      });
      const normalized = normalizeTranscribedWords(words, text, req.durationSec);
      if (normalized.length > 0) {
        timing = {
          text,
          durationSec: req.durationSec,
          quality: "precise",
          words: normalized,
          warnings
        };
      } else {
        warnings.push({
          code: "precise_failed",
          message: "Transcription returned no word timestamps"
        });
      }
    } catch (cause) {
      warnings.push({
        code: "precise_failed",
        message: `Precise narration timing failed: ${messageOf(cause)}`
      });
    }
  } else {
    warnings.push({
      code: "precise_unavailable",
      message: "Precise narration timing is unavailable for this provider or missing credentials"
    });
  }

  timing ??= approximateSpeechTiming(text, req.durationSec, warnings);
  if (audioHash.length > 0) {
    await writeCachedTiming(cachePath, timing).catch((cause) => {
      log.warn("speech timing cache write failed", {
        path: cachePath,
        message: messageOf(cause)
      });
    });
  }
  return { ...timing, cached: false };
}

export function approximateSpeechTiming(
  text: string,
  durationSec: number,
  warnings: SizzleSpeechTimingWarning[] = []
): SizzleSpeechTiming {
  const trimmed = text.trim();
  const outWarnings = [...warnings];
  if (trimmed.length === 0) {
    outWarnings.push({
      code: "empty_narration",
      message: "Narration is empty"
    });
    return {
      text: trimmed,
      durationSec: finitePositive(durationSec) ? durationSec : 0,
      quality: "approximate",
      words: [],
      warnings: outWarnings
    };
  }
  if (!finitePositive(durationSec)) {
    outWarnings.push({
      code: "invalid_duration",
      message: "Narration audio duration is unavailable"
    });
  }
  const duration = finitePositive(durationSec) ? durationSec : Math.max(1, trimmed.length / 14);
  const tokens = tokenizeWords(trimmed);
  if (tokens.length === 0) {
    return {
      text: trimmed,
      durationSec: duration,
      quality: "approximate",
      words: [],
      warnings: outWarnings
    };
  }
  const gapSec = Math.min(0.06, duration / Math.max(1, tokens.length * 8));
  const speechSec = Math.max(0.01, duration - gapSec * Math.max(0, tokens.length - 1));
  const totalWeight = tokens.reduce((sum, token) => sum + Math.max(1, token.normalized.length), 0);
  let cursor = 0;
  const words = tokens.map((token, index): SizzleWordTiming => {
    const isLast = index === tokens.length - 1;
    const wordDuration = isLast
      ? Math.max(0.01, duration - cursor)
      : Math.max(0.01, speechSec * (Math.max(1, token.normalized.length) / totalWeight));
    const startSec = roundSec(cursor);
    const endSec = roundSec(Math.min(duration, cursor + wordDuration));
    cursor = endSec + gapSec;
    return {
      index,
      word: token.word,
      normalized: token.normalized,
      startSec,
      endSec: Math.max(endSec, startSec + 0.01)
    };
  });
  return {
    text: trimmed,
    durationSec: duration,
    quality: "approximate",
    words,
    warnings: outWarnings
  };
}

export function resolvePhraseTiming(
  timing: SizzleSpeechTiming,
  args: {
    phrase: string;
    occurrence?: number | null;
    offsetSec?: number;
    durationSec?: number | null;
  }
): SizzleResolvedPhraseTiming | null {
  const phraseTokens = tokenizeWords(args.phrase);
  if (phraseTokens.length === 0) return null;
  const phraseNormalized = phraseTokens.map((token) => token.normalized);
  const phraseCompacts = compactVariantsForTokens(phraseTokens);
  const maxPhraseCompactLength = Math.max(...Array.from(phraseCompacts).map((variant) => variant.length));
  const wantedOccurrence = args.occurrence ?? 1;
  let seen = 0;
  for (let i = 0; i < timing.words.length; i++) {
    const matchedWordCount = matchPhraseAt({
      words: timing.words,
      startIndex: i,
      phraseNormalized,
      phraseCompacts,
      maxPhraseCompactLength
    });
    if (matchedWordCount === 0) continue;
    seen++;
    if (seen !== wantedOccurrence) continue;
    const first = timing.words[i]!;
    const last = timing.words[i + matchedWordCount - 1]!;
    const startSec = Math.max(0, first.startSec + (args.offsetSec ?? 0));
    const naturalEndSec = Math.max(startSec + 0.01, last.endSec + (args.offsetSec ?? 0));
    const endSec =
      typeof args.durationSec === "number" && Number.isFinite(args.durationSec) && args.durationSec > 0
        ? startSec + args.durationSec
        : naturalEndSec;
    return {
      startSec: roundSec(startSec),
      endSec: roundSec(endSec),
      quality: timing.quality,
      wordStartIndex: first.index,
      wordEndIndex: last.index,
      matchedText: timing.words.slice(i, i + matchedWordCount).map((word) => word.word).join(" "),
      warnings: timing.warnings
    };
  }
  return null;
}

export function speechTimingCacheDir(): string {
  return join(app.getPath("userData"), "sizzle-cache", "speech-timing");
}

export function speechTimingCacheKey(
  req: Pick<SpeechTimingRequest, "provider" | "model" | "voice" | "text">,
  audioHash: string
): string {
  return createHash("sha256")
    .update(req.provider)
    .update("\0")
    .update(req.model)
    .update("\0")
    .update(req.voice)
    .update("\0")
    .update(req.text.trim())
    .update("\0")
    .update(audioHash)
    .digest("hex")
    .slice(0, 24);
}

async function transcribeWithOpenAi(args: {
  apiKey: string;
  audioPath: string;
}): Promise<RawTranscribedWord[]> {
  const audio = await readFile(args.audioPath);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/mpeg" }), "narration.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}` },
    body: form
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI transcription HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  const body = (await res.json()) as {
    words?: Array<{ word?: unknown; start?: unknown; end?: unknown }>;
  };
  return (body.words ?? [])
    .filter(
      (word): word is { word: string; start: number; end: number } =>
        typeof word.word === "string" &&
        typeof word.start === "number" &&
        typeof word.end === "number"
    )
    .map((word) => ({
      word: word.word,
      startSec: word.start,
      endSec: word.end
    }));
}

function normalizeTranscribedWords(
  words: RawTranscribedWord[],
  text: string,
  durationSec: number
): SizzleWordTiming[] {
  const duration = finitePositive(durationSec) ? durationSec : Number.POSITIVE_INFINITY;
  return words
    .filter(
      (word) =>
        word.word.trim().length > 0 &&
        Number.isFinite(word.startSec) &&
        Number.isFinite(word.endSec) &&
        word.endSec > word.startSec
    )
    .map((word, index) => ({
      index,
      word: word.word.trim(),
      normalized: normalizeWord(word.word),
      startSec: roundSec(Math.max(0, word.startSec)),
      endSec: roundSec(Math.min(duration, word.endSec))
    }))
    .filter((word) => word.normalized.length > 0 && word.endSec > word.startSec);
}

function tokenizeWords(text: string): Array<{ word: string; normalized: string }> {
  return [...text.matchAll(/[\p{L}\p{N}'’]+/gu)]
    .map((match) => {
      const word = match[0];
      return { word, normalized: normalizeWord(word) };
    })
    .filter((word) => word.normalized.length > 0);
}

function matchPhraseAt(args: {
  words: SizzleWordTiming[];
  startIndex: number;
  phraseNormalized: string[];
  phraseCompacts: Set<string>;
  maxPhraseCompactLength: number;
}): number {
  let exact = true;
  for (let j = 0; j < args.phraseNormalized.length; j++) {
    if (args.words[args.startIndex + j]?.normalized !== args.phraseNormalized[j]) {
      exact = false;
      break;
    }
  }
  if (exact) return args.phraseNormalized.length;

  let candidateCompacts = new Set([""]);
  for (let endIndex = args.startIndex; endIndex < args.words.length; endIndex++) {
    const word = args.words[endIndex]!;
    const wordCompacts = compactVariantsForTokens([
      { word: word.word, normalized: word.normalized }
    ]);
    const next = new Set<string>();
    for (const prefix of candidateCompacts) {
      for (const compact of wordCompacts) {
        const value = prefix + compact;
        if (value.length <= args.maxPhraseCompactLength) next.add(value);
      }
    }
    if (next.size === 0) break;
    candidateCompacts = next;
    if ([...candidateCompacts].some((candidate) => args.phraseCompacts.has(candidate))) {
      return endIndex - args.startIndex + 1;
    }
  }
  return 0;
}

function compactVariantsForTokens(tokens: Array<{ word: string; normalized: string }>): Set<string> {
  let variants = new Set([""]);
  for (const token of tokens) {
    const next = new Set<string>();
    for (const prefix of variants) {
      for (const expansion of contractionTokenVariants(token)) {
        next.add(prefix + expansion.join(""));
      }
    }
    variants = next;
  }
  return variants;
}

function contractionTokenVariants(token: { word: string; normalized: string }): string[][] {
  const variants: string[][] = [[token.normalized]];
  const raw = token.word.normalize("NFKD").toLocaleLowerCase("en-US");
  const add = (parts: string[]): void => {
    const normalized = parts.map((part) => normalizeWord(part)).filter((part) => part.length > 0);
    if (normalized.length === 0) return;
    if (!variants.some((variant) => variant.join("\0") === normalized.join("\0"))) {
      variants.push(normalized);
    }
  };

  if (/^[\p{L}\p{N}]+[’']s$/u.test(raw)) {
    const base = raw.replace(/[’']s$/u, "");
    add([base, "is"]);
    add([base, "has"]);
  }
  if (/^[\p{L}\p{N}]+[’']re$/u.test(raw)) add([raw.replace(/[’']re$/u, ""), "are"]);
  if (/^[\p{L}\p{N}]+[’']ve$/u.test(raw)) add([raw.replace(/[’']ve$/u, ""), "have"]);
  if (/^[\p{L}\p{N}]+[’']ll$/u.test(raw)) add([raw.replace(/[’']ll$/u, ""), "will"]);
  if (/^[\p{L}\p{N}]+[’']m$/u.test(raw)) add([raw.replace(/[’']m$/u, ""), "am"]);
  if (/^[\p{L}\p{N}]+[’']d$/u.test(raw)) {
    const base = raw.replace(/[’']d$/u, "");
    add([base, "had"]);
    add([base, "would"]);
  }

  if (token.normalized === "its") {
    add(["it", "is"]);
    add(["it", "has"]);
  }
  if (token.normalized === "im") add(["i", "am"]);
  if (token.normalized === "youre") add(["you", "are"]);
  if (token.normalized === "theyre") add(["they", "are"]);
  if (token.normalized === "weve") add(["we", "have"]);
  if (token.normalized === "youve") add(["you", "have"]);
  if (token.normalized === "ive") add(["i", "have"]);

  return variants;
}

function normalizeWord(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "");
}

async function readCachedTiming(cachePath: string): Promise<SizzleSpeechTiming | null> {
  try {
    const s = await stat(cachePath);
    if (!s.isFile() || s.size === 0) return null;
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as SizzleSpeechTiming;
    if (!Array.isArray(parsed.words) || parsed.quality === undefined) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCachedTiming(cachePath: string, timing: SizzleSpeechTiming): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(timing, null, 2), "utf8");
}

async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 24);
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
