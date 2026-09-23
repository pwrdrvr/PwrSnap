import { afterEach, describe, expect, test } from "vitest";
import { customConnectionSchema, customModelSchema, parseCustomAi, type CustomProtocol } from "@pwrsnap/shared";
import { discoverApi, invokeApi } from "../transport";
import { body, CONNECTION_ID, IMAGE, json, model, server, stream } from "./fixtures";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });

describe.each<CustomProtocol>(["openai-chat", "openai-responses", "anthropic-messages"])("%s", (protocol) => {
  test.each([true, false])("encodes exact model, text/images, authentication, usage and streaming=%s", async (streaming) => {
    let seen: Record<string, unknown> = {}; let path = ""; let authorization: unknown;
    const http = await server(async (req, res) => {
      path = req.url ?? ""; seen = JSON.parse(await body(req)) as Record<string, unknown>; authorization = req.headers.authorization;
      if (protocol === "openai-chat") {
        if (streaming) stream(res, [{ choices: [{ delta: { content: "fixture " } }] }, { choices: [{ delta: { content: "answer" } }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }, "[DONE]"]);
        else json(res, { choices: [{ message: { content: "fixture answer" } }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } });
      } else if (protocol === "openai-responses") {
        if (streaming) stream(res, [{ type: "response.output_text.delta", delta: "fixture answer" }, { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } } }]);
        else json(res, { output: [{ content: [{ type: "output_text", text: "fixture answer" }] }], usage: { input_tokens: 9, output_tokens: 3 } });
      } else {
        expect(req.headers["anthropic-version"]).toBe("2023-06-01");
        if (streaming) stream(res, [{ type: "message_start", message: { usage: { input_tokens: 9 } } }, { type: "content_block_delta", delta: { type: "text_delta", text: "fixture answer" } }, { type: "message_delta", usage: { output_tokens: 3 } }, { type: "message_stop" }]);
        else json(res, { content: [{ type: "text", text: "fixture answer" }], usage: { input_tokens: 9, output_tokens: 3 } });
      }
    }); cleanup.push(http.close);
    const entry = model(`${http.url}/v1`, protocol); entry.capabilities.streaming = streaming;
    const deltas: string[] = [];
    const result = await invokeApi({ model: entry, headers: { Authorization: "Bearer synthetic-fixture-only" }, system: "fixture system", messages: [{ role: "user", text: "fixture input", images: [IMAGE] }], onDelta: (t) => deltas.push(t) });
    expect(path).toBe(protocol === "openai-chat" ? "/v1/chat/completions" : protocol === "openai-responses" ? "/v1/responses" : "/v1/messages");
    expect(seen.model).toBe("fixture/exact-model"); expect(seen.stream).toBe(streaming);
    expect(authorization).toBe("Bearer synthetic-fixture-only");
    expect(JSON.stringify(seen)).toContain("fixture input");
    expect(JSON.stringify(seen)).toContain(IMAGE.split(",")[1]);
    expect(JSON.stringify(seen)).not.toMatch(/reasoning|service_tier|tools|temperature/);
    expect(result.text).toBe("fixture answer"); expect(deltas.join("")).toBe(result.text);
    expect(result.tokens).toMatchObject({ inputTokens: 9, outputTokens: 3, totalTokens: 12, modelContextWindow: null });
    if (protocol === "openai-responses") expect(seen.store).toBe(false);
  });
  test("cancels a running stream and never returns server-controlled errors", async () => {
    const http = await server(async (_req, res) => { res.setHeader("content-type", "text/event-stream"); res.write(": waiting\n\n"); }); cleanup.push(http.close);
    const abort = new AbortController(); const promise = invokeApi({ model: model(http.url, protocol), headers: {}, system: "", messages: [{ role: "user", text: "test" }], signal: abort.signal });
    setTimeout(() => abort.abort(), 30); await expect(promise).rejects.toThrow("cancelled");
  });
});

