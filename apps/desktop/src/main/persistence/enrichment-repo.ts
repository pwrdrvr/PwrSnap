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
  ocr_text: string | null;
  suggested_title: string | null;
  accepted_title: string | null;
  title_accepted_at: string | null;
  suggested_description: string | null;
  accepted_description: string | null;
  description_accepted_at: string | null;
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
    ocrText: null,
    suggestedTitle: null,
    acceptedTitle: null,
    titleAcceptedAt: null,
    suggestedDescription: null,
    acceptedDescription: null,
    descriptionAcceptedAt: null,
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
              capture_enrichments.ocr_text,
              capture_enrichments.suggested_title,
              capture_enrichments.accepted_title,
              capture_enrichments.title_accepted_at,
              capture_enrichments.suggested_description,
              capture_enrichments.accepted_description,
              capture_enrichments.description_accepted_at
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
    ocrText: row.ocr_text,
    suggestedTitle: row.suggested_title,
    acceptedTitle: row.accepted_title,
    titleAcceptedAt: row.title_accepted_at,
    suggestedDescription: row.suggested_description,
    acceptedDescription: row.accepted_description,
    descriptionAcceptedAt: row.description_accepted_at,
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
      acceptedTitle: enrichment?.acceptedTitle ?? null,
      acceptedDescription: enrichment?.acceptedDescription ?? null,
      acceptedTags: enrichment?.acceptedTags ?? [],
      suggestedTagCount: enrichment?.suggestedTags.filter((tag) => tag.accepted_at === null && tag.rejected_at === null).length ?? 0
    };
  });
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

    db.prepare(
      `INSERT INTO capture_enrichments (
        capture_id, latest_ai_run_id, ocr_text, suggested_title, suggested_description, updated_at
      ) VALUES (
        @captureId, @aiRunId, @ocrText, @suggestedTitle, @suggestedDescription, datetime('now')
      )
      ON CONFLICT(capture_id) DO UPDATE SET
        latest_ai_run_id = excluded.latest_ai_run_id,
        ocr_text = excluded.ocr_text,
        suggested_title = excluded.suggested_title,
        suggested_description = excluded.suggested_description,
        updated_at = datetime('now')`
    ).run({
      captureId: params.captureId,
      aiRunId: params.aiRunId,
      ocrText: parsed.ocrText,
      suggestedTitle: parsed.title || null,
      suggestedDescription: parsed.description || null
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
      // Read what the row looks like AFTER the insert above. We never
      // overwrite an existing accepted_* — the user may have hit "Use"
      // (or typed something) before this enrichment landed, and
      // promoting Codex's suggestion over their value would be a
      // surprise.
      const post = db
        .prepare(
          `SELECT accepted_title, accepted_description
           FROM capture_enrichments
           WHERE capture_id = ?`
        )
        .get(params.captureId) as
        | { accepted_title: string | null; accepted_description: string | null }
        | undefined;

      const titleValue = (parsed.title ?? "").trim();
      if (titleValue.length > 0 && (post?.accepted_title ?? null) === null) {
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
        (post?.accepted_description ?? null) === null
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
