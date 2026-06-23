import { nanoid } from "nanoid";
import type { CaptureEnrichment, CaptureEnrichmentSummary, EnrichmentResult } from "@pwrsnap/shared";
import {
  CaptureEnrichmentSchema,
  EnrichmentResultSchema,
  normalizeTagLabel
} from "@pwrsnap/shared";
import { getDb } from "./db";

type EnrichmentRow = {
  capture_id: string;
  latest_ai_run_id: string | null;
  status: CaptureEnrichment["status"];
  error: string | null;
  ocr_text: string | null;
  suggested_title: string | null;
  accepted_title: string | null;
  title_accepted_at: string | null;
  suggested_description: string | null;
  accepted_description: string | null;
  description_accepted_at: string | null;
  suggested_filename_stem: string | null;
  accepted_filename_stem: string | null;
  filename_accepted_at: string | null;
};

type TagSuggestionRow = {
  id: string;
  label: string;
  confidence: number | null;
  accepted_at: string | null;
  rejected_at: string | null;
};

type AcceptedTagRow = {
  label: string;
};

function emptyEnrichment(captureId: string): CaptureEnrichment {
  return {
    captureId,
    latestRunId: null,
    status: null,
    error: null,
    ocrText: null,
    suggestedTitle: null,
    acceptedTitle: null,
    titleAcceptedAt: null,
    suggestedDescription: null,
    acceptedDescription: null,
    descriptionAcceptedAt: null,
    suggestedFilenameStem: null,
    acceptedFilenameStem: null,
    filenameAcceptedAt: null,
    suggestedTags: [],
    acceptedTags: []
  };
}

function readTagSuggestions(captureId: string, latestRunId: string | null): TagSuggestionRow[] {
  if (latestRunId === null) return [];
  return getDb()
    .prepare(
      `SELECT id, label, confidence, accepted_at, rejected_at
       FROM enrichment_tag_suggestions
       WHERE capture_id = ?
         AND ai_run_id = ?
       ORDER BY accepted_at IS NOT NULL DESC, confidence DESC, created_at ASC`
    )
    .all(captureId, latestRunId) as TagSuggestionRow[];
}

