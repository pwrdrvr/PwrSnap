import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { SizzleTtsModel, SizzleTtsProvider, SizzleVoice } from "@pwrsnap/shared";
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
  if (await fileExists(audioPath)) {
    return { audioPath, cached: true };
  }
  const audio = await fetchSynthesis(req);
  await mkdir(dirname(audioPath), { recursive: true });
  await writeFile(audioPath, audio);
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
