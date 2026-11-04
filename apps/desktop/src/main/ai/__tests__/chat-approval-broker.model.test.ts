import { describe, expect, test } from "vitest";
import fc from "fast-check";
import type { ChatApprovalDecision, ChatApprovalRequest, PwrSnapError, Result } from "@pwrsnap/shared";
import { ChatApprovalBroker } from "../chat-approval-broker";

type Decision = "approve" | "deny";
type Reason = "request_replaced" | "controller_disposed" | "thread_closed" | "request_stale";
type Attempt = { decision: Decision; settled: boolean };
type Request = {
  input: ChatApprovalRequest; owner: number; retired: Reason | null;
  answered: Decision | null; attempts: Attempt[]; autoDenied: boolean;
};
type Event = { id: string; outcome: Decision | Reason };
type Model = { requests: Request[]; closedOwners: Set<number>; closedThreads: Set<string>; events: Event[] };

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(surface: "library" | "sizzle") {
  const events: Event[] = [];
  const calls: { request: number; decision: ChatApprovalDecision }[] = [];
  const attempts: { request: number; gate: ReturnType<typeof deferred>; result: Promise<Result<void, PwrSnapError>> }[] = [];
  const owners = [{}, {}, {}];
  let submitting: number | null = null;
  let callbackGate: ReturnType<typeof deferred> | null = null;
  const broker = new ChatApprovalBroker({
    surface, loggerScope: "test:chat-approval-model",
    emitResolved: (event) => events.push({ id: event.approvalId, outcome: event.decision as Decision }),
    emitSuperseded: (event) => events.push({ id: event.approvalId, outcome: event.reason })
  });
  return {
    broker, events, calls, attempts, owners,
    register(request: Request, index: number) {
      return broker.register(request.input, owners[request.owner]!, async (decision) => {
        calls.push({ request: index, decision });
        if (submitting === index) {
          // A real resolver has one in-flight transport decision. A second
          // call here would send the same approval twice to its controller.
          expect(callbackGate).toBeNull();
          callbackGate = deferred();
          await callbackGate.promise;
        } else {
          // Cleanup may only deny; it cannot reuse an earlier user approval.
          expect(decision).toBe("deny");
        }
      });
    },
    respond(request: Request, index: number, decision: Decision) {
      submitting = index;
      callbackGate = null;
      const result = broker.resolve({ ...request.input, decision });
      submitting = null;
      if (callbackGate !== null) attempts.push({ request: index, gate: callbackGate, result });
      return result;
    },
    async drain() {
      for (const { gate } of attempts) gate.resolve();
      await Promise.all(attempts.map(({ result }) => result));
    }
  };
}
type Real = ReturnType<typeof setup>;

// Oracle is an append-only history of user requests and controller lifetimes.
// A pending card is the newest unanswered, unretired request for its producer;
// late callbacks cannot revive history or answer a different request.
function live(request: Request) { return request.retired === null && request.answered === null; }
function inFlight(request: Request) { return request.attempts.findLast((attempt) => !attempt.settled); }

async function verify(model: Model, real: Real) {
  // Flush best-effort denials, which deliberately never block teardown.
  await Promise.resolve();
  await Promise.resolve();
  for (const thread of ["a", "b"]) {
    const pending = model.requests.findLast((request) => request.input.threadId === thread && live(request));
    expect(real.broker.pendingForThread(thread)).toEqual(pending?.input ?? null);
  }
  const expectedCalls = model.requests.flatMap((request, index) => [
    ...request.attempts.map((attempt) => ({ request: index, decision: attempt.decision })),
    ...(request.autoDenied ? [{ request: index, decision: "deny" }] : [])
  ]);
  // Ordering between cleanup microtasks is irrelevant; exact callback identity
  // and the number of decisions delivered to each controller are not.
  const sort = (items: typeof expectedCalls) => items.map((item) => JSON.stringify(item)).sort();
  expect(sort(real.calls)).toEqual(sort(expectedCalls));
  expect(real.events).toEqual(model.events);
}

function retire(model: Model, request: Request, reason: Reason) {
  if (!live(request)) return;
  request.retired = reason;
  if (inFlight(request) === undefined) request.autoDenied = true;
  model.events.push({ id: request.input.approvalId, outcome: reason });
}

type Operation =
  | { kind: "register"; thread: string; owner: number }
  | { kind: "respond"; index: number; decision: Decision }
  | { kind: "settle"; index: number; fail: boolean }
  | { kind: "close-owner"; owner: number }
  | { kind: "close-thread" | "open-thread"; thread: string };