function readAcceptedTags(captureId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT tags.label
       FROM capture_tags
       JOIN tags ON tags.id = capture_tags.tag_id
       WHERE capture_tags.capture_id = ?
       ORDER BY capture_tags.created_at ASC, tags.label ASC`
    )
    .all(captureId) as AcceptedTagRow[];
  return rows.map((row) => row.label);
}

export function getCaptureEnrichment(captureId: string): CaptureEnrichment | null {
  const db = getDb();
  const capture = db.prepare("SELECT id FROM captures WHERE id = ?").get(captureId) as
    | { id: string }
    | undefined;
  if (!capture) return null;

  const row = db
    .prepare(
      `SELECT capture_enrichments.capture_id,
              capture_enrichments.latest_ai_run_id,
              ai_runs.status,
              ai_runs.error,
              capture_enrichments.ocr_text,
              capture_enrichments.suggested_title,
              capture_enrichments.accepted_title,
              capture_enrichments.title_accepted_at,
              capture_enrichments.suggested_description,
              capture_enrichments.accepted_description,
              capture_enrichments.description_accepted_at,
              capture_enrichments.suggested_filename_stem,
              capture_enrichments.accepted_filename_stem,
              capture_enrichments.filename_accepted_at
       FROM capture_enrichments
       LEFT JOIN ai_runs ON ai_runs.id = capture_enrichments.latest_ai_run_id
       WHERE capture_enrichments.capture_id = ?`
    )
    .get(captureId) as EnrichmentRow | undefined;

  // `capture_enrichments` rows are only created when a Codex run is
  // queued or completed. A capture can also have user-typed tags
  // (`library:addTag`) without any AI run history — in that case we
  // still need to surface the tags. Returning `emptyEnrichment` here
  // would hide them.
  if (!row) {
    return CaptureEnrichmentSchema.parse({
      ...emptyEnrichment(captureId),
      acceptedTags: readAcceptedTags(captureId)
    });
  }

  return CaptureEnrichmentSchema.parse({
    captureId: row.capture_id,
    latestRunId: row.latest_ai_run_id,
    status: row.status,
    error: row.error,
    ocrText: row.ocr_text,
    suggestedTitle: row.suggested_title,
    acceptedTitle: row.accepted_title,
    titleAcceptedAt: row.title_accepted_at,
    suggestedDescription: row.suggested_description,
    acceptedDescription: row.accepted_description,
    descriptionAcceptedAt: row.description_accepted_at,
    suggestedFilenameStem: row.suggested_filename_stem,
    acceptedFilenameStem: row.accepted_filename_stem,
    filenameAcceptedAt: row.filename_accepted_at,
    suggestedTags: readTagSuggestions(captureId, row.latest_ai_run_id),
    acceptedTags: readAcceptedTags(captureId)
  });
}

export function getEnrichmentSummaries(captureIds: string[]): CaptureEnrichmentSummary[] {
  if (captureIds.length === 0) return [];
  return captureIds.map((captureId) => {
    const enrichment = getCaptureEnrichment(captureId);
    return {
      captureId,
      status: enrichment?.status ?? null,
      error: enrichment?.error ?? null,
      acceptedTitle: enrichment?.acceptedTitle ?? null,
      acceptedDescription: enrichment?.acceptedDescription ?? null,
      acceptedTags: enrichment?.acceptedTags ?? [],
      suggestedTagCount: enrichment?.suggestedTags.filter((tag) => tag.accepted_at === null && tag.rejected_at === null).length ?? 0
    };
  });
}

/**
 * Bulk fetch of full `CaptureEnrichment` rows by capture id. Returns
 * a `Map<captureId, enrichment-or-null>` keyed by EVERY input id —
 * missing ids map to `null` so callers can `.get(id) ?? null` without
 * a second lookup against the source array.
 *
 * Why this exists: the Sizzle Composer chat agent's
 * `library_get_metadata` tool and the Project Asset Cart's right-rail
 * display BOTH need enrichment-with-tags for an arbitrary capture
 * set. Doing it per-id via `getCaptureEnrichment` is 3N queries
 * (enrichment + tag suggestions + accepted tags). This is 3
 * regardless of N: one `WHERE capture_id IN (...)` per source table,
 * then a JS-side merge.
 *
 * Throws `RangeError` if `captureIds.length > 999` — SQLite's default
 * `SQLITE_LIMIT_VARIABLE_NUMBER` is 999 and we'd silently lose
 * trailing ids past that. The validator layer caps at 500 so this is
 * defense-in-depth.
 */
export function listEnrichmentsByCaptureIds(
  captureIds: readonly string[]
): Map<string, CaptureEnrichment | null> {
  const out = new Map<string, CaptureEnrichment | null>();
  if (captureIds.length === 0) return out;
  if (captureIds.length > 999) {
    throw new RangeError(
      `listEnrichmentsByCaptureIds: ${captureIds.length} ids exceeds SQLite parameter limit (999)`
    );
  }

  // Seed every requested id with null so callers see the full key set.
  // Captures that don't have an enrichment row AND have no user tags
  // stay at null; captures with either get filled in below.
  for (const id of captureIds) out.set(id, null);

  const db = getDb();
  const placeholders = captureIds.map(() => "?").join(", ");

  // 1) Enrichment rows — left-joined to ai_runs for the status column.
  const enrichRows = db
    .prepare(
      `SELECT capture_enrichments.capture_id,
              capture_enrichments.latest_ai_run_id,
              ai_runs.status,
              ai_runs.error,
              capture_enrichments.ocr_text,
              capture_enrichments.suggested_title,
              capture_enrichments.accepted_title,
              capture_enrichments.title_accepted_at,
              capture_enrichments.suggested_description,
              capture_enrichments.accepted_description,
              capture_enrichments.description_accepted_at,
              capture_enrichments.suggested_filename_stem,
              capture_enrichments.accepted_filename_stem,
              capture_enrichments.filename_accepted_at
         FROM capture_enrichments
         LEFT JOIN ai_runs ON ai_runs.id = capture_enrichments.latest_ai_run_id
        WHERE capture_enrichments.capture_id IN (${placeholders})`
    )
    .all(...captureIds) as EnrichmentRow[];

  // 2) Tag suggestions — bulk for any latest_ai_run_ids the enrichment
  //    rows carry. We need to know the captureId mapping so we group
  //    by `enrichment_tag_suggestions.capture_id` directly (not just
  //    by ai_run_id — multiple captures can share an ai_run_id under
  //    weird edge cases, and we want each capture's own suggestions).
  type TagSugRow = TagSuggestionRow & { capture_id: string };
  const tagSugRows = db
    .prepare(
      `SELECT id, capture_id, label, confidence, accepted_at, rejected_at
         FROM enrichment_tag_suggestions
        WHERE capture_id IN (${placeholders})
        ORDER BY accepted_at IS NOT NULL DESC, confidence DESC, created_at ASC`
    )
    .all(...captureIds) as TagSugRow[];

  // 3) Accepted tags — bulk. Same shape, ordered by created_at then label.
  type AcceptedRow = { capture_id: string; label: string };
  const acceptedRows = db
    .prepare(
      `SELECT capture_tags.capture_id, tags.label
         FROM capture_tags
         JOIN tags ON tags.id = capture_tags.tag_id
        WHERE capture_tags.capture_id IN (${placeholders})
        ORDER BY capture_tags.created_at ASC, tags.label ASC`
    )
    .all(...captureIds) as AcceptedRow[];

  // Index helpers — group tag rows by capture_id once so the merge
  // below is O(rows) instead of O(rows × captures).
  const tagSugByCapture = new Map<string, TagSugRow[]>();
  for (const row of tagSugRows) {
    let bucket = tagSugByCapture.get(row.capture_id);
    if (bucket === undefined) {
      bucket = [];
      tagSugByCapture.set(row.capture_id, bucket);
    }
    bucket.push(row);
  }
  const acceptedByCapture = new Map<string, string[]>();
  for (const row of acceptedRows) {
    let bucket = acceptedByCapture.get(row.capture_id);
    if (bucket === undefined) {
      bucket = [];
      acceptedByCapture.set(row.capture_id, bucket);
    }
    bucket.push(row.label);
  }

  // 4) Merge — build CaptureEnrichment per enrichment row.
  for (const row of enrichRows) {
    out.set(
      row.capture_id,
      CaptureEnrichmentSchema.parse({
        captureId: row.capture_id,
        latestRunId: row.latest_ai_run_id,
        status: row.status,
        error: row.error,
        ocrText: row.ocr_text,
        suggestedTitle: row.suggested_title,
        acceptedTitle: row.accepted_title,
        titleAcceptedAt: row.title_accepted_at,
        suggestedDescription: row.suggested_description,
        acceptedDescription: row.accepted_description,
        descriptionAcceptedAt: row.description_accepted_at,
        suggestedFilenameStem: row.suggested_filename_stem,
        acceptedFilenameStem: row.accepted_filename_stem,
        filenameAcceptedAt: row.filename_accepted_at,
        suggestedTags: tagSugByCapture.get(row.capture_id) ?? [],
        acceptedTags: acceptedByCapture.get(row.capture_id) ?? []
      })
    );
  }

  // 5) Captures that have user tags but NO enrichment row (parallels
  //    the same edge case `getCaptureEnrichment` handles). Without
  //    this, captures the user manually tagged would surface as null
  //    here even though they have surfaceable metadata.
  for (const [captureId, labels] of acceptedByCapture) {
    if (out.get(captureId) !== null) continue; // already filled by step 4
    out.set(
      captureId,
      CaptureEnrichmentSchema.parse({
        ...emptyEnrichment(captureId),
        acceptedTags: labels
      })
    );
  }

  return out;
}

export function setLatestEnrichmentRun(captureId: string, aiRunId: string): CaptureEnrichment {
  const db = getDb();
  db.prepare(
    `INSERT INTO capture_enrichments (
      capture_id, latest_ai_run_id, updated_at
    ) VALUES (
      @captureId, @aiRunId, datetime('now')
    )
    ON CONFLICT(capture_id) DO UPDATE SET
      latest_ai_run_id = excluded.latest_ai_run_id,
      updated_at = datetime('now')`
  ).run({ captureId, aiRunId });
  const enrichment = getCaptureEnrichment(captureId);
  if (enrichment === null) {
    throw new Error(`capture not found: ${captureId}`);
  }
  return enrichment;
}

export function storeCompletedEnrichment(params: {
  captureId: string;
  aiRunId: string;
  result: EnrichmentResult;
  /**
   * When true, the function also promotes the Codex draft into the
   * accepted fields immediately — title + description + the top 2
   * tag suggestions — so a user with auto-accept on doesn't need to
   * click "Use draft" before dismissing the float-over toast. Skipped
   * for any field that already has an accepted value so we don't
   * clobber user edits.
   *
   * Filename is intentionally different: suggested_filename_stem is
   * already the effective default while accepted_filename_stem is the
   * user's override. Auto-accept must not collapse that distinction.
   */
  autoAccept?: boolean;
}): CaptureEnrichment {
  const parsed = EnrichmentResultSchema.parse(params.result);
  const db = getDb();
  const tx = db.transaction((): void => {
    const capture = db
      .prepare("SELECT id FROM captures WHERE id = ? AND deleted_at IS NULL")
      .get(params.captureId) as { id: string } | undefined;
    if (!capture) {
      throw new Error(`capture not found or deleted: ${params.captureId}`);
    }

    const activeRun = db
      .prepare(
        `SELECT capture_enrichments.latest_ai_run_id, ai_runs.status
         FROM capture_enrichments
         LEFT JOIN ai_runs ON ai_runs.id = @aiRunId
         WHERE capture_enrichments.capture_id = @captureId`
      )
      .get({ captureId: params.captureId, aiRunId: params.aiRunId }) as
      | { latest_ai_run_id: string | null; status: string | null }
      | undefined;
    if (
      activeRun !== undefined &&
      (activeRun.latest_ai_run_id !== params.aiRunId ||
        activeRun.status === "cancelled" ||
        activeRun.status === "failed" ||
        activeRun.status === "completed")
    ) {
      return;
    }

    // Snapshot the user-accepted state BEFORE the suggested_*
    // INSERT/UPDATE below. The autoAccept path further down only
    // promotes a field when its accepted_* was null at this point.
    // Reading after the INSERT would be defensive against future
    // refactors that might touch accepted_* in the same statement
    // — easier to capture once here and pass through.
    const priorAccepted = db
      .prepare(
        `SELECT accepted_title, accepted_description, accepted_filename_stem
         FROM capture_enrichments
         WHERE capture_id = ?`
      )
      .get(params.captureId) as
      | {
          accepted_title: string | null;
          accepted_description: string | null;
          accepted_filename_stem: string | null;
        }
      | undefined;

    db.prepare(
      `INSERT INTO capture_enrichments (
        capture_id, latest_ai_run_id, ocr_text,
        suggested_title, suggested_description, suggested_filename_stem,
        updated_at
      ) VALUES (
        @captureId, @aiRunId, @ocrText,
        @suggestedTitle, @suggestedDescription, @suggestedFilenameStem,
        datetime('now')
      )
      ON CONFLICT(capture_id) DO UPDATE SET
        latest_ai_run_id = excluded.latest_ai_run_id,
        ocr_text = excluded.ocr_text,
        suggested_title = excluded.suggested_title,
        suggested_description = excluded.suggested_description,
        suggested_filename_stem = excluded.suggested_filename_stem,
        updated_at = datetime('now')`
    ).run({
      captureId: params.captureId,
      aiRunId: params.aiRunId,
      ocrText: parsed.ocrText,
      suggestedTitle: parsed.title || null,
      suggestedDescription: parsed.description || null,
      suggestedFilenameStem: (parsed.filenameStem ?? "").trim() || null
    });

    const insertTag = db.prepare(
      `INSERT OR IGNORE INTO enrichment_tag_suggestions (
        id, capture_id, ai_run_id, label, normalized_label, confidence
      ) VALUES (
        @id, @captureId, @aiRunId, @label, @normalizedLabel, @confidence
      )`
    );
    for (const tag of parsed.tags) {
      const normalizedLabel = normalizeTagLabel(tag.label);
      if (normalizedLabel.length === 0) continue;
      insertTag.run({
        id: nanoid(),
        captureId: params.captureId,
        aiRunId: params.aiRunId,
        label: tag.label.trim(),
        normalizedLabel,
        confidence: tag.confidence
      });
    }

    if (params.autoAccept === true) {
      // Promote suggested_* → accepted_* for fields whose accepted_*
      // was null BEFORE this turn ran (snapshot above). We never
      // overwrite an existing accepted_* — the user may have hit
      // "Use" (or typed something) before this enrichment landed,
      // and promoting Codex's suggestion over their value would be
      // a surprise.
      const titleValue = (parsed.title ?? "").trim();
      if (titleValue.length > 0 && (priorAccepted?.accepted_title ?? null) === null) {
        db.prepare(
          `UPDATE capture_enrichments
           SET accepted_title = @title,
               title_accepted_at = datetime('now'),
               updated_at = datetime('now')
           WHERE capture_id = @captureId`
        ).run({ captureId: params.captureId, title: titleValue });
      }

      const descriptionValue = (parsed.description ?? "").trim();
      if (
        descriptionValue.length > 0 &&
        (priorAccepted?.accepted_description ?? null) === null
      ) {
        db.prepare(
          `UPDATE capture_enrichments
           SET accepted_description = @description,
               description_accepted_at = datetime('now'),
               updated_at = datetime('now')
           WHERE capture_id = @captureId`
        ).run({ captureId: params.captureId, description: descriptionValue });
      }

      // Auto-accept the top 2 suggested tags inserted above. We can't
      // call `acceptSuggestedTag` from inside the same transaction
      // (better-sqlite3 doesn't allow re-entrant transactions), so
      // inline the same writes: ensure a `tags` row, link via
      // `capture_tags`, mark the suggestion accepted.
      const topSuggestions = db
        .prepare(
          `SELECT id, label, normalized_label
           FROM enrichment_tag_suggestions
           WHERE capture_id = ?
             AND ai_run_id = ?
             AND accepted_at IS NULL
             AND rejected_at IS NULL
           ORDER BY confidence DESC, created_at ASC
           LIMIT 2`
        )
        .all(params.captureId, params.aiRunId) as Array<{
        id: string;
        label: string;
        normalized_label: string;
      }>;
      for (const suggestion of topSuggestions) {
        const existing = db
          .prepare("SELECT id FROM tags WHERE kind = 'content' AND normalized_label = ?")
          .get(suggestion.normalized_label) as { id: string } | undefined;
        const tagRowId = existing?.id ?? nanoid();
        if (!existing) {
          db.prepare(
            `INSERT INTO tags (id, label, normalized_label, kind)
             VALUES (?, ?, ?, 'content')`
          ).run(tagRowId, suggestion.label, suggestion.normalized_label);
        }
        db.prepare(
          `INSERT OR IGNORE INTO capture_tags (capture_id, tag_id, source, ai_run_id)
           VALUES (?, ?, 'codex', ?)`
        ).run(params.captureId, tagRowId, params.aiRunId);
        db.prepare(
          `UPDATE enrichment_tag_suggestions
           SET accepted_at = COALESCE(accepted_at, datetime('now'))
           WHERE id = ?`
        ).run(suggestion.id);
      }
    }
  });
  tx();
  const enrichment = getCaptureEnrichment(params.captureId);
  if (enrichment === null) {
    throw new Error(`capture not found after enrichment write: ${params.captureId}`);
  }
  return enrichment;
}

export function acceptDescription(captureId: string, description: string): CaptureEnrichment {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new Error("description must not be empty");
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO capture_enrichments (
      capture_id, accepted_description, description_accepted_at, updated_at
    ) VALUES (
      @captureId, @description, datetime('now'), datetime('now')
    )
    ON CONFLICT(capture_id) DO UPDATE SET
      accepted_description = excluded.accepted_description,
      description_accepted_at = excluded.description_accepted_at,
      updated_at = datetime('now')`
  ).run({ captureId, description: trimmed });
  const enrichment = getCaptureEnrichment(captureId);
  if (enrichment === null) throw new Error(`capture not found: ${captureId}`);
  return enrichment;
}

