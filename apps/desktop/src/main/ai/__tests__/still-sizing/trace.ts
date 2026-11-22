import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

type TraceEvent = {
  wall_time_unix_ms: number;
  payload: {
    type: string;
    inference_call_id?: string;
    request_payload?: { path: string };
    response_payload?: { path: string };
  };
};

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readTransport(root: string, threadId: string) {
  const bundles = await readdir(root, { withFileTypes: true });
  const bundle = bundles.find((entry) => entry.isDirectory() && entry.name.endsWith(`-${threadId}`));
  if (!bundle) throw new Error("No Codex rollout trace for the enrichment thread");

  const directory = join(root, bundle.name);
  const trace = await readFile(join(directory, "trace.jsonl"), "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line) as TraceEvent);
  const starts = events.filter(({ payload }) => payload.type === "inference_started");
  const completed = events.filter(({ payload }) => payload.type === "inference_completed");
  if (starts.length !== 1 || completed.length !== 1) {
    throw new Error(`Expected one upstream request and completion (got ${starts.length}/${completed.length})`);
  }
  const [start] = starts;
  const [end] = completed;
  const requestPath = start!.payload.request_payload?.path;
  const responsePath = end!.payload.response_payload?.path;
  if (!requestPath || !responsePath || start!.payload.inference_call_id !== end!.payload.inference_call_id) {
    throw new Error("Missing matched upstream request and response payloads");
  }
  const request = JSON.parse(await readFile(join(directory, requestPath), "utf8")) as {
    type?: string;
    model?: string;
    reasoning?: { effort?: string };
    service_tier?: string;
    instructions?: string;
    input?: Array<{ content?: Array<{ type: string; image_url?: string; detail?: string; text?: string }> }>;
  };
  const response = JSON.parse(await readFile(join(directory, responsePath), "utf8")) as {
    token_usage?: Record<string, number>;
  };
  const items = request.input?.flatMap((item) => item.content ?? []) ?? [];
  const images = items.filter((item) => item.type === "input_image");
  const url = images[0]?.image_url?.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (images.length !== 1 || !url) throw new Error("Expected exactly one inlined still in the upstream request");
  const bytes = Buffer.from(url[2]!, "base64");
  const text = items.filter((item) => item.type === "input_text").map((item) =>
    item.text?.replace(/(<image[^>]* path=")[^"]+(")/g, "$1[fixture path]$2"));
  const { width, height, format } = await sharp(bytes).metadata();
  return {
    width, height, format, mime: url[1], decodedBytes: bytes.length, base64Bytes: url[2]!.length,
    sha256: sha256(bytes), detail: images[0]?.detail ?? null,
    promptSha256: sha256(Buffer.from(JSON.stringify([request.instructions, text]))),
    model: request.model, effort: request.reasoning?.effort, tier: request.service_tier ?? null,
    transport: request.type === "response.create" ? "websocket" : "http-or-logical-websocket",
    upstreamMs: end!.wall_time_unix_ms - start!.wall_time_unix_ms,
    providerUsage: response.token_usage ?? null
  };
}
