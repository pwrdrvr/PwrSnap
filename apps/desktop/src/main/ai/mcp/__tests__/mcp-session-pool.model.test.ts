import fc from "fast-check";
import { expect, test } from "vitest";
import { McpSessionPool } from "../mcp-session-pool";

type Session = { id: number; valid: boolean; closed: number };
type Model = { limit: number; sessions: Map<number, Session>; retired: Session[] };
type Real = { pool: McpSessionPool<Session>; scheduler: fc.Scheduler };
const prune = (model: Model): void => {
  for (const [id, value] of model.sessions) if (!value.valid) {
    model.sessions.delete(id);
    model.retired.push(value);
  }
};
const check = (model: Model, real: Real): void => {
  expect(real.pool.values()).toEqual([...model.sessions.values()]);
  expect(real.pool.values().length).toBeLessThanOrEqual(model.limit);
  for (const value of model.retired) expect(value.closed).toBe(1);
};

class Admit implements fc.AsyncCommand<Model, Real> {
  constructor(readonly ids: number[]) {}
  check(): boolean { return true; }
  async run(model: Model, real: Real): Promise<void> {
    const candidates = this.ids.map((id) => ({ id, valid: true, closed: 0 }));
    const expected = candidates.map((value) => {
      prune(model);
      if (model.sessions.has(value.id) || model.sessions.size === model.limit) return false;
      model.sessions.set(value.id, value);
      return true;
    });
    const actual = await real.scheduler.waitFor(Promise.all(
      candidates.map((value) => real.pool.admit(value.id, value))
    ));
    expect(actual).toEqual(expected);
    check(model, real);
  }
  toString(): string { return `admit concurrently(${this.ids.join(",")})`; }
}
class Revoke implements fc.AsyncCommand<Model, Real> {
  constructor(readonly id: number) {}
  check(): boolean { return true; }
  async run(model: Model, real: Real): Promise<void> {
    const session = model.sessions.get(this.id);
    if (session) session.valid = false;
    check(model, real);
  }
  toString(): string { return `revoke(${this.id})`; }
}
class Cleanup implements fc.AsyncCommand<Model, Real> {
  constructor(readonly clear: boolean) {}
  check(): boolean { return true; }
  async run(model: Model, real: Real): Promise<void> {
    if (this.clear) {
      model.retired.push(...model.sessions.values());
      model.sessions.clear();
      await real.scheduler.waitFor(real.pool.clear());
    } else {
      prune(model);
      await real.scheduler.waitFor(real.pool.prune());
    }
    check(model, real);
  }
  toString(): string { return this.clear ? "shutdown()" : "prune()"; }
}
test("scheduled session histories preserve capacity, identity and exactly-once revocation cleanup", async () => {
  const commands = fc.commands([
    fc.array(fc.integer({ min: 0, max: 8 }), { minLength: 1, maxLength: 5 }).map((ids) => new Admit(ids)),
    fc.integer({ min: 0, max: 8 }).map((id) => new Revoke(id)),
    fc.boolean().map((clear) => new Cleanup(clear))
  ], { maxCommands: 30 });
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.scheduler(), commands,
    async (limit, scheduler, history) => {
      const model: Model = { limit, sessions: new Map(), retired: [] };
      const pool = new McpSessionPool<Session>(limit,
        scheduler.scheduleFunction(async (value) => value.valid),
        scheduler.scheduleFunction(async (value) => { value.closed++; })
      );
      await fc.asyncModelRun(() => ({ model, real: { pool, scheduler } }), history);
      await scheduler.waitFor(pool.clear());
    }
  ));
});

test("a repeated live connection id cannot replace and orphan its admitted Session", async () => {
  const pool = new McpSessionPool<Session>(2, async (value) => value.valid,
    async (value) => { value.closed++; });
  const original = { id: 0, valid: true, closed: 0 };
  const replacement = { id: 0, valid: true, closed: 0 };
  expect(await pool.admit(0, original)).toBe(true);
  expect(await pool.admit(0, replacement)).toBe(false);
  expect(pool.values()).toEqual([original]);
  await pool.clear();
  expect(original.closed).toBe(1);
});