export function acceptTitle(captureId: string, title: string): CaptureEnrichment {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new Error("title must not be empty");
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO capture_enrichments (
      capture_id, accepted_title, title_accepted_at, updated_at
    ) VALUES (
      @captureId, @title, datetime('now'), datetime('now')
    )
    ON CONFLICT(capture_id) DO UPDATE SET
      accepted_title = excluded.accepted_title,
      title_accepted_at = excluded.title_accepted_at,
      updated_at = datetime('now')`
  ).run({ captureId, title: trimmed });
  const enrichment = getCaptureEnrichment(captureId);
  if (enrichment === null) throw new Error(`capture not found: ${captureId}`);
  return enrichment;
}

export function acceptFilenameStem(captureId: string, filenameStem: string): CaptureEnrichment {
  const trimmed = filenameStem.trim();
  if (trimmed.length === 0) {
    throw new Error("filename stem must not be empty");
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO capture_enrichments (
      capture_id, accepted_filename_stem, filename_accepted_at, updated_at
    ) VALUES (
      @captureId, @filenameStem, datetime('now'), datetime('now')
    )
    ON CONFLICT(capture_id) DO UPDATE SET
      accepted_filename_stem = excluded.accepted_filename_stem,
      filename_accepted_at = excluded.filename_accepted_at,
      updated_at = datetime('now')`
  ).run({ captureId, filenameStem: trimmed });
  const enrichment = getCaptureEnrichment(captureId);
  if (enrichment === null) throw new Error(`capture not found: ${captureId}`);
  return enrichment;
}