test("unknown vision is not inferred; rejects image requests before sending", async () => {
  let called = false; const http = await server((_req, res) => { called = true; res.end(); }); cleanup.push(http.close);
  const entry = model(http.url); entry.capabilities.vision = false;
  await expect(invokeApi({ model: entry, headers: {}, system: "", messages: [{ role: "user", text: "test", images: [IMAGE] }] })).rejects.toThrow("Image input is not enabled"); expect(called).toBe(false);
});
test.each([401, 429, 500, 302])("sanitizes HTTP %s including redirects", async (status) => {
  const http = await server((_req, res) => { res.writeHead(status, { location: "http://127.0.0.1:1/secret" }).end("sensitive server echo"); }); cleanup.push(http.close);
  await expect(invokeApi({ model: model(http.url), headers: {}, system: "", messages: [{ role: "user", text: "test" }] })).rejects.not.toThrow("sensitive");
});
test.each([[401, 401], [403, 403], [500, 500]])("an HTTP %s answer carries its status for the caller to classify", async (status, expected) => {
  const http = await server((_req, res) => { res.writeHead(status).end(); }); cleanup.push(http.close);
  await expect(discoverApi(model(`${http.url}/v1`), {})).rejects.toMatchObject({ status: expected });
});
test.each(["malformed", "truncated", "error"])("rejects %s streams", async (kind) => {
  const http = await server((_req, res) => {
    if (kind === "malformed") res.end("data: not json\n\n");
    else stream(res, kind === "error" ? [{ error: { message: "synthetic credential echo" } }] : [{ choices: [{ delta: { content: "partial" } }] }]);
  }); cleanup.push(http.close);
  await expect(invokeApi({ model: model(http.url), headers: {}, system: "", messages: [{ role: "user", text: "test" }] })).rejects.toThrow(/invalid stream|before completion|reported an error/);
});
test("discovery reports image input per listed model, only where a row says so", async () => {
  let many = false;
  const http = await server((req, res) => {
    if (req.url === "/props") json(res, { modalities: { vision: true } });
    else json(res, { data: many
      ? [{ id: "fixture/exact-model" }, { id: "fixture/lists-vision", modalities: { vision: false } }, { id: "fixture/exact-model" }, { id: "bad\u0000id" }]
      : [{ id: "fixture/exact-model" }] });
  }); cleanup.push(http.close);
  // One model listed and /props speaks for it.
  expect(await discoverApi(model(`${http.url}/v1`), {})).toEqual({ models: [{ id: "fixture/exact-model", vision: true }] });
  // A catalog: /props is never spread across it; duplicates and control characters drop.
  many = true;
  expect(await discoverApi(model(`${http.url}/v1`), {})).toEqual({ models: [
    { id: "fixture/exact-model", vision: null }, { id: "fixture/lists-vision", vision: false }] });
});
test("Anthropic listing sends its version header and asks past the default page", async () => {
  const urls: string[] = []; let version: unknown;
  const http = await server((req, res) => { urls.push(req.url ?? ""); version = req.headers["anthropic-version"]; json(res, { data: [{ id: "fixture-a" }] }); }); cleanup.push(http.close);
  await discoverApi(model(`${http.url}/v1`, "anthropic-messages"), { "x-api-key": "synthetic" });
  // One listed model, but not a llama.cpp server: no /props probe.
  expect(urls).toEqual(["/v1/models?limit=1000"]); expect(version).toBe("2023-06-01");
});
test("schema rejects plaintext credentials, unsafe URLs and legacy completions", () => {
  const good = { id: CONNECTION_ID, name: "Fixture", baseUrl: "https://example.com/v1", protocol: "openai-chat", auth: { type: "none" } };
  expect(customConnectionSchema.safeParse(good).success).toBe(true);
  for (const baseUrl of ["http://example.com/v1", "https://user:password@example.com/v1", "https://example.com/v1?api_key=test", "file:///tmp/api"]) expect(customConnectionSchema.safeParse({ ...good, baseUrl }).success).toBe(false);
  expect(customConnectionSchema.safeParse({ ...good, apiKey: "synthetic" }).success).toBe(false);
  expect(customConnectionSchema.safeParse({ ...good, auth: { type: "api-key", key: "synthetic" } }).success).toBe(false);
  expect(customConnectionSchema.safeParse({ ...good, protocol: "openai-completions" }).success).toBe(false);
  const { baseUrl: _b, protocol: _p, auth: _a, ...saved } = model("https://example.com/v1");
  expect(customModelSchema.safeParse(saved).success).toBe(true);
  expect(customModelSchema.safeParse({ ...saved, baseUrl: "https://example.com/v1" }).success).toBe(false);
});
test("settings parse drops a bad entry instead of the file, and orphans with it", () => {
  const good = { id: CONNECTION_ID, name: "Fixture", baseUrl: "https://example.com/v1", protocol: "openai-chat", auth: { type: "none" } };
  const { baseUrl: _b, protocol: _p, auth: _a, ...saved } = model("https://example.com/v1");
  const parsed = parseCustomAi([good, { ...good, id: "not-a-uuid" }], [saved, { ...saved, id: "12345678-1234-4234-8234-12345678900f", connectionId: "12345678-1234-4234-8234-12345678900e" }, "junk"]);
  expect(parsed.customConnections).toEqual([good]);
  expect(parsed.customModels).toEqual([saved]);
});
