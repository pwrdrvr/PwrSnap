// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test, vi } from "vitest";
import fc from "fast-check";
import { EVENT_CHANNELS, type ChatMessage, type LibraryChatThreadView } from "@pwrsnap/shared";
import { ChatPanelSurface } from "../ChatPanelSurface";
import { clearChatDraftsForTests } from "../chat-draft-store";

type ThreadId = "a" | "b";
type Turn = { thread: ThreadId; id: string; terminal: boolean; awaiting: boolean };
type Reply = { turn: Turn; outcome: "pending" | "acknowledged" | "failed" };
type Model = { selected: ThreadId; turns: Turn[]; replies: Reply[] };

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function view(id: ThreadId, turn: string | null): LibraryChatThreadView {
  return {
    threadId: id, name: id, anchorCaptureId: "scope-1", archived: false, pinned: false,
    createdAt: "2026-11-01T00:00:00.000Z", modifiedAt: "2026-11-01T00:00:00.000Z",
    lastMessagePreview: "", provider: "codex", model: null, reasoning: null, pendingApproval: null,
    status: turn === null ? { kind: "idle" } : { kind: "streaming", turnId: turn }
  };
}

async function mount(surface: "library" | "sizzle") {
  const prefix = surface === "library" ? "libraryChat" : "sizzleChat";
  const channels = {
    updated: EVENT_CHANNELS[`${prefix}ThreadUpdated`],
    delta: EVENT_CHANNELS[`${prefix}StreamDelta`],
    tool: EVENT_CHANNELS[`${prefix}ToolCall`],
    commit: EVENT_CHANNELS[`${prefix}MessageCommitted`],
    interrupted: EVENT_CHANNELS[`${prefix}TurnInterrupted`]
  };
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const producers = new Map<ThreadId, string | null>([["a", "turn-0"], ["b", null]]);
  const cancellations: { thread: ThreadId; turn: string; gate: ReturnType<typeof deferred> }[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  Element.prototype.scrollIntoView = vi.fn();
  window.pwrsnapApi = {
    dispatch: async (name: string, input: { threadId?: ThreadId }) => {
      if (name.endsWith(":list")) return { ok: true, value: { threads: [view("a", "turn-0"), view("b", null)] } };
      if (name.endsWith(":history")) return { ok: true, value: { messages: [] } };
      if (name.endsWith(":interrupt")) {
        const id = input.threadId!;
        const turn = producers.get(id);
        // Main cancels the producer's current turn, never a speculative delta.
        expect(turn).toBeTruthy();
        const gate = deferred();
        cancellations.push({ thread: id, turn: turn!, gate });
        return gate.promise;
      }
      if (name === "settings:read") return { ok: true, value: undefined };
      throw new Error(`Unexpected model IPC: ${name}`);
    },
    on: (channel: string, handler: (event: unknown) => void) => {
      const listeners = handlers.get(channel) ?? new Set();
      listeners.add(handler);
      handlers.set(channel, listeners);
      return () => listeners.delete(handler);
    },
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<ChatPanelSurface surface={surface} scopeId="scope-1" testId="panel" />));
  return {
    container, channels, producers, cancellations,
    emit(channel: string, event: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(event);
    },
    stop: () => container.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]'),
    async select(id: ThreadId) {
      await act(async () => container.querySelector<HTMLButtonElement>(`button[title="${id}"]`)!.click());
      await act(async () => {
        for (const [frame, callback] of [...frames]) { frames.delete(frame); callback(0); }
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      await act(async () => {
        for (const { gate } of cancellations) gate.resolve({ ok: true });
        await Promise.all(cancellations.map(({ gate }) => gate.promise.catch(() => undefined)));
      });
      container.remove();
      vi.unstubAllGlobals();
      clearChatDraftsForTests();
    }
  };
}
type Real = Awaited<ReturnType<typeof mount>>;

function latest(model: Model, id: ThreadId): Turn | undefined {
  return model.turns.findLast((turn) => turn.thread === id);
}

// Oracle: a Stop belongs to one issued turn. Only a later producer admission,
// failure of that request, or acknowledgement AND terminal output retires it.
// Navigation and activity from an unadmitted turn grant no cancellation rights.
function blockingReply(model: Model, turn: Turn | undefined): Reply | undefined {
  const reply = model.replies.findLast((candidate) => candidate.turn === turn);
  return reply?.outcome === "pending" || (reply?.outcome === "acknowledged" && !turn?.terminal)
    ? reply : undefined;
}

function verify(model: Model, real: Real) {
  const turn = latest(model, model.selected);
  const blocking = blockingReply(model, turn);
  const button = real.stop();
  if (blocking !== undefined) expect(button?.disabled).toBe(true);
  else if (turn === undefined || turn.terminal) expect(button).toBeNull();
  else if (!turn.awaiting) expect(button?.disabled).toBe(false);
  expect(real.cancellations.map(({ thread, turn: id }) => [thread, id])).toEqual(
    model.replies.map(({ turn: issued }) => [issued.thread, issued.id])
  );
}

type Operation =
  | { kind: "admit" | "select" | "finish" | "approval"; thread: ThreadId }
  | { kind: "stop" }
  | { kind: "reply"; index: number; fail: boolean }
  | { kind: "foreign"; tool: boolean };

class Command implements fc.AsyncCommand<Model, Real> {
  constructor(readonly operation: Operation) {}
  check(model: Readonly<Model>): boolean {
    const op = this.operation;
    if (op.kind === "select") return true;
    if (op.kind === "admit") return latest(model, op.thread)?.terminal !== false;
    if (op.kind === "finish" || op.kind === "approval") return latest(model, op.thread)?.terminal === false;
    if (op.kind === "reply") return model.replies.some((reply) => reply.outcome === "pending");
    const current = latest(model, model.selected);
    if (op.kind === "foreign") return current?.terminal === false && blockingReply(model, current) !== undefined;
    return current?.terminal === false && (!current.awaiting || blockingReply(model, current) !== undefined);
  }
  async run(model: Model, real: Real) {
    const op = this.operation;
    if (op.kind === "select") {
      model.selected = op.thread;
      await real.select(op.thread);
    } else if (op.kind === "admit") {
      const turn = { thread: op.thread, id: `turn-${model.turns.length}`, terminal: false, awaiting: false };
      model.turns.push(turn);
      real.producers.set(op.thread, turn.id);
      await act(async () => real.emit(real.channels.updated, { thread: view(op.thread, turn.id) }));
    } else if (op.kind === "stop") {
      const turn = latest(model, model.selected)!;
      if (blockingReply(model, turn) === undefined) model.replies.push({ turn, outcome: "pending" });
      // Two clicks before a render exercise the synchronous duplicate guard.
      await act(async () => { real.stop()?.click(); real.stop()?.click(); });
    } else if (op.kind === "reply") {
      const pending = model.replies.map((reply, index) => ({ reply, index })).filter(({ reply }) => reply.outcome === "pending");
      const { reply, index } = pending[op.index % pending.length]!;
      reply.outcome = op.fail ? "failed" : "acknowledged";
      const { gate } = real.cancellations[index]!;
      await act(async () => {
        if (op.fail) gate.reject(new Error("Cancellation transport failed"));
        else gate.resolve({ ok: true });
        await gate.promise.catch(() => undefined);
      });
    } else if (op.kind === "foreign") {
      const turn = latest(model, model.selected)!;
      await act(async () => real.emit(op.tool ? real.channels.tool : real.channels.delta, {
        threadId: turn.thread, turnId: "unadmitted-old-turn", messageId: "foreign-message",
        delta: "FOREIGN DELTA", callId: "foreign-call", summary: "FOREIGN TOOL", ok: true
      }));
      expect(real.container.textContent).not.toContain("FOREIGN");
    } else {
      const turn = latest(model, op.thread)!;
      if (op.kind === "finish") {
        turn.terminal = true;
        real.producers.set(op.thread, null);
        await act(async () => {
          real.emit(real.channels.commit, { threadId: op.thread, turnId: turn.id, message: {
            id: `message-${turn.id}`, role: "assistant", content: [{ kind: "text", text: "answer" }],
            status: "complete", createdAt: "2026-11-01T00:00:00.000Z"
          } });
          real.emit(real.channels.updated, { thread: view(op.thread, null) });
        });
      } else {
        turn.awaiting = true;
        const request = { threadId: turn.thread, turnId: turn.id, approvalId: `approval-${turn.id}`, summary: "Run a tool?" };
        await act(async () => real.emit(real.channels.updated, { thread: {
          ...view(turn.thread, turn.id), pendingApproval: request,
          status: { kind: "awaiting_approval", approvalId: request.approvalId }
        } }));
      }
    }
    verify(model, real);
  }
  toString() { return JSON.stringify(this.operation); }
}

const threadArb = fc.constantFrom<ThreadId>("a", "b");
const commands = fc.commands([
  ...(["admit", "select", "finish", "approval"] as const).map((kind) => threadArb.map((thread) => new Command({ kind, thread }))),
  fc.constant(new Command({ kind: "stop" })),
  fc.record({ index: fc.nat(10), fail: fc.boolean() }).map((op) => new Command({ kind: "reply", ...op })),
  fc.boolean().map((tool) => new Command({ kind: "foreign", tool }))
], { maxCommands: 20 });

describe.each(["library", "sizzle"] as const)("%s lifecycle model", (surface) => {
  test("a foreign tool cannot appear while the current turn's Stop is unacknowledged", async () => {
    const real = await mount(surface);
    try {
      await act(async () => real.stop()!.click());
      await act(async () => real.emit(real.channels.tool, {
        threadId: "a", turnId: "unadmitted-old-turn", callId: "foreign-call", summary: "FOREIGN TOOL", ok: true
      }));
      expect(real.stop()?.disabled).toBe(true);
      expect(real.container.textContent).not.toContain("FOREIGN TOOL");
      expect(real.cancellations.map(({ turn }) => turn)).toEqual(["turn-0"]);
    } finally { await real.dispose(); }
  });

  test("generated navigation, approval, completion and reply orders preserve producer-owned Stop", async () => {
    await fc.assert(fc.asyncProperty(commands, async (steps) => {
      const real = await mount(surface);
      try {
        await fc.asyncModelRun(() => ({ model: {
          selected: "a" as const,
          turns: [{ thread: "a" as const, id: "turn-0", terminal: false, awaiting: false }], replies: []
        }, real }), steps);
      } finally { await real.dispose(); }
    // Full panels cost more than a hook-only model: leave CI headroom inside
    // the default 5 s budget, with fresh command sequences on every run.
    }), { numRuns: 35 });
  });

  test("scheduled zero-delta terminal and startup commits correlate only within their producer thread", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom<ChatMessage["status"]>("failed", "complete"), async (scheduler, status) => {
      const real = await mount(surface);
      try {
        await real.select("b");
        const background = scheduler.schedule(Promise.resolve(), "A interrupted").then(async () => {
          await act(async () => {
            real.emit(real.channels.interrupted, { threadId: "a", turnId: "turn-0", reason: "user_interrupted" });
            real.emit(real.channels.updated, { thread: view("a", null) });
          });
        });
        const foreground = scheduler.schedule(Promise.resolve(), "B startup result").then(async () => {
          await act(async () => real.emit(real.channels.commit, { threadId: "b", message: {
            id: "startup", role: "assistant", content: [{ kind: "text", text: "startup" }],
            status, createdAt: "2026-11-01T00:00:00.000Z"
          } }));
          expect(real.container.querySelector('[data-testid="message-list-msg-startup"]')?.getAttribute("data-status")).toBe(status);
        });
        await scheduler.waitAll();
        await Promise.all([background, foreground]);
        await real.select("a");
        await act(async () => real.emit(real.channels.commit, { threadId: "a", message: {
          id: "interrupted", role: "assistant", content: [{ kind: "text", text: "interrupted" }],
          status: "complete", createdAt: "2026-11-01T00:00:00.000Z"
        } }));
        expect(real.container.querySelector('[data-testid="message-list-msg-interrupted"]')?.getAttribute("data-status")).toBe("interrupted");
      } finally { await real.dispose(); }
    }), { numRuns: 20 });
  });
});