/**
 * Atomic bulk accept — any subset of {title, description,
 * filenameStem} is written in a single transaction with a single
 * `updated_at` timestamp. The sidebar's prominent "Use draft" button
 * uses this so users don't see partial-accept states (e.g., title
 * lands but description fails). Empty / whitespace-only values for
 * any field are skipped.
 *
 * No-op fields are silently ignored — passing all-undefined is fine
 * and returns the current enrichment unchanged.
 */
export function acceptAllDrafts(input: {
  captureId: string;
  title?: string | undefined;
  description?: string | undefined;
  filenameStem?: string | undefined;
}): CaptureEnrichment {
  const title = (input.title ?? "").trim();
  const description = (input.description ?? "").trim();
  const filenameStem = (input.filenameStem ?? "").trim();

  const db = getDb();
  const tx = db.transaction((): void => {
    // Ensure the row exists. Cheaper to do one INSERT OR IGNORE up
    // front than to write three separate INSERT ON CONFLICT statements.
    db.prepare(
      `INSERT OR IGNORE INTO capture_enrichments (capture_id, updated_at)
       VALUES (?, datetime('now'))`
    ).run(input.captureId);

    if (title.length > 0) {
      db.prepare(
        `UPDATE capture_enrichments
         SET accepted_title = @title,
             title_accepted_at = datetime('now'),
             updated_at = datetime('now')
         WHERE capture_id = @captureId`
      ).run({ captureId: input.captureId, title });
    }
    if (description.length > 0) {
      db.prepare(
        `UPDATE capture_enrichments
         SET accepted_description = @description,
             description_accepted_at = datetime('now'),
             updated_at = datetime('now')
         WHERE capture_id = @captureId`
      ).run({ captureId: input.captureId, description });
    }
    if (filenameStem.length > 0) {
      db.prepare(
        `UPDATE capture_enrichments
         SET accepted_filename_stem = @filenameStem,
             filename_accepted_at = datetime('now'),
             updated_at = datetime('now')
         WHERE capture_id = @captureId`
      ).run({ captureId: input.captureId, filenameStem });
    }
  });
  tx();
  const enrichment = getCaptureEnrichment(input.captureId);
  if (enrichment === null) throw new Error(`capture not found: ${input.captureId}`);
  return enrichment;
}

