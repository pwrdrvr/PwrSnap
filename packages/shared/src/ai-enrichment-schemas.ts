import { z } from "zod";

export const AiRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

export type AiRunStatus = z.infer<typeof AiRunStatusSchema>;

export const SuggestedTagSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().trim().min(1).max(64),
  confidence: z.number().min(0).max(1).nullable().default(null),
  accepted_at: z.string().nullable().default(null),
  rejected_at: z.string().nullable().default(null)
});

export type SuggestedTag = z.infer<typeof SuggestedTagSchema>;

export const CaptureEnrichmentSchema = z.object({
  captureId: z.string().min(1),
  latestRunId: z.string().nullable(),
  status: AiRunStatusSchema.nullable(),
  ocrText: z.string().max(100_000).nullable(),
  suggestedTitle: z.string().max(120).nullable(),
  acceptedTitle: z.string().max(120).nullable(),
  titleAcceptedAt: z.string().nullable(),
  suggestedDescription: z.string().max(2_000).nullable(),
  acceptedDescription: z.string().max(2_000).nullable(),
  descriptionAcceptedAt: z.string().nullable(),
  suggestedFilenameStem: z.string().max(120).nullable(),
  acceptedFilenameStem: z.string().max(120).nullable(),
  filenameAcceptedAt: z.string().nullable(),
  suggestedTags: z.array(SuggestedTagSchema),
  acceptedTags: z.array(z.string().trim().min(1).max(64))
});

export type CaptureEnrichment = z.infer<typeof CaptureEnrichmentSchema>;

/** Coerce a possibly-string-or-number scalar to a trimmed, length-capped string.
 *  Weak ACP models (Grok/Kimi/Qwen) over-produce: a 130-char title or a number
 *  where a string was asked for should CLAMP, not reject the whole enrichment —
 *  the caption/description/OCR are the valuable part and must survive a minor
 *  overflow in one field. Non-coercible values (objects/arrays) pass through so
 *  the base string schema still rejects genuine type errors. */
function clampString(value: unknown, max: number): unknown {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, max);
  return value;
}

/** Coerce a raw value into ≤`limit` clean, length-capped strings: accepts a
 *  single string (wrapped), drops non-strings/blanks, clips each item, and
 *  truncates the list. A model that returns 8 text anchors or one stray empty
 *  shouldn't sink the run — clamp to the contract instead of rejecting. */
function clampStringArray(value: unknown, limit: number, itemMax: number): unknown {
  if (value === undefined || value === null) return value;
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => item.slice(0, itemMax))
    .slice(0, limit);
}

/** Coerce a raw tags value into ≤`limit` `{label, confidence}` objects. Accepts
 *  bare-string tags (`["crash","macos"]` → labels with null confidence) and
 *  object tags; drops blanks/unusable entries, clips labels, and nulls
 *  out-of-range confidences. Over-count clamps rather than rejects. */
function clampTags(value: unknown, limit: number): unknown {
  if (!Array.isArray(value)) return value;
  const out: Array<{ label: string; confidence: number | null }> = [];
  for (const item of value) {
    let label: string | undefined;
    let confidence: number | null = null;
    if (typeof item === "string") {
      label = item;
    } else if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (typeof record.label === "string") label = record.label;
      if (typeof record.confidence === "number" && Number.isFinite(record.confidence)) {
        confidence = record.confidence >= 0 && record.confidence <= 1 ? record.confidence : null;
      }
    }
    if (label === undefined) continue;
    const clean = label.trim().slice(0, 64);
    if (clean.length === 0) continue;
    out.push({ label: clean, confidence });
    if (out.length >= limit) break;
  }
  return out;
}

