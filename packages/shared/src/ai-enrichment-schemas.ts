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

export function normalizeTagLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}