export function acceptSuggestedTag(captureId: string, tagId: string): CaptureEnrichment {
  const db = getDb();
  const tx = db.transaction(() => {
    const suggestion = db
      .prepare(
        `SELECT id, ai_run_id, label, normalized_label
         FROM enrichment_tag_suggestions
         WHERE id = ?
           AND capture_id = ?
           AND rejected_at IS NULL
           AND ai_run_id = (
             SELECT latest_ai_run_id
             FROM capture_enrichments
             WHERE capture_id = ?
           )`
      )
      .get(tagId, captureId, captureId) as
      | { id: string; ai_run_id: string; label: string; normalized_label: string }
      | undefined;
    if (!suggestion) throw new Error(`tag suggestion not found: ${tagId}`);

    const existingTag = db
      .prepare("SELECT id FROM tags WHERE kind = 'content' AND normalized_label = ?")
      .get(suggestion.normalized_label) as { id: string } | undefined;
    const tagRowId = existingTag?.id ?? nanoid();
    if (!existingTag) {
      db.prepare(
        `INSERT INTO tags (id, label, normalized_label, kind)
         VALUES (?, ?, ?, 'content')`
      ).run(tagRowId, suggestion.label, suggestion.normalized_label);
    }

    db.prepare(
      `INSERT OR IGNORE INTO capture_tags (capture_id, tag_id, source, ai_run_id)
       VALUES (?, ?, 'codex', ?)`
    ).run(captureId, tagRowId, suggestion.ai_run_id);

    db.prepare(
      `UPDATE enrichment_tag_suggestions
       SET accepted_at = COALESCE(accepted_at, datetime('now'))
       WHERE id = ?`
    ).run(tagId);
  });
  tx();
  const enrichment = getCaptureEnrichment(captureId);
  if (enrichment === null) throw new Error(`capture not found: ${captureId}`);
  return enrichment;
}