export const EnrichmentResultSchema = z.object({
  ocrText: z.preprocess((v) => clampString(v, 100_000), z.string().max(100_000).default("")),
  title: z.preprocess((v) => clampString(v, 120), z.string().max(120).default("")),
  description: z.preprocess((v) => clampString(v, 2_000), z.string().max(2_000).default("")),
  filenameStem: z.preprocess((v) => clampString(v, 120), z.string().max(120).optional()),
  // Sanity bounds only — NOT style enforcement. Anchors are unconsumed prompt
  // scaffolding; the cap exists to reject a model dumping garbage (megabytes
  // into one string, thousands of items), not to nitpick "5 vs 6". Generous
  // limits mean the clamp practically never fires on real replies.
  textAnchors: z.preprocess(
    (v) => clampStringArray(v, 100, 1_000),
    z.array(z.string().min(1).max(1_000)).max(100).optional()
  ),
  tags: z.preprocess(
    (v) => clampTags(v, 4),
    z
      .array(
        z.object({
          label: z.string().trim().min(1).max(64),
          confidence: z.number().min(0).max(1).nullable().default(null)
        })
      )
      .max(4)
      .default([])
  )
});

export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>;

export const AcceptDescriptionRequestSchema = z.object({
  captureId: z.string().min(1),
  description: z.string().trim().min(1).max(2_000)
});

export const AcceptTitleRequestSchema = z.object({
  captureId: z.string().min(1),
  title: z.string().trim().min(1).max(120)
});

/**
 * Slugify a free-form string into a filename-safe stem:
 *   - lowercase
 *   - whitespace and non-alphanumeric runs collapsed to a single `-`
 *   - leading + trailing `-` stripped
 *   - empty result returns `""` (caller decides what to do with that)
 *
 * Exported so callers (renderer + main) can preview the sanitized
 * form, e.g., "My Awesome File!" → "my-awesome-file". The accept
 * verb runs this on the way in so anything that lands in the DB is
 * safe to feed into the OS file save dialog or a CLI path.
 */
export function slugifyFilenameStem(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const AcceptFilenameStemRequestSchema = z
  .object({
    captureId: z.string().min(1),
    // Accept up to 200 chars of free-form input — we slugify it down
    // before persistence. 120 is the storage cap; the input cap is
    // larger to give the slugifier room to drop punctuation /
    // duplicated separators without rejecting valid intent.
    filenameStem: z.string().trim().min(1).max(200)
  })
  .transform((value) => ({
    captureId: value.captureId,
    filenameStem: slugifyFilenameStem(value.filenameStem)
  }))
  .refine((value) => value.filenameStem.length > 0, {
    message: "filename stem must contain at least one alphanumeric character"
  })
  .refine((value) => value.filenameStem.length <= 120, {
    message: "filename stem exceeds 120 characters after normalization"
  });

/**
 * Bulk-accept request: any subset of {title, description, filenameStem}
 * applied in a single transaction. Used by the sidebar's "Use draft"
 * button so the user takes Codex's full text suggestion in one
 * round-trip instead of three sequential dispatches. Omitted fields
 * are left alone.
 */
export const AcceptAllDraftsRequestSchema = z
  .object({
    captureId: z.string().min(1),
    title: z.string().trim().max(120).optional(),
    description: z.string().trim().max(2_000).optional(),
    // Same slugify pass as AcceptFilenameStemRequestSchema. Input cap
    // wider than the storage cap so free-form punctuation can collapse
    // without rejection.
    filenameStem: z.string().trim().max(200).optional()
  })
  .transform((value) => ({
    captureId: value.captureId,
    title: value.title,
    description: value.description,
    filenameStem:
      value.filenameStem === undefined ? undefined : slugifyFilenameStem(value.filenameStem)
  }));

export const AcceptTagRequestSchema = z.object({
  captureId: z.string().min(1),
  tagId: z.string().min(1)
});

export const RejectTagRequestSchema = z.object({
  captureId: z.string().min(1),
  tagId: z.string().min(1)
});

export const AddUserTagRequestSchema = z.object({
  captureId: z.string().min(1),
  label: z.string().trim().min(1).max(64)
});

/**
 * Shape-identical to AddUserTagRequestSchema but exported under its
 * own name so handler / call-site code reads symmetrically with the
 * `library:removeTag` verb. Both verbs validate the same payload.
 */
export const RemoveUserTagRequestSchema = AddUserTagRequestSchema;

export function normalizeTagLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}