class Command implements fc.AsyncCommand<Model, Real> {
  constructor(readonly op: Operation) {}
  check(model: Readonly<Model>) {
    if (this.op.kind === "respond") return model.requests.length > 0;
    if (this.op.kind === "settle") return model.requests.some((request) => inFlight(request) !== undefined);
    return true;
  }
  async run(model: Model, real: Real) {
    const op = this.op;
    if (op.kind === "register") {
      const index = model.requests.length;
      const closed = model.closedOwners.has(op.owner) || model.closedThreads.has(op.thread);
      const request: Request = {
        input: { threadId: op.thread, turnId: `turn-${index}`, approvalId: `approval-${index}`, summary: "Run a tool?" },
        owner: op.owner, retired: closed ? "request_stale" : null, answered: null,
        attempts: [], autoDenied: closed
      };
      if (!closed) for (const previous of model.requests) {
        if (previous.input.threadId === op.thread) retire(model, previous, "request_replaced");
      }
      model.requests.push(request);
      expect(real.register(request, index)).toBe(!closed);
    } else if (op.kind === "close-owner") {
      model.closedOwners.add(op.owner);
      for (const request of model.requests) if (request.owner === op.owner) retire(model, request, "controller_disposed");
      real.broker.closeOwner(real.owners[op.owner]!);
    } else if (op.kind === "close-thread") {
      model.closedThreads.add(op.thread);
      for (const request of model.requests) if (request.input.threadId === op.thread) retire(model, request, "thread_closed");
      real.broker.closeThread(op.thread);
    } else if (op.kind === "open-thread") {
      model.closedThreads.delete(op.thread);
      real.broker.openThread(op.thread);
    } else if (op.kind === "respond") {
      const index = op.index % model.requests.length;
      const request = model.requests[index]!;
      const activeAttempt = inFlight(request);
      const previousResult = real.attempts.findLast((attempt) => attempt.request === index)?.result;
      const result = real.respond(request, index, op.decision);
      if (request.answered !== null || request.retired !== null) {
        model.events.push({ id: request.input.approvalId, outcome: request.answered ?? request.retired! });
        expect((await result).ok).toBe(request.answered === op.decision);
      } else if (activeAttempt !== undefined) {
        if (activeAttempt.decision === op.decision) expect(result).toBe(previousResult);
        else {
          const conflict = await result;
          expect(conflict.ok).toBe(false);
          if (!conflict.ok) expect(conflict.error.code).toBe("approval_response_in_progress");
        }
      } else {
        request.attempts.push({ decision: op.decision, settled: false });
      }
    } else {
      const pending = model.requests.flatMap((request, index) => inFlight(request) === undefined ? [] : [{ request, index }]);
      const { request, index } = pending[op.index % pending.length]!;
      const attempt = inFlight(request)!;
      attempt.settled = true;
      const actual = real.attempts.findLast((candidate) => candidate.request === index)!;
      if (op.fail) actual.gate.reject(new Error("Controller response transport failed"));
      else actual.gate.resolve();
      expect((await actual.result).ok).toBe(!op.fail);
      if (!op.fail && live(request)) {
        request.answered = attempt.decision;
        model.events.push({ id: request.input.approvalId, outcome: attempt.decision });
      }
    }
    await verify(model, real);
  }
  toString() { return JSON.stringify(this.op); }
}

const thread = fc.constantFrom("a", "b");
const owner = fc.integer({ min: 0, max: 2 });
const commands = fc.commands([
  fc.record({ thread, owner }).map((op) => new Command({ kind: "register", ...op })),
  fc.record({ index: fc.nat(20), decision: fc.constantFrom<Decision>("approve", "deny") }).map((op) => new Command({ kind: "respond", ...op })),
  fc.record({ index: fc.nat(20), fail: fc.boolean() }).map((op) => new Command({ kind: "settle", ...op })),
  owner.map((value) => new Command({ kind: "close-owner", owner: value })),
  ...(["close-thread", "open-thread"] as const).map((kind) => thread.map((value) => new Command({ kind, thread: value })))
], { maxCommands: 40 });

describe.each(["library", "sizzle"] as const)("%s approval ownership model", (surface) => {
  test("generated retries, retransmissions and controller/thread lifetimes preserve exact authority", async () => {
    await fc.assert(fc.asyncProperty(commands, async (steps) => {
      const real = setup(surface);
      try {
        await fc.asyncModelRun(() => ({ model: {
          requests: [], closedOwners: new Set<number>(), closedThreads: new Set<string>(), events: []
        }, real }), steps);
      } finally { await real.drain(); }
    }), { numRuns: 300 });
  });
});
