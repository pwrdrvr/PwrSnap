// Unit tests for ChatThreadController. A fake CodexThreadClient captures
// the subscription hooks the controller wires in `wire()` and exposes
// `fire*` drivers so a test can simulate Codex notifications / server-
// requests deterministically. The store is the REAL ChatThreadStore over
// an in-memory SQLite DB + a tmp Chats dir, so the asset-gluing list
// filter is exercised against actual indexed queries.
//
// Coverage focus (the trickiest, previously-untested logic):
//   • turn-completion status mapping — a "failed" turn must commit a
//     "failed" assistant message (Retry affordance), NOT "interrupted".
//   • approval routing — an approval with no threadId is recovered to the
//     single in-flight turn, and auto-DENIED (never hung) when it can't
//     be routed.
//   • asset gluing — listThreads scoped to a capture returns only that
//     capture's threads.
//   • tool-call activity broadcast — onToolCall surfaces a humanized chip.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse
} from "@pwrsnap/codex-app-server-protocol/v2";
import type {
  CodexAgentMessageDeltaEvent,
  CodexApprovalRequestHandler,
  CodexToolCallHandler,
  CodexTurnCompletedEvent
} from "../codex-thread-client";
import type { ChatBroadcast } from "../chat-thread-controller";
import { ChatThreadController } from "../chat-thread-controller";
import { ChatThreadStore } from "../chat-thread-store";
import { defaultSettings } from "../../settings/desktop-settings-service";
import { EVENT_CHANNELS } from "@pwrsnap/shared";

/** Fake long-lived client: records the controller's wired callbacks and
 *  lets tests drive notifications / server-requests through them. */
class FakeClient {
  private deltaCb: ((e: CodexAgentMessageDeltaEvent) => void) | null = null;
  private completedCb: ((e: CodexTurnCompletedEvent) => void) | null = null;
  private toolHandler: CodexToolCallHandler | null = null;
  private approvalHandler: CodexApprovalRequestHandler | null = null;
  private threadSeq = 0;
  private turnSeq = 0;
  /** The `input` array of the most recent startTurn — lets tests assert
   *  what text was actually sent to Codex (incl. injected context). */
  lastTurnInput: Array<{ text: string }> = [];

  async startThread(): Promise<{ threadId: string }> {
    this.threadSeq += 1;
    return { threadId: `thread-${this.threadSeq}` };
  }
  async startTurn(opts: { input: Array<{ text: string }> }): Promise<{ turnId: string }> {
    this.lastTurnInput = opts.input;
    this.turnSeq += 1;
    return { turnId: `turn-${this.turnSeq}` };
  }
  async interruptTurn(): Promise<void> {
    return;
  }
  async archiveThread(): Promise<void> {
    return;
  }
  onAgentMessageDelta(cb: (e: CodexAgentMessageDeltaEvent) => void): () => void {
    this.deltaCb = cb;
    return () => undefined;
  }
  onTurnCompleted(cb: (e: CodexTurnCompletedEvent) => void): () => void {
    this.completedCb = cb;
    return () => undefined;
  }
  onToolCall(h: CodexToolCallHandler): () => void {
    this.toolHandler = h;
    return () => undefined;
  }
  onApprovalRequest(h: CodexApprovalRequestHandler): () => void {
    this.approvalHandler = h;
    return () => undefined;
  }

  // ---- test drivers ----
  fireDelta(threadId: string, turnId: string, delta: string): void {
    this.deltaCb?.({ threadId, turnId, itemId: "item-1", delta });
  }
  fireCompleted(threadId: string, turnId: string, status: string): void {
    this.completedCb?.({ threadId, turnId, status });
  }
  fireToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    if (this.toolHandler === null) throw new Error("no tool handler wired");
    return this.toolHandler(params);
  }
  fireApproval(method: string, params: unknown): Promise<unknown> {
    if (this.approvalHandler === null) throw new Error("no approval handler wired");
    return this.approvalHandler(method, params);
  }
}

type Broadcast = { channel: string; payload: unknown };

let root = "";
let db: Database.Database;

function applyAllMigrations(target: Database.Database): void {
  const dir = new URL("../../persistence/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  target.pragma("foreign_keys = OFF");
  for (const file of files) target.exec(readFileSync(new URL(file, dir), "utf8"));
  target.pragma("foreign_keys = ON");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pwrsnap-chat-ctl-"));
  db = new Database(":memory:");
  applyAllMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(root, { force: true, recursive: true });
});

