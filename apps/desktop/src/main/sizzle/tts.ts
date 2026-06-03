import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { app } from "electron";
import type {
  SizzleProject,
  SizzleTtsModel,
  SizzleTtsProvider,
  SizzleVoice
} from "@pwrsnap/shared";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:sizzle-tts");

export type TtsRequest = {
  provider: SizzleTtsProvider;
  apiKey: string;
  text: string;
  voice: SizzleVoice;
  model: SizzleTtsModel;
};

export type TtsResult = {
  audioPath: string;
  cached: boolean;
};

export class TtsError extends Error {
  constructor(
    public readonly code:
      | "no_api_key"
      | "provider_unavailable"
      | "http_failed"
      | "empty_text",
    message: string
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export async function synthesize(req: TtsRequest): Promise<TtsResult> {
  if (req.text.trim().length === 0) {
    throw new TtsError("empty_text", "TTS input is empty");
  }
  if (req.apiKey.length === 0) {
    throw new TtsError("no_api_key", `${req.provider} API key is not configured`);
  }
  const cacheDir = join(app.getPath("userData"), "sizzle-cache", "tts");
  await mkdir(cacheDir, { recursive: true });
  const hash = hashKey(req);
  const audioPath = join(cacheDir, `${hash}.mp3`);
  // Diagnostic: prove out exactly which (text, voice, model, provider)
  // tuple we resolve to which cache file. The user reported TTS not
  // re-triggering after script edits; this trace lets us confirm
  // whether (a) the disk has the new text but the hash collides with
  // old, (b) the disk has stale text, or (c) the cache file resolution
  // is correct and an upstream consumer is showing old audio.
  const textPreview = req.text.length > 80 ? req.text.slice(0, 77) + "…" : req.text;
  if (await fileExists(audioPath)) {
    log.info("tts cache HIT", {
      hash,
      provider: req.provider,
      model: req.model,
      voice: req.voice,
      textLen: req.text.length,
      textPreview,
      audioPath
    });
    return { audioPath, cached: true };
  }
  log.info("tts cache MISS — fetching", {
    hash,
    provider: req.provider,
    model: req.model,
    voice: req.voice,
    textLen: req.text.length,
    textPreview
  });
  const audio = await fetchSynthesis(req);
  await mkdir(dirname(audioPath), { recursive: true });
  await writeFile(audioPath, audio);
  log.info("tts fetched + cached", {
    hash,
    byteSize: audio.length,
    audioPath
  });
  return { audioPath, cached: false };
}

async function fetchSynthesis(req: TtsRequest): Promise<Buffer> {
  if (req.provider === "xai") {
    throw new TtsError(
      "provider_unavailable",
      "xAI TTS is not wired up yet — pick OpenAI for now"
    );
  }
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: req.model,
      input: req.text,
      voice: req.voice,
      response_format: "mp3",
      speed: 1.0
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.warn("openai TTS failed", { status: res.status, body: body.slice(0, 200) });
    throw new TtsError(
      "http_failed",
      `OpenAI TTS HTTP ${res.status}: ${body.slice(0, 160)}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

function hashKey(req: Pick<TtsRequest, "provider" | "voice" | "model" | "text">): string {
  return createHash("sha256")
    .update(req.provider)
    .update("\0")
    .update(req.model)
    .update("\0")
    .update(req.voice)
    .update("\0")
    .update(req.text)
    .digest("hex")
    .slice(0, 24);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

export async function readAudio(audioPath: string): Promise<Buffer> {
  return readFile(audioPath);
}

/**
 * Compute the cache filename (basename, no directory) for a given
 * `(provider, model, voice, text)` tuple. Exposed so the GC sweep can
 * build the set of "currently-referenced" filenames from the live
 * project list without having to call `synthesize()`.
 */
export function ttsCacheFilename(args: {
  provider: SizzleTtsProvider;
  model: SizzleTtsModel;
  voice: SizzleVoice;
  text: string;
}): string {
  return `${hashKey(args)}.mp3`;
}

export function ttsCacheDir(): string {
  return join(app.getPath("userData"), "sizzle-cache", "tts");
}

/**
 * Sweep the TTS cache directory and delete files NOT referenced by any
 * current project. "Referenced" = `hashKey({ provider, model, voice,
 * scene.scriptLine.trim() })` matches the file's basename.
 *
 * Safe to run while other operations are in flight: synthesize() writes
 * a missing file under the same hash, so the worst case if a sweep
 * races a write is the just-written file gets deleted and the next
 * call re-fetches it. Cheap correctness over cheap performance.
 *
 * Returns the count of files removed for observability + tests.
 */
export async function pruneTtsCache(projects: SizzleProject[]): Promise<{
  scanned: number;
  removed: number;
  kept: number;
}> {
  const recentOrphanLimit = 5;
  const dir = ttsCacheDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return { scanned: 0, removed: 0, kept: 0 };
    }
    throw cause;
  }
  const live = new Set<string>();
  for (const project of projects) {
    for (const scene of project.scenes) {
      const text = scene.scriptLine.trim();
      if (text.length === 0) continue;
      live.add(
        ttsCacheFilename({
          provider: project.ttsProvider,
          model: project.ttsModel,
          voice: project.voice,
          text
        })
      );
    }
  }
  const orphanEntries: Array<{ entry: string; mtimeMs: number }> = [];
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".mp3")) continue;
    if (live.has(entry)) {
      kept++;
      continue;
    }
    const path = join(dir, entry);
    const s = await stat(path).catch(() => null);
    orphanEntries.push({ entry, mtimeMs: s?.mtimeMs ?? 0 });
  }
  orphanEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recentOrphans = new Set(
    orphanEntries.slice(0, recentOrphanLimit).map((entry) => entry.entry)
  );
  for (const { entry } of orphanEntries) {
    if (recentOrphans.has(entry)) {
      kept++;
      continue;
    }
    await unlink(join(dir, entry)).catch(() => undefined);
    removed++;
  }
  log.info("tts cache swept", { scanned: entries.length, removed, kept });
  return { scanned: entries.length, removed, kept };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}