/**
 * Add a user-typed tag to a capture. Normalizes the label, reuses an
 * existing `tags` row when one matches, and inserts a `capture_tags`
 * row with `source = 'user'`. Idempotent — re-adding the same tag is
 * a no-op (the `(capture_id, tag_id)` primary key prevents duplicates).
 *
 * Returns the refreshed enrichment so the renderer can re-render with
 * the new accepted-tag chip without a follow-up fetch.
 */
export function addUserTag(captureId: string, label: string): CaptureEnrichment {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    throw new Error("tag label must not be empty");
  }
  const normalized = normalizeTagLabel(trimmed);
  if (normalized.length === 0) {
    throw new Error("tag label must contain at least one non-whitespace character");
  }
  const db = getDb();
  const tx = db.transaction(() => {
    const capture = db
      .prepare("SELECT id FROM captures WHERE id = ? AND deleted_at IS NULL")
      .get(captureId) as { id: string } | undefined;
    if (!capture) {
      throw new Error(`capture not found or deleted: ${captureId}`);
    }
    const existing = db
      .prepare("SELECT id FROM tags WHERE kind = 'content' AND normalized_label = ?")
      .get(normalized) as { id: string } | undefined;
    const tagId = existing?.id ?? nanoid();
    if (!existing) {
      db.prepare(
        `INSERT INTO tags (id, label, normalized_label, kind)
         VALUES (?, ?, ?, 'content')`
      ).run(tagId, trimmed, normalized);
    }
    db.prepare(
      `INSERT OR IGNORE INTO capture_tags (capture_id, tag_id, source, ai_run_id)
       VALUES (?, ?, 'user', NULL)`
    ).run(captureId, tagId);
  });
  tx();
  const enrichment = getCaptureEnrichment(captureId);
  if (enrichment === null) throw new Error(`capture not found: ${captureId}`);
  return enrichment;
}

