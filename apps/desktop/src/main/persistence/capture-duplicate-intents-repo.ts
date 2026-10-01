// `capture_duplicate_intents` (migration 0036): a video duplicate that has
// started writing files but has not committed its capture row. See the
// migration for the protocol; capture-duplicate.ts is the only writer.

import { getDb } from "./db";

export type CaptureDuplicateIntent = {
  captureId: string;
  sourceId: string;
  stagingPath: string;
  destPath: string;
};

type IntentRow = {
  capture_id: string;
  source_id: string;
  staging_path: string;
  dest_path: string;
};

export function insertCaptureDuplicateIntent(intent: CaptureDuplicateIntent): void {
  getDb()
    .prepare(
      `INSERT INTO capture_duplicate_intents (capture_id, source_id, staging_path, dest_path)
       VALUES (@captureId, @sourceId, @stagingPath, @destPath)`
    )
    .run(intent);
}

/** Call inside the transaction that inserts the capture row, so the two
 *  commit together. */
export function deleteCaptureDuplicateIntent(captureId: string): void {
  getDb().prepare("DELETE FROM capture_duplicate_intents WHERE capture_id = ?").run(captureId);
}

export function listCaptureDuplicateIntents(): CaptureDuplicateIntent[] {
  const rows = getDb()
    .prepare(
      `SELECT capture_id, source_id, staging_path, dest_path
         FROM capture_duplicate_intents
        ORDER BY created_at ASC`
    )
    .all() as IntentRow[];
  return rows.map((row) => ({
    captureId: row.capture_id,
    sourceId: row.source_id,
    stagingPath: row.staging_path,
    destPath: row.dest_path
  }));
}
