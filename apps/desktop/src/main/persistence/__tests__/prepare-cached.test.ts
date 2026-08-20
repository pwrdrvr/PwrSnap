// `prepareCached` — the per-connection prepared-statement cache used
// by the protocol resolver's hot point-lookups (`getCaptureById`,
// `getVideoMetadata`). better-sqlite3 does not memoize `db.prepare`,
// so the cache is what keeps a renderer media fetch from re-parsing
// the same SQL on the main thread every request. Locked down:
//
//   1. Same (db, sql) → the SAME Statement object (no re-prepare).
//   2. Different sql on the same db → different statements.
//   3. A different connection never sees another connection's
//      statements (a prepared statement must not outlive — or cross —
//      the connection that compiled it).

import Database from "better-sqlite3";
import { afterAll, describe, expect, test } from "vitest";

import { prepareCached } from "../prepare-cached";

const dbA = new Database(":memory:");
const dbB = new Database(":memory:");
for (const db of [dbA, dbB]) {
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER)");
  db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", 1);
}

afterAll(() => {
  dbA.close();
  dbB.close();
});

describe("prepareCached", () => {
  test("returns the same statement object for repeat (db, sql) pairs", () => {
    const first = prepareCached(dbA, "SELECT * FROM t WHERE id = ?");
    const second = prepareCached(dbA, "SELECT * FROM t WHERE id = ?");
    expect(second).toBe(first);
    expect(first.get("a")).toEqual({ id: "a", v: 1 });
  });

  test("distinct sql on one connection gets distinct statements", () => {
    const byId = prepareCached(dbA, "SELECT * FROM t WHERE id = ?");
    const byV = prepareCached(dbA, "SELECT * FROM t WHERE v = ?");
    expect(byV).not.toBe(byId);
    expect(byV.get(1)).toEqual({ id: "a", v: 1 });
  });

  test("statements never cross connections", () => {
    const onA = prepareCached(dbA, "SELECT * FROM t WHERE id = ?");
    const onB = prepareCached(dbB, "SELECT * FROM t WHERE id = ?");
    expect(onB).not.toBe(onA);
    expect(onB.get("a")).toEqual({ id: "a", v: 1 });
  });
});
