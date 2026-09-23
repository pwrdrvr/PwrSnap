import type { AiUsageTokenBreakdown, CustomModel, CustomModelDiscovery } from "@pwrsnap/shared";

export type ApiMessage = { role: "user" | "assistant"; text: string; images?: string[] };
export type ApiResult = { text: string; tokens: AiUsageTokenBreakdown | null };
export class DirectApiError extends Error {
  constructor(message: string) { super(message); this.name = "DirectApiError"; }
}
export const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown): string => typeof v === "string" ? v : "";
const number = (v: unknown): number => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const MAX_BYTES = 8 * 1024 * 1024;

export function apiEndpoint(model: CustomModel, path: string): string {
  return `${model.baseUrl.replace(/\/+$/, "")}/${path}`;
}

export async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, { ...init, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DirectApiError(`Model endpoint returned HTTP ${response.status}. Check the endpoint, model and authentication.`);
    }
    return response;
  } catch (e) {
    if (e instanceof DirectApiError) throw e;
    if (init.signal?.aborted) throw new DirectApiError("Model request cancelled or timed out.");
    // Never expose URLs, headers, transport causes or a server-controlled error body.
    throw new DirectApiError("Could not reach the configured endpoint. Check its address and TLS configuration.");
  }
}

export async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of chunks(response)) text += chunk;
  try { return record(JSON.parse(text)); }
  catch { throw new DirectApiError("Endpoint returned invalid JSON."); }
}
async function* chunks(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new DirectApiError("Endpoint returned no response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_BYTES) throw new DirectApiError("Endpoint response exceeded the size limit.");
      yield decoder.decode(item.value, { stream: true });
    }
    yield decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
async function* events(response: Response): AsyncGenerator<Record<string, unknown>> {
  let buffer = "";
  for await (const chunk of chunks(response)) {
    buffer += chunk;
    // CRLF may be split across network chunks. Match complete event delimiters.
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { yield { type: "done" }; continue; }
      try { yield record(JSON.parse(data)); }
      catch { throw new DirectApiError("Endpoint returned an invalid stream event."); }
    }
  }
  if (buffer.trim()) throw new DirectApiError("Endpoint stream ended mid-event.");
}
function imageParts(message: ApiMessage, model: CustomModel): unknown[] {
  const images = message.images ?? [];
  if (images.length && !model.capabilities.vision) throw new DirectApiError("Image input is not enabled for this model.");
  return images.map((url) => {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match || url.length > 24 * 1024 * 1024) throw new DirectApiError("Unsupported or oversized image input.");
    if (model.protocol === "anthropic-messages") return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
    if (model.protocol === "openai-responses") return { type: "input_image", image_url: url, detail: "auto" };
    return { type: "image_url", image_url: { url } };
  });
}
function requestBody(model: CustomModel, system: string, messages: ApiMessage[]): unknown {
  const common = { model: model.modelId, stream: model.capabilities.streaming };
  if (model.protocol === "openai-responses") return {
    ...common, store: false, instructions: system, max_output_tokens: model.maxOutputTokens,
    input: messages.map((m) => ({ role: m.role, content: [
      { type: m.role === "assistant" ? "output_text" : "input_text", text: m.text }, ...imageParts(m, model)
    ] }))
  };
  const converted = messages.map((m) => ({ role: m.role, content: [{ type: "text", text: m.text }, ...imageParts(m, model)] }));
  if (model.protocol === "anthropic-messages") return { ...common, system, max_tokens: model.maxOutputTokens, messages: converted };
  return { ...common, max_tokens: model.maxOutputTokens,
    ...(model.capabilities.streaming ? { stream_options: { include_usage: true } } : {}),
    messages: [{ role: "system", content: system }, ...converted] };
}
function usage(raw: unknown, prior: AiUsageTokenBreakdown | null): AiUsageTokenBreakdown | null {
  const u = record(raw);
  if (Object.keys(u).length === 0) return prior;
  const cached = number(u.cache_read_input_tokens ?? record(u.input_tokens_details).cached_tokens ?? record(u.prompt_tokens_details).cached_tokens);
  const input = u.input_tokens !== undefined || u.prompt_tokens !== undefined
    ? number(u.input_tokens ?? u.prompt_tokens) + number(u.cache_read_input_tokens) + number(u.cache_creation_input_tokens)
    : prior?.inputTokens ?? 0;
  const output = u.output_tokens !== undefined || u.completion_tokens !== undefined
    ? number(u.output_tokens ?? u.completion_tokens) : prior?.outputTokens ?? 0;
  return { inputTokens: input, outputTokens: output,
    totalTokens: number(u.total_tokens) || input + output,
    cachedInputTokens: cached || prior?.cachedInputTokens || 0,
    reasoningOutputTokens: number(record(u.output_tokens_details).reasoning_tokens ?? record(u.completion_tokens_details).reasoning_tokens),
    modelContextWindow: null };
}

