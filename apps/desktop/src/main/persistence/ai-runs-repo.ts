import { nanoid } from "nanoid";
import type { AiRunSnapshot, AiRunStatus } from "@pwrsnap/shared";
import { getDb } from "./db";

type AiRunRow = {
  id: string;
  capture_id: string;
  kind: "enrich";
  status: AiRunStatus;
  codex_command: string | null;
  codex_version: string | null;
  codex_protocol_version: string | null;
  prompt_version: number;
  request_json: string | null;
  response_json: string | null;
  error: string | null;
  latency_ms: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type CreateAiRunInput = {
  captureId: string;
  codexCommand?: string | null;
  codexVersion?: string | null;
  codexProtocolVersion?: string | null;
  promptVersion?: number | undefined;
  request?: Record<string, unknown> | null;
};

function rowToSnapshot(row: AiRunRow): AiRunSnapshot {
  return {
    id: row.id,
    captureId: row.capture_id,
    kind: row.kind,
    status: row.status,
    error: row.error,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

export function createAiRun(input: CreateAiRunInput): AiRunSnapshot {
  const db = getDb();
  const id = nanoid();
  db.prepare(
    `INSERT INTO ai_runs (
      id, capture_id, kind, status,
      codex_command, codex_version, codex_protocol_version,
      prompt_version, request_json
    ) VALUES (
      @id, @captureId, 'enrich', 'queued',
      @codexCommand, @codexVersion, @codexProtocolVersion,
      @promptVersion, @requestJson
    )`
  ).run({
    id,
    captureId: input.captureId,
    codexCommand: input.codexCommand ?? null,
    codexVersion: input.codexVersion ?? null,
    codexProtocolVersion: input.codexProtocolVersion ?? null,
    promptVersion: input.promptVersion ?? 1,
    requestJson: input.request === undefined || input.request === null ? null : JSON.stringify(input.request)
  });
  const inserted = db.prepare("SELECT * FROM ai_runs WHERE id = ?").get(id) as AiRunRow;
  return rowToSnapshot(inserted);
}

export function markAiRunRunning(id: string): AiRunSnapshot | null {
  const db = getDb();
  db.prepare(
    `UPDATE ai_runs
     SET status = 'running', started_at = COALESCE(started_at, datetime('now'))
     WHERE id = ?`
  ).run(id);
  return getAiRun(id);
}

export function completeAiRun(
  id: string,
  response: Record<string, unknown>,
  latencyMs: number
): AiRunSnapshot | null {
  const db = getDb();
  db.prepare(
    `UPDATE ai_runs
     SET status = 'completed',
         response_json = @responseJson,
         latency_ms = @latencyMs,
         completed_at = datetime('now')
     WHERE id = @id`
  ).run({ id, responseJson: JSON.stringify(response), latencyMs });
  return getAiRun(id);
}

export function failAiRun(id: string, error: string, latencyMs: number | null = null): AiRunSnapshot | null {
  const db = getDb();
  db.prepare(
    `UPDATE ai_runs
     SET status = 'failed',
         error = @error,
         latency_ms = @latencyMs,
         completed_at = datetime('now')
     WHERE id = @id`
  ).run({ id, error, latencyMs });
  return getAiRun(id);
}

export function cancelAiRun(id: string, error = "cancelled"): AiRunSnapshot | null {
  const db = getDb();
  db.prepare(
    `UPDATE ai_runs
     SET status = 'cancelled',
         error = @error,
         completed_at = datetime('now')
     WHERE id = @id AND status IN ('queued', 'running')`
  ).run({ id, error });
  return getAiRun(id);
}

export function getAiRun(id: string): AiRunSnapshot | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM ai_runs WHERE id = ?").get(id) as AiRunRow | undefined;
  return row ? rowToSnapshot(row) : null;
}
