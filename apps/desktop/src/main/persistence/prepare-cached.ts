// Per-connection prepared-statement cache. better-sqlite3 does NOT
// memoize `db.prepare()` — every call re-parses and re-plans the SQL —
// so hot point-lookups (the `pwrsnap-capture://` protocol resolver
// runs `getCaptureById` on every un-cached renderer media fetch)
// should prepare once per connection and reuse the handle.
//
// Keyed WeakMap-on-connection so a close/reopen cycle (or a test's
// fresh in-memory db) naturally drops the stale statements with the
// connection object; a prepared statement must never outlive the
// connection that compiled it.
//
// Deliberately its own module (not part of db.ts): repo tests mock
// `./db` to inject an in-memory connection, and this helper must keep
// working verbatim against whatever connection those mocks hand out.

import type Database from "better-sqlite3";

const preparedStatementCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function prepareCached(db: Database.Database, sql: string): Database.Statement {
  let bySql = preparedStatementCache.get(db);
  if (bySql === undefined) {
    bySql = new Map();
    preparedStatementCache.set(db, bySql);
  }
  let stmt = bySql.get(sql);
  if (stmt === undefined) {
    stmt = db.prepare(sql);
    bySql.set(sql, stmt);
  }
  return stmt;
}