/** Text/image-only calls. No remote tools, URLs, filesystem instructions, or agent process. */
export async function invokeApi(input: {
  model: CustomModel; headers: Record<string, string>; system: string; messages: ApiMessage[];
  signal?: AbortSignal; onDelta?: (text: string) => void;
}): Promise<ApiResult> {
  const { model } = input;
  const signal = AbortSignal.any([AbortSignal.timeout(180_000), ...(input.signal ? [input.signal] : [])]);
  const path = model.protocol === "openai-responses" ? "responses" : model.protocol === "openai-chat" ? "chat/completions" : "messages";
  try {
    const response = await safeFetch(apiEndpoint(model, path), {
      method: "POST", headers: { "content-type": "application/json", ...input.headers,
        ...(model.protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}) },
      body: JSON.stringify(requestBody(model, input.system, input.messages)), signal
    });
    let text = "";
    let tokens: AiUsageTokenBreakdown | null = null;
    const append = (delta: string): void => { text += delta; if (delta) input.onDelta?.(delta); };
    if (!model.capabilities.streaming) {
      const body = await boundedJson(response);
      if (body.error || body.status === "failed" || body.status === "incomplete") throw new DirectApiError("Model did not complete the response.");
      tokens = usage(body.usage, null);
      if (model.protocol === "openai-responses") append(array(body.output).flatMap((o) => array(record(o).content)).map((c) => string(record(c).text)).join(""));
      else if (model.protocol === "anthropic-messages") append(array(body.content).filter((c) => record(c).type === "text").map((c) => string(record(c).text)).join(""));
      else append(string(record(record(array(body.choices)[0]).message).content));
    } else {
      let terminal = false;
      for await (const e of events(response)) {
        if (e.error || ["error", "response.failed", "response.incomplete"].includes(string(e.type))) throw new DirectApiError("Model stream reported an error. Check server status and configuration.");
        if (model.protocol === "openai-responses") {
          if (e.type === "response.output_text.delta") append(string(e.delta));
          if (e.type === "response.completed") { tokens = usage(record(e.response).usage, tokens); terminal = true; }
        } else if (model.protocol === "anthropic-messages") {
          if (e.type === "content_block_delta" && record(e.delta).type === "text_delta") append(string(record(e.delta).text));
          tokens = usage(e.usage ?? record(e.message).usage, tokens);
          if (e.type === "message_stop") terminal = true;
        } else {
          append(string(record(record(array(e.choices)[0]).delta).content));
          tokens = usage(e.usage, tokens);
          if (e.type === "done") terminal = true;
        }
      }
      if (!terminal) throw new DirectApiError("Model stream ended before completion.");
    }
    if (!text.trim()) throw new DirectApiError("Model returned no text.");
    return { text, tokens };
  } catch (e) {
    if (e instanceof DirectApiError) throw e;
    throw new DirectApiError(signal.aborted ? "Model request cancelled or timed out." : "Model response could not be read.");
  }
}

/** Explicit user request only. Never infers capabilities from model names. */
export async function discoverApi(model: CustomModel, headers: Record<string, string>): Promise<CustomModelDiscovery> {
  const init = { headers, signal: AbortSignal.timeout(10_000) };
  const body = await boundedJson(await safeFetch(apiEndpoint(model, "models"), init));
  const rows = array(body.data);
  const modelIds = rows.map((m) => string(record(m).id)).filter((id) => id.length > 0 && id.length <= 200).slice(0, 1000);
  const exact = record(rows.find((m) => record(m).id === model.modelId));
  let vision: boolean | null = typeof record(exact.modalities).vision === "boolean" ? record(exact.modalities).vision as boolean : null;
  // /props describes a single loaded model. Use it only when /models identifies
  // precisely this one model; never spread one server capability onto a catalog.
  if (vision === null && modelIds.length === 1 && modelIds[0] === model.modelId) {
    try {
      const url = new URL(model.baseUrl); url.pathname = "/props";
      const props = await boundedJson(await safeFetch(url.href, init));
      if (typeof record(props.modalities).vision === "boolean") vision = record(props.modalities).vision as boolean;
    } catch { /* No unambiguous metadata; leave explicit configuration alone. */ }
  }
  return { modelIds, vision };
}
