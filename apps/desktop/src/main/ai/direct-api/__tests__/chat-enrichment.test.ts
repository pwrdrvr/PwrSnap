import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import type { NormalizedThreadRecord, ThreadStore } from "@pwrdrvr/agent-core";
import { PwrSnapChatSessionController } from "../../chat-session-controller";
import { DirectChatBackend } from "../chat-backend";
import { DirectEnrichmentBackend } from "../enrichment";
import type { CustomModelService } from "../service";
import { body, IMAGE, json, model, server, stream } from "./fixtures";
import { estimateAiUsageCost } from "../../ai-usage-cost";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((f) => f())); });
function memoryStore(): ThreadStore {
  let saved: NormalizedThreadRecord | null = null; const journal: unknown[] = [];
  return {
    prepareThreadDir: async () => ({ path: "/unused-fixture" }), discardPreparedThreadDir: async () => undefined,
    create: async (opts) => { saved = { threadId: opts.threadId, name: opts.name, createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(), anchorId: null, anchorHistory: [], archived: false, pinned: false }; return saved; },
    get: async () => saved, list: async () => saved ? [saved] : [], update: async () => { if (!saved) throw new Error("missing"); return saved; },
    delete: async () => undefined, appendAnchor: async () => undefined,
    journalAppend: async (_id, entry) => { journal.push(entry); }, readJournal: async () => [...journal],
    attachmentsDir: async () => "/unused-fixture", recordUsage: vi.fn(async () => undefined)
  };
}
test("existing chat controller streams and persists direct replies, resumes journal history, records usage, and cancels", async () => {
  const requests: Record<string, unknown>[] = []; let hang = false;
  const http = await server(async (req, res) => {
    requests.push(JSON.parse(await body(req)) as Record<string, unknown>);
    if (hang) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": waiting\n\n"); return; }
    stream(res, [{ choices: [{ delta: { content: "fixture reply" } }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }, "[DONE]"]);
  }); cleanup.push(http.close);
  const entry = model(`${http.url}/v1`); const store = memoryStore();
  // Main-only service seam; real protocol transport and production controller.
  const service = { selected: async () => entry, credentials: { headers: async () => ({}) } } as unknown as CustomModelService;
  const backend = new DirectChatBackend(entry, service, (id) => store.readJournal(id)); cleanup.push(() => backend.close());
  const controller = new PwrSnapChatSessionController({ client: backend, store, readSettings: async () => ({}),
    broadcast: () => undefined, buildSystemPrompt: () => "Agent tools must not be forwarded", toolLabels: {} });
  controller.wire(); const thread = await controller.createThread({ name: "Fixture chat" });
  await controller.sendMessage({ threadId: thread.threadId, text: "first fixture prompt", imagePaths: [IMAGE] });
  await vi.waitFor(async () => { expect(await controller.getHistory(thread.threadId)).toHaveLength(2); });
  expect(await controller.getHistory(thread.threadId)).toMatchObject([{ role: "user", text: "first fixture prompt" }, { role: "assistant", text: "fixture reply" }]);
  expect(store.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ model: entry.modelId, usage: expect.objectContaining({ inputTokens: 3, outputTokens: 2 }) }));
  expect(JSON.stringify(requests[0])).toContain(IMAGE); expect(JSON.stringify(requests[0])).not.toContain("Agent tools");
  // Rebuild controller/backend like a relaunch, retaining the same persisted journal.
  await backend.close();
  const reopened = new DirectChatBackend(entry, service, (id) => store.readJournal(id)); cleanup.push(() => reopened.close());
  const next = new PwrSnapChatSessionController({ client: reopened, store, readSettings: async () => ({}), broadcast: () => undefined, buildSystemPrompt: () => "", toolLabels: {} }); next.wire();
  await next.sendMessage({ threadId: thread.threadId, text: "second fixture prompt" });
  await vi.waitFor(async () => { expect(await next.getHistory(thread.threadId)).toHaveLength(4); });
  expect(JSON.stringify(requests[1])).toContain("first fixture prompt"); expect(JSON.stringify(requests[1])).toContain("fixture reply");
  expect(JSON.stringify(requests[1]).match(/second fixture prompt/g)).toHaveLength(1);
  hang = true; await next.sendMessage({ threadId: thread.threadId, text: "cancel fixture" });
  await vi.waitFor(() => expect(requests).toHaveLength(3)); await next.interrupt(thread.threadId);
  await vi.waitFor(async () => { expect(await next.getHistory(thread.threadId)).toHaveLength(6); });
});
test("direct enrichment sends only prepared image bytes and validates the existing schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-enrichment-fixture-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "synthetic.png"); await writeFile(path, Buffer.from(IMAGE.split(",")[1] ?? "", "base64"));
  let request: unknown;
  const http = await server(async (req, res) => { request = JSON.parse(await body(req)); json(res, { content: [{ type: "text", text: JSON.stringify({ title: "Fixture image", description: "One synthetic pixel", ocrText: "", filenameStem: "fixture", textAnchors: [], tags: [] }) }] }); }); cleanup.push(http.close);
  const entry = model(`${http.url}/v1`, "anthropic-messages"); entry.capabilities.streaming = false;
  const service = { credentials: { headers: async () => ({}) } } as unknown as CustomModelService;
  const client = new DirectEnrichmentBackend(entry, service);
  const result = await client.enrichCapture({ imagePaths: [path], metadata: { captureKind: "image", sourceAppName: null, sourceAppBundleId: null, widthPx: 1, heightPx: 1, capturedAt: "2026-01-01T00:00:00Z" } });
  expect(result.result.title).toBe("Fixture image"); expect(result.modelProvider).toBe(`custom:${entry.id}`); expect(result.tokens).toBeNull();
  expect(JSON.stringify(request)).toContain(IMAGE.split(",")[1]); expect(JSON.stringify(request)).not.toContain(path);
});
test("custom model names matching built-in models do not inherit catalog pricing", () => {
  expect(estimateAiUsageCost({ model: "gpt-5.4", provider: "custom:fixture", serviceTier: null,
    tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, reasoningOutputTokens: 0, modelContextWindow: null } })).toEqual({ status: "unavailable", reason: "Custom endpoint pricing is not configured" });
});