function build(opts: { dispatchToolCall?: (p: DynamicToolCallParams) => Promise<DynamicToolCallResponse> } = {}) {
  const client = new FakeClient();
  const store = new ChatThreadStore({ chatsDir: join(root, "Chats"), db });
  const broadcasts: Broadcast[] = [];
  const broadcast: ChatBroadcast = (channel, payload) => {
    broadcasts.push({ channel, payload });
  };
  const controller = new ChatThreadController({
    client: client as unknown as ConstructorParameters<typeof ChatThreadController>[0]["client"],
    store,
    readSettings: async () => defaultSettings(),
    broadcast,
    buildSystemPrompt: () => "system",
    ...(opts.dispatchToolCall ? { dispatchToolCall: opts.dispatchToolCall } : {}),
    approvalPolicy: "on-request",
    sandbox: "workspace-write"
  });
  controller.wire();
  return { client, store, controller, broadcasts };
}

function committedMessages(broadcasts: Broadcast[]): Array<{ role: string; status: string }> {
  return broadcasts
    .filter((b) => b.channel === EVENT_CHANNELS.libraryChatMessageCommitted)
    .map((b) => (b.payload as { message: { role: string; status: string } }).message);
}

/** Poll until `pred` holds — the turn-completion handler is fire-and-
 *  forget (`void this.onTurnCompleted(...)`) and its assistant-commit
 *  chain includes a real `appendFile`, so we wait for the chain to settle
 *  rather than guessing a fixed number of ticks. */
async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function lastAssistantStatus(broadcasts: Broadcast[]): string | undefined {
  return committedMessages(broadcasts)
    .filter((m) => m.role === "assistant")
    .at(-1)?.status;
}

describe("ChatThreadController turn-completion status mapping", () => {
  it("commits a FAILED assistant message when the turn errors (not interrupted)", async () => {
    const { client, controller, broadcasts } = build();
    const view = await controller.createThread({ name: "T" });
    const { turnId } = await controller.sendMessage({ threadId: view.threadId, text: "hi" });

    client.fireDelta(view.threadId, turnId, "partial");
    client.fireCompleted(view.threadId, turnId, "failed");
    await waitFor(() => lastAssistantStatus(broadcasts) !== undefined);

    expect(lastAssistantStatus(broadcasts)).toBe("failed");
  });

  it("commits an INTERRUPTED assistant message on an aborted turn", async () => {
    const { client, controller, broadcasts } = build();
    const view = await controller.createThread({ name: "T" });
    const { turnId } = await controller.sendMessage({ threadId: view.threadId, text: "hi" });

    client.fireCompleted(view.threadId, turnId, "aborted");
    await waitFor(() => lastAssistantStatus(broadcasts) !== undefined);

    expect(lastAssistantStatus(broadcasts)).toBe("interrupted");
  });

  it("commits a COMPLETE assistant message on a clean finish", async () => {
    const { client, controller, broadcasts } = build();
    const view = await controller.createThread({ name: "T" });
    const { turnId } = await controller.sendMessage({ threadId: view.threadId, text: "hi" });

    client.fireCompleted(view.threadId, turnId, "completed");
    await waitFor(() => lastAssistantStatus(broadcasts) !== undefined);

    expect(lastAssistantStatus(broadcasts)).toBe("complete");
  });
});

describe("ChatThreadController approval routing", () => {
  it("auto-denies an approval that can't be routed to a thread (no hang)", async () => {
    const { client } = build();
    // No turns in flight → not exactly one → auto-deny rather than hang.
    const decision = await client.fireApproval("item/fileChange/requestApproval", {});
    expect(decision).toEqual({ decision: "denied" });
  });

  it("recovers the single in-flight thread for an untagged approval", async () => {
    const { client, controller, broadcasts } = build();
    const view = await controller.createThread({ name: "T" });
    await controller.sendMessage({ threadId: view.threadId, text: "hi" });

    // Approval arrives with NO threadId; exactly one turn is in flight.
    const pending = client.fireApproval("item/fileChange/requestApproval", { summary: "write file" });

    // The controller broadcasts an approval request tagged with the
    // recovered threadId; grab the approvalId and resolve it.
    await new Promise((r) => setImmediate(r));
    const req = broadcasts
      .filter((b) => b.channel === EVENT_CHANNELS.libraryChatApprovalRequested)
      .map((b) => b.payload as { threadId: string; turnId: string; approvalId: string })
      .at(-1);
    expect(req?.threadId).toBe(view.threadId);

    await controller.resolveApproval({
      threadId: req!.threadId,
      turnId: req!.turnId,
      approvalId: req!.approvalId,
      decision: "approve"
    });
    expect(await pending).toEqual({ decision: "approved" });
  });
});

