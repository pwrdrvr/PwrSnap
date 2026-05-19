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

export const EnrichmentResultSchema = z.object({
  ocrText: z.string().max(100_000).default(""),
  title: z.string().trim().max(120).default(""),
  description: z.string().trim().max(2_000).default(""),
  filenameStem: z.string().trim().max(120).optional(),
  textAnchors: z.array(z.string().trim().min(1).max(120)).max(5).optional(),
  tags: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(64),
        confidence: z.number().min(0).max(1).nullable().default(null)
      })
    )
    .max(12)
    .default([])
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
