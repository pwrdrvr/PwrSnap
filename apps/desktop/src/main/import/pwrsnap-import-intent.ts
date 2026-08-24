import { randomUUID } from "node:crypto";

import { getDb } from "../persistence/db";
import type { ImportFileIdentity, ImportStageArtifact } from "./pwrsnap-import-install";
import {
  parseImportIdentity,
  serializeImportIdentity
} from "./pwrsnap-import-install";

export type PwrsnapImportIntent = {
  id: string;
  captureId: string;
  bundlePath: string;
  stagePath: string;
  stageIdentity: ImportFileIdentity;
  archiveSha256: string;
  archiveSize: number;
  contentDigest: string;
  captureIdChanged: boolean;
  remappedLayerCount: number;
  publishedIdentity: ImportFileIdentity | null;
};

type IntentRow = {
  id: string;
  capture_id: string;
  bundle_path: string;
  stage_path: string;
  stage_identity_json: string;
  archive_sha256: string;
  archive_size: number;
  content_digest: string;
  capture_id_changed: number;
  remapped_layer_count: number;
  published_identity_json: string | null;
};

export function createPwrsnapImportIntent(input: {
  captureId: string;
  bundlePath: string;
  stage: ImportStageArtifact;
  contentDigest: string;
  captureIdChanged: boolean;
  remappedLayerCount: number;
}): PwrsnapImportIntent {
  const id = randomUUID();
  const db = getDb();
  const previousSynchronous = db.pragma("synchronous", { simple: true }) as number;
  try {
    // The app normally uses WAL + NORMAL. This one commit must reach durable
    // storage before filesystem publication, otherwise a power loss could keep
    // the final hard link but lose its ownership intent.
    if (previousSynchronous < 2) db.pragma("synchronous = FULL");
    db.prepare(
      `INSERT INTO pwrsnap_import_intents (
         id, capture_id, bundle_path, stage_path, stage_identity_json,
         archive_sha256, archive_size, content_digest, capture_id_changed,
         remapped_layer_count
       ) VALUES (
         @id, @capture_id, @bundle_path, @stage_path, @stage_identity_json,
         @archive_sha256, @archive_size, @content_digest, @capture_id_changed,
         @remapped_layer_count
       )`
    ).run({
      id,
      capture_id: input.captureId,
      bundle_path: input.bundlePath,
      stage_path: input.stage.path,
      stage_identity_json: serializeImportIdentity(input.stage.identity),
      archive_sha256: input.stage.sha256,
      archive_size: input.stage.size,
      content_digest: input.contentDigest,
      capture_id_changed: input.captureIdChanged ? 1 : 0,
      remapped_layer_count: input.remappedLayerCount
    });
  } finally {
    if (previousSynchronous < 2) db.pragma(`synchronous = ${previousSynchronous}`);
  }
  return getPwrsnapImportIntent(id)!;
}

export function markPwrsnapImportPublished(
  intentId: string,
  identity: ImportFileIdentity
): void {
  getDb()
    .prepare(
      `UPDATE pwrsnap_import_intents
          SET published_identity_json = ?, updated_at = datetime('now')
        WHERE id = ?`
    )
    .run(serializeImportIdentity(identity), intentId);
}

export function listPwrsnapImportIntents(): PwrsnapImportIntent[] {
  const rows = getDb()
    .prepare(
      `SELECT id, capture_id, bundle_path, stage_path, stage_identity_json,
              archive_sha256, archive_size, content_digest,
              capture_id_changed, remapped_layer_count,
              published_identity_json
         FROM pwrsnap_import_intents
        ORDER BY created_at ASC, id ASC`
    )
    .all() as IntentRow[];
  return rows.map(rowToIntent);
}

export function getPwrsnapImportIntent(id: string): PwrsnapImportIntent | null {
  const row = getDb()
    .prepare(
      `SELECT id, capture_id, bundle_path, stage_path, stage_identity_json,
              archive_sha256, archive_size, content_digest,
              capture_id_changed, remapped_layer_count,
              published_identity_json
         FROM pwrsnap_import_intents
        WHERE id = ?`
    )
    .get(id) as IntentRow | undefined;
  return row === undefined ? null : rowToIntent(row);
}

export function deletePwrsnapImportIntent(id: string): void {
  getDb().prepare("DELETE FROM pwrsnap_import_intents WHERE id = ?").run(id);
}

export function deletePwrsnapImportIntentInCurrentTransaction(id: string): void {
  deletePwrsnapImportIntent(id);
}

function rowToIntent(row: IntentRow): PwrsnapImportIntent {
  return {
    id: row.id,
    captureId: row.capture_id,
    bundlePath: row.bundle_path,
    stagePath: row.stage_path,
    stageIdentity: parseImportIdentity(row.stage_identity_json),
    archiveSha256: row.archive_sha256,
    archiveSize: row.archive_size,
    contentDigest: row.content_digest,
    captureIdChanged: row.capture_id_changed !== 0,
    remappedLayerCount: row.remapped_layer_count,
    publishedIdentity:
      row.published_identity_json === null
        ? null
        : parseImportIdentity(row.published_identity_json)
  };
}
