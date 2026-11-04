import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { expect, test } from "vitest";
import {
  resetDerivedCacheGateForTests,
  runGatedCacheWrite,
  withDerivedCacheCleanup,
  type DerivedCacheCleanupScope
} from "../derived-cache-gate";

type Scope = "all" | "cap-a" | "cap-b";
type RequestState = "waiting" | "completed" | "cancelled";
type Operation = {
  scope: Scope;
  kind: "migration" | "delete";
  fail: boolean;
  released: boolean;
  done: boolean;
};
type Model = {
  operations: Operation[];
  requests: { capture: string; artifact: string; state: RequestState }[];
  files: Map<string, string>;
};
type Real = {
  root: string;
  operations: { release: () => void; pending: Promise<void>; state: string }[];
  requests: { controller: AbortController; pending: Promise<void>; state: string; started: boolean }[];
};
type Action =
  | { kind: "migration"; scope: Scope; fail: boolean }
  | { kind: "delete"; scope: Scope }
  | { kind: "request"; capture: string; artifact: string }
  | { kind: "cancel" | "release"; index: number };

const matches = (scope: Scope, capture: string): boolean => scope === "all" || scope === capture;
const fileKey = (capture: string, artifact: string): string => `${capture}/${artifact}`;

// Contract oracle: maintenance delays a request; deletion or caller abort
// cancels it permanently. Operations finish in issue order. No implementation
// maps, reference counts, coalescing keys or promise chains are reproduced here.
function advance(model: Model): void {
  for (const operation of model.operations) {
    if (operation.done) continue;
    if (!operation.released) break;
    operation.done = true;
    if (operation.kind === "delete") {
      for (const key of model.files.keys()) {
        if (matches(operation.scope, key.split("/")[0]!)) model.files.delete(key);
      }
    }
  }
  for (const request of model.requests) {
    if (request.state !== "waiting") continue;
    if (model.operations.some((op) => !op.done && matches(op.scope, request.capture))) continue;
    request.state = "completed";
    const key = fileKey(request.capture, request.artifact);
    model.files.set(key, key);
  }
}

async function readFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const capture of await readdir(root)) {
    for (const artifact of await readdir(join(root, capture))) {
      const key = fileKey(capture, artifact);
      files.set(key, await readFile(join(root, capture, artifact), "utf8"));
    }
  }
  return files;
}

async function verify(model: Model, real: Real): Promise<void> {
  // Await only work the model says can finish. Deliberately held operations
  // and requests stay pending; there are no elapsed-time assertions or sleeps.
  await Promise.all(model.operations.flatMap((op, i) => op.done ? [real.operations[i]!.pending] : []));
  await Promise.all(model.requests.flatMap((req, i) => req.state !== "waiting" ? [real.requests[i]!.pending] : []));
  await Promise.resolve();
  expect(real.operations.map((op) => op.state)).toEqual(
    model.operations.map((op) => op.done ? (op.fail ? "failed" : "completed") : "waiting")
  );
  expect(real.requests.map((req) => req.state)).toEqual(model.requests.map((req) => req.state));
  for (const [i, request] of model.requests.entries()) {
    if (request.state !== "completed") expect(real.requests[i]!.started).toBe(false);
  }
  // The filesystem is a second oracle: cancellation cannot publish a file,
  // and completed deletion cannot be undone by a previously queued request.
  expect(await readFiles(real.root)).toEqual(model.files);
}

class CacheCommand implements fc.AsyncCommand<Model, Real> {
  constructor(private readonly action: Action) {}

  check(model: Readonly<Model>): boolean {
    if (this.action.kind === "cancel") return model.requests.length > 0;
    if (this.action.kind === "release") return model.operations.some((op) => !op.done);
    return true;
  }

