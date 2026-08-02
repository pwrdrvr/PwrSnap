import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LocalAgentUsageService } from "../local-agent-usage";

let db: Database.Database;
let nowMs = Date.parse("2026-08-01T12:00:00.000Z");
let nextId = 0;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(readFileSync(join(
    import.meta.dirname,
    "../../persistence/migrations/0028_local_agent_usage_events.sql"
  ), "utf8"));
  nowMs = Date.parse("2026-08-01T12:00:00.000Z");
  nextId = 0;
});

afterEach(() => db.close());

function service(): LocalAgentUsageService {
  return new LocalAgentUsageService({
    db,
    now: () => new Date(nowMs),
    makeId: () => `usage_${++nextId}`
  });
}

describe("LocalAgentUsageService", () => {
  test("atomically reserves a sliding-window allowance", () => {
    const usage = service();
    const budget = { limit: 2, windowSeconds: 60 };
    expect(usage.reserve({ sessionId: "lag", action: "search", budget }).ok)
      .toBe(true);
    expect(usage.reserve({ sessionId: "lag", action: "search", budget }).ok)
      .toBe(true);
    const denied = usage.reserve({ sessionId: "lag", action: "search", budget });
    expect(denied).toMatchObject({ ok: false, used: 2, limit: 2 });

    nowMs += 60_001;
    expect(usage.reserve({ sessionId: "lag", action: "search", budget }).ok)
      .toBe(true);
  });

  test("releases failed reservations and reports live usage", () => {
    const usage = service();
    const budget = { limit: 1, windowSeconds: 3_600 };
    const reserved = usage.reserve({
      sessionId: "lag",
      action: "original.read",
      budget,
      resourceId: "cap_1"
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) throw new Error("unreachable");
    usage.release(reserved.reservation.id);
    expect(usage.reserve({
      sessionId: "lag",
      action: "original.read",
      budget
    }).ok).toBe(true);

    const snapshots = usage.snapshots("lag", {
      search: budget,
      "preview.read": budget,
      "original.read": budget,
      edit: budget,
      delete: budget
    });
    expect(snapshots.find((item) => item.action === "original.read"))
      .toMatchObject({ used: 1, limit: 1, windowSeconds: 3_600 });
  });
});