/**
 * Remove a tag from a capture by label. Looks up the `tags` row by
 * normalized label and deletes the matching `capture_tags` join row.
 * Idempotent — removing a label the capture doesn't carry is a no-op.
 * The `tags` row itself is left intact so the label remains in the
 * user's taxonomy for future captures (and for Codex's bias hint).
 *
 * Doesn't touch `enrichment_tag_suggestions`. Codex suggestion
 * state lives per-run; rejecting a suggestion that was already
 * accepted-then-removed would only matter if Codex re-suggested the
 * same label in the SAME run, which doesn't happen — every enrich
 * dispatch creates a fresh run with its own suggestion rows. Tag
 * suggestion rejection stays a separate user gesture
 * (`codex:rejectTag`) on the pending chips.
 */
export function removeTag(captureId: string, label: string): CaptureEnrichment {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    throw new Error("tag label must not be empty");
  }
  const normalized = normalizeTagLabel(trimmed);
  const db = getDb();
  const tx = db.transaction(() => {
    const capture = db
      .prepare("SELECT id FROM captures WHERE id = ?")
      .get(captureId) as { id: string } | undefined;
    if (!capture) {
      throw new Error(`capture not found: ${captureId}`);
    }
    const tagRow = db
      .prepare("SELECT id FROM tags WHERE kind = 'content' AND normalized_label = ?")
      .get(normalized) as { id: string } | undefined;
    if (tagRow === undefined) return;

    db.prepare(
      `DELETE FROM capture_tags
       WHERE capture_id = ? AND tag_id = ?`
    ).run(captureId, tagRow.id);
  });
  tx();
  const enrichment = getCaptureEnrichment(captureId);
  if (enrichment === null) throw new Error(`capture not found: ${captureId}`);
  return enrichment;
}

