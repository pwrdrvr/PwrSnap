import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  LocalAgentRoleBudgets,
  LocalAgentSlidingWindowBudget,
  LocalAgentUsageAction,
  LocalAgentUsageSnapshot
} from "@pwrsnap/shared";
import { getDb } from "../persistence/db";

const MAX_EVENT_RETENTION_MS = 366 * 24 * 60 * 60 * 1_000;

export type LocalAgentUsageReservation = {
  id: string;
  sessionId: string;
  action: LocalAgentUsageAction;
  used: number;
  limit: number;
  windowSeconds: number;
};

export type LocalAgentUsageDecision =
  | { ok: true; reservation: LocalAgentUsageReservation }
  | {
      ok: false;
      used: number;
      limit: number;
      windowSeconds: number;
      retryAt: string | null;
    };

/** SQLite reservation ledger. Reserving before execution closes concurrent
 *  check-then-act races; callers release the reservation when the protected
 *  action fails, so only successful actions remain counted. */
export class LocalAgentUsageService {
  private readonly resolveDb: () => Database.Database;
  private readonly now: () => Date;
  private readonly makeId: () => string;

  constructor(options: {
    db?: Database.Database | (() => Database.Database);
    now?: () => Date;
    makeId?: () => string;
  } = {}) {
    this.resolveDb =
      typeof options.db === "function"
        ? options.db
        : options.db === undefined
          ? getDb
          : () => options.db as Database.Database;
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? randomUUID;
  }

  reserve(input: {
    sessionId: string;
    action: LocalAgentUsageAction;
    budget: LocalAgentSlidingWindowBudget;
    resourceId?: string;
  }): LocalAgentUsageDecision {
    const db = this.resolveDb();
    const nowMs = this.now().getTime();
    const cutoffMs = nowMs - input.budget.windowSeconds * 1_000;
    return db.transaction(() => {
      db.prepare("DELETE FROM local_agent_usage_events WHERE occurred_at_ms <= ?")
        .run(nowMs - MAX_EVENT_RETENTION_MS);
      const rows = db.prepare(
        `SELECT occurred_at_ms
         FROM local_agent_usage_events
         WHERE session_id = ? AND action = ? AND occurred_at_ms > ?
         ORDER BY occurred_at_ms ASC`
      ).all(input.sessionId, input.action, cutoffMs) as Array<{
        occurred_at_ms: number;
      }>;
      if (rows.length >= input.budget.limit) {
        const oldest = rows[0]?.occurred_at_ms;
        return {
          ok: false as const,
          used: rows.length,
          limit: input.budget.limit,
          windowSeconds: input.budget.windowSeconds,
          retryAt:
            oldest === undefined
              ? null
              : new Date(oldest + input.budget.windowSeconds * 1_000).toISOString()
        };
      }
      const id = this.makeId();
      db.prepare(
        `INSERT INTO local_agent_usage_events
           (id, session_id, action, resource_id, occurred_at_ms)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        id,
        input.sessionId,
        input.action,
        input.resourceId ?? null,
        nowMs
      );
      return {
        ok: true as const,
        reservation: {
          id,
          sessionId: input.sessionId,
          action: input.action,
          used: rows.length + 1,
          limit: input.budget.limit,
          windowSeconds: input.budget.windowSeconds
        }
      };
    })();
  }

  release(reservationId: string): void {
    this.resolveDb()
      .prepare("DELETE FROM local_agent_usage_events WHERE id = ?")
      .run(reservationId);
  }

  snapshots(
    sessionId: string,
    budgets: LocalAgentRoleBudgets
  ): LocalAgentUsageSnapshot[] {
    const db = this.resolveDb();
    const nowMs = this.now().getTime();
    return (Object.keys(budgets) as LocalAgentUsageAction[]).map((action) => {
      const budget = budgets[action];
      const cutoffMs = nowMs - budget.windowSeconds * 1_000;
      const row = db.prepare(
        `SELECT COUNT(*) AS used, MIN(occurred_at_ms) AS oldest
         FROM local_agent_usage_events
         WHERE session_id = ? AND action = ? AND occurred_at_ms > ?`
      ).get(sessionId, action, cutoffMs) as {
        used: number;
        oldest: number | null;
      };
      return {
        action,
        used: row.used,
        limit: budget.limit,
        windowSeconds: budget.windowSeconds,
        oldestCountedAt:
          row.oldest === null ? null : new Date(row.oldest).toISOString(),
        nextReleaseAt:
          row.oldest === null
            ? null
            : new Date(row.oldest + budget.windowSeconds * 1_000).toISOString()
      };
    });
  }
}