  async run(model: Model, real: Real): Promise<void> {
    const action = this.action;
    if (action.kind === "migration" || action.kind === "delete") {
      const operation: Operation = {
        scope: action.scope, kind: action.kind,
        fail: action.kind === "migration" && action.fail, released: false, done: false
      };
      model.operations.push(operation);
      if (action.kind === "delete") {
        for (const request of model.requests) {
          if (request.state === "waiting" && matches(action.scope, request.capture)) request.state = "cancelled";
        }
      }
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const record = { release, pending: Promise.resolve(), state: "waiting" };
      const scope: DerivedCacheCleanupScope = action.scope === "all" ? "all" : { captureId: action.scope };
      record.pending = withDerivedCacheCleanup(scope, async () => {
        await barrier;
        if (operation.fail) throw new Error("migration fixture failure");
        if (action.kind === "delete") {
          await rm(action.scope === "all" ? real.root : join(real.root, action.scope), { recursive: true, force: true });
          await mkdir(real.root, { recursive: true });
        }
      }, action.kind === "migration" ? { writeAdmission: "wait" } : {}).then(
        () => { record.state = "completed"; },
        (cause: unknown) => {
          record.state = cause instanceof Error && cause.message === "migration fixture failure" ? "failed" : String(cause);
        }
      );
      real.operations.push(record);
    } else if (action.kind === "request") {
      const refused = model.operations.some((op) => !op.done && op.kind === "delete" && matches(op.scope, action.capture));
      model.requests.push({ capture: action.capture, artifact: action.artifact, state: refused ? "cancelled" : "waiting" });
      const record = { controller: new AbortController(), pending: Promise.resolve(), state: "waiting", started: false };
      const target = join(real.root, action.capture, action.artifact);
      record.pending = runGatedCacheWrite(action.capture, target, async (signal) => {
        record.started = true;
        // Same-artifact consumers may share this callback. The exclusive
        // staging open rejects concurrent encoders for one publication path.
        const expected = fileKey(action.capture, action.artifact);
        try {
          expect(await readFile(target, "utf8")).toBe(expected);
          return;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        await mkdir(join(real.root, action.capture), { recursive: true });
        const staging = `${target}.tmp`;
        try {
          signal.throwIfAborted();
          await writeFile(staging, expected, { flag: "wx" });
          signal.throwIfAborted();
          await rename(staging, target);
        } finally {
          await rm(staging, { force: true });
        }
      }, record.controller.signal).then(
        () => { record.state = "completed"; },
        (cause: unknown) => { record.state = cause instanceof Error && cause.name === "AbortError" ? "cancelled" : String(cause); }
      );
      real.requests.push(record);
    } else if (action.kind === "cancel") {
      const index = action.index % model.requests.length;
      if (model.requests[index]!.state === "waiting") model.requests[index]!.state = "cancelled";
      real.requests[index]!.controller.abort();
    } else {
      const pending = model.operations.map((op, index) => ({ op, index })).filter(({ op }) => !op.done);
      const selected = pending[action.index % pending.length]!;
      selected.op.released = true;
      real.operations[selected.index]!.release();
    }
    advance(model);
    await verify(model, real);
  }

  toString(): string { return JSON.stringify(this.action); }
}

const scope = fc.constantFrom<Scope>("all", "cap-a", "cap-b");
const command = fc.oneof(
  fc.record({ kind: fc.constant("migration" as const), scope, fail: fc.boolean() }),
  fc.record({ kind: fc.constant("delete" as const), scope }),
  fc.record({ kind: fc.constant("request" as const), capture: fc.constantFrom("cap-a", "cap-b"), artifact: fc.constantFrom("playback", "frames") }),
  fc.record({ kind: fc.constantFrom("cancel" as const, "release" as const), index: fc.nat(20) })
).map((action) => new CacheCommand(action));

test("generated cache sessions preserve queued requests and never publish cancelled work after deletion", async () => {
  await fc.assert(fc.asyncProperty(fc.commands([command], { maxCommands: 20 }), async (commands) => {
    resetDerivedCacheGateForTests();
    const root = await mkdtemp(join(tmpdir(), "pwrsnap-cache-model-"));
    const model: Model = { operations: [], requests: [], files: new Map() };
    const real: Real = { root, operations: [], requests: [] };
    try {
      await fc.asyncModelRun(() => ({ model, real }), commands);
      // Every run also ends by releasing all maintenance, including failures.
      // An all-cancelled queue must not spring back to life at this point.
      for (const [i, operation] of model.operations.entries()) {
        operation.released = true;
        real.operations[i]!.release();
      }
      advance(model);
      await verify(model, real);
    } finally {
      for (const operation of real.operations) operation.release();
      await Promise.all(real.operations.map((operation) => operation.pending));
      await Promise.all(real.requests.map((request) => request.pending));
      resetDerivedCacheGateForTests();
      await rm(root, { recursive: true, force: true });
    }
  }), { numRuns: 100 });
});