/**
 * Read the user's most-used content tags, ranked by capture count. The
 * Codex enrichment prompt receives these as a "prefer these labels when
 * meaning is close" bias hint, which keeps the tag taxonomy from
 * fragmenting (e.g., "deploy" / "deploys" / "deployment" all becoming
 * separate facets).
 *
 * Limited to `kind = 'content'` so app-tags (which are populated from
 * `source_app_name` and aren't user-curated) don't leak into the hint.
 * Empty result is fine and just means the user hasn't tagged anything
 * yet — the prompt builder skips the hint line in that case.
 */
export function getTopUserTags(limit: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT tags.label, COUNT(*) AS usage_count
       FROM capture_tags
       JOIN tags ON tags.id = capture_tags.tag_id
       WHERE tags.kind = 'content'
       GROUP BY tags.id
       ORDER BY usage_count DESC, tags.label ASC
       LIMIT ?`
    )
    .all(limit) as Array<{ label: string; usage_count: number }>;
  return rows.map((row) => row.label);
}

export function rejectSuggestedTag(captureId: string, tagId: string): CaptureEnrichment {
  const db = getDb();
  db.prepare(
    `UPDATE enrichment_tag_suggestions
     SET rejected_at = COALESCE(rejected_at, datetime('now'))
     WHERE id = ? AND capture_id = ?`
  ).run(tagId, captureId);
  const enrichment = getCaptureEnrichment(captureId);
  if (enrichment === null) throw new Error(`capture not found: ${captureId}`);
  return enrichment;
}
