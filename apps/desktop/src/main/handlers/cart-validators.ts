// Per-verb validators for the `cart:*` command surface. Same shape as
// the other handler-validator modules — pure functions returning a
// discriminated `{ ok: true, … } | { ok: false, error }`. The bus
// boundary is the trust boundary; persistence-layer code assumes
// validated input.

import type { PwrSnapError } from "@pwrsnap/shared";

function validationError(code: string, message: string): PwrSnapError {
  return { kind: "validation", code, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** `cart:toggle` / `cart:remove` — `{ captureId: string }`. */
export function validateCartCaptureId(
  req: unknown
): { ok: true; captureId: string } | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (typeof req.captureId !== "string" || req.captureId.length === 0) {
    return {
      ok: false,
      error: validationError("captureId_required", "captureId must be a non-empty string")
    };
  }
  return { ok: true, captureId: req.captureId };
}

/** `cart:reorder` — `{ from: number; to: number }`. Both must be
 *  non-negative integers; the store clamps `to` and no-ops an
 *  out-of-range `from`, but we still reject obviously-bad input
 *  (negatives, non-integers, NaN) at the boundary. */
export function validateCartReorder(
  req: unknown
): { ok: true; from: number; to: number } | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  for (const key of ["from", "to"] as const) {
    const v = req[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return {
        ok: false,
        error: validationError(
          `${key}_invalid`,
          `${key} must be a non-negative integer`
        )
      };
    }
  }
  return { ok: true, from: req.from as number, to: req.to as number };
}

/** `cart:rename` — `{ name: string }`. Empty / whitespace names are
 *  accepted at the boundary (the store collapses them to the default
 *  label); we only reject the wrong TYPE here. */
export function validateCartRename(
  req: unknown
): { ok: true; name: string } | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (typeof req.name !== "string") {
    return {
      ok: false,
      error: validationError("name_invalid", "name must be a string")
    };
  }
  // Cap length so a runaway rename can't bloat the JSON file. 200
  // matches the sizzle project-name cap.
  if (req.name.length > 200) {
    return {
      ok: false,
      error: validationError("name_too_long", "name must be ≤ 200 characters")
    };
  }
  return { ok: true, name: req.name };
}

/** `cart:commitToNewProject` — `{ name?: string }`. Name optional. */
export function validateCartCommitToNew(
  req: unknown
): { ok: true; name: string | undefined } | { ok: false; error: PwrSnapError } {
  if (req === null || req === undefined) return { ok: true, name: undefined };
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (req.name === undefined || req.name === null) return { ok: true, name: undefined };
  if (typeof req.name !== "string") {
    return {
      ok: false,
      error: validationError("name_invalid", "name must be a string when provided")
    };
  }
  if (req.name.length > 200) {
    return {
      ok: false,
      error: validationError("name_too_long", "name must be ≤ 200 characters")
    };
  }
  return { ok: true, name: req.name };
}

const MAX_EXPORT_IDS = 1000;

/** `cart:exportZip` — `{ captureIds; preset; suggestedName?; jobId }`.
 *  Dedupes ids and caps cardinality so a runaway cart can't fan out into
 *  thousands of renders + a giant zip (disk-fill / OOM at the boundary).
 *  `jobId` correlates progress broadcasts + the cancel verb. */
export function validateCartExportZip(
  req: unknown
):
  | {
      ok: true;
      captureIds: string[];
      preset: "low" | "med" | "high";
      suggestedName: string | undefined;
      jobId: string;
    }
  | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (!Array.isArray(req.captureIds) || req.captureIds.length === 0) {
    return {
      ok: false,
      error: validationError("captureIds_required", "captureIds must be a non-empty array")
    };
  }
  if (req.captureIds.length > MAX_EXPORT_IDS) {
    return {
      ok: false,
      error: validationError(
        "too_many",
        `cannot export more than ${MAX_EXPORT_IDS} captures at once`
      )
    };
  }
  const captureIds: string[] = [];
  const seen = new Set<string>();
  for (const id of req.captureIds) {
    if (typeof id !== "string" || id.length === 0) {
      return {
        ok: false,
        error: validationError(
          "captureId_invalid",
          "every captureId must be a non-empty string"
        )
      };
    }
    if (!seen.has(id)) {
      seen.add(id);
      captureIds.push(id);
    }
  }
  if (req.preset !== "low" && req.preset !== "med" && req.preset !== "high") {
    return {
      ok: false,
      error: validationError("preset_invalid", "preset must be one of low | med | high")
    };
  }
  let suggestedName: string | undefined;
  if (req.suggestedName !== undefined && req.suggestedName !== null) {
    if (typeof req.suggestedName !== "string") {
      return {
        ok: false,
        error: validationError("suggestedName_invalid", "suggestedName must be a string")
      };
    }
    suggestedName = req.suggestedName.slice(0, 200);
  }
  if (typeof req.jobId !== "string" || req.jobId.length === 0 || req.jobId.length > 128) {
    return {
      ok: false,
      error: validationError("jobId_invalid", "jobId must be a 1–128 character string")
    };
  }
  return { ok: true, captureIds, preset: req.preset, suggestedName, jobId: req.jobId };
}

/** `cart:exportZip:cancel` — `{ jobId: string }`. */
export function validateCartExportZipCancel(
  req: unknown
): { ok: true; jobId: string } | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (typeof req.jobId !== "string" || req.jobId.length === 0 || req.jobId.length > 128) {
    return {
      ok: false,
      error: validationError("jobId_invalid", "jobId must be a 1–128 character string")
    };
  }
  return { ok: true, jobId: req.jobId };
}

/** `cart:commitToExisting` — `{ projectId: string }`. */
export function validateCartCommitToExisting(
  req: unknown
): { ok: true; projectId: string } | { ok: false; error: PwrSnapError } {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  if (typeof req.projectId !== "string" || req.projectId.length === 0) {
    return {
      ok: false,
      error: validationError("projectId_required", "projectId must be a non-empty string")
    };
  }
  return { ok: true, projectId: req.projectId };
}