describe("ChatThreadController asset gluing", () => {
  it("scopes listThreads to the anchored capture", async () => {
    const { controller } = build();
    const a = await controller.createThread({ name: "A", anchorCaptureId: "cap-A" });
    const b = await controller.createThread({ name: "B", anchorCaptureId: "cap-B" });

    const onlyA = await controller.listThreads({ anchorCaptureId: "cap-A" });
    expect(onlyA.map((t) => t.threadId)).toEqual([a.threadId]);

    const onlyB = await controller.listThreads({ anchorCaptureId: "cap-B" });
    expect(onlyB.map((t) => t.threadId)).toEqual([b.threadId]);

    const all = await controller.listThreads();
    expect(all.map((t) => t.threadId).sort()).toEqual([a.threadId, b.threadId].sort());
  });
});

describe("ChatThreadController active-capture context", () => {
  it("sends the current capture as a SEPARATE runtime-context item, not the user message", async () => {
    const { client, controller, broadcasts } = build();
    const view = await controller.createThread({ name: "T", anchorCaptureId: "capXYZ" });
    await controller.sendMessage({
      threadId: view.threadId,
      text: "blur the family photo",
      anchorCaptureId: "capXYZ"
    });

    // Two turn items: [0] = runtime context (capture id + explicitly
    // not-user-authored framing), [1] = the user's raw text — distinct
    // items, so the agent never reads app-context as the user's words.
    expect(client.lastTurnInput).toHaveLength(2);
    const ctx = client.lastTurnInput[0]?.text ?? "";
    expect(ctx).toContain("capXYZ");
    expect(ctx).toContain("not user-authored");
    expect(client.lastTurnInput[1]?.text).toBe("blur the family photo");

    // The committed (displayed) user message is the RAW text — no wrapper.
    const lastUser = broadcasts
      .filter((b) => b.channel === EVENT_CHANNELS.libraryChatMessageCommitted)
      .map((b) => b.payload as { message: { role: string; content: Array<{ text?: string }> } })
      .map((p) => p.message)
      .filter((m) => m.role === "user")
      .at(-1);
    expect(lastUser?.content[0]?.text).toBe("blur the family photo");
  });

  it("sends a single user item (no context block) when no capture is anchored", async () => {
    const { client, controller } = build();
    const view = await controller.createThread({ name: "T" });
    await controller.sendMessage({ threadId: view.threadId, text: "hello", anchorCaptureId: null });
    expect(client.lastTurnInput).toHaveLength(1);
    expect(client.lastTurnInput[0]?.text).toBe("hello");
  });
});

describe("ChatThreadController tool-call activity", () => {
  it("broadcasts a humanized tool-call chip", async () => {
    const { client, controller, broadcasts } = build({
      dispatchToolCall: async () => ({
        success: true,
        contentItems: [{ type: "inputText", text: "ok" }]
      })
    });
    const view = await controller.createThread({ name: "T" });
    const { turnId } = await controller.sendMessage({ threadId: view.threadId, text: "draw" });

    await client.fireToolCall({
      threadId: view.threadId,
      turnId,
      callId: "call-1",
      tool: "draw_arrow",
      namespace: "pwrsnap_library",
      arguments: {}
    } as unknown as DynamicToolCallParams);

    const chip = broadcasts
      .filter((b) => b.channel === EVENT_CHANNELS.libraryChatToolCall)
      .map((b) => b.payload as { tool: string; ok: boolean; summary: string })
      .at(-1);
    expect(chip?.tool).toBe("draw_arrow");
    expect(chip?.ok).toBe(true);
    expect(chip?.summary).toBe("Drew an arrow");
  });
});
