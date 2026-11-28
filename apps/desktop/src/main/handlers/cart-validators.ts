// Per-verb validators for the `cart:*` command surface. Same shape as
// the other handler-validator modules — pure functions returning a
// discriminated `{ ok: true, … } | { ok: false, error }`. The bus
// boundary is the trust boundary; persistence-layer code assumes
// validated input.

import {
  CONTACT_SHEET_BACKGROUNDS,
  CONTACT_SHEET_SIZES,
  CONTACT_SHEET_SPACINGS,
  isContactSheetColumns,
  type ContactSheetLayout,
  type ContactSheetSize,
  type PwrSnapError,
  type RenderPreset
} from "@pwrsnap/shared";

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

/** `cart:prepareZipDrag` — `{ captureIds; preset; suggestedName? }`. Same
 *  shape as the export minus `jobId` (a drag has no progress/cancel UI).
 *  Reuses the export validator and drops the jobId requirement. */
export function validateCartPrepareZipDrag(
  req: unknown
):
  | {
      ok: true;
      captureIds: string[];
      preset: "low" | "med" | "high";
      suggestedName: string | undefined;
    }
  | { ok: false; error: PwrSnapError } {
  // Borrow the export validator with a synthetic jobId so the shared
  // captureIds/preset/suggestedName checks run, then strip jobId off.
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  const v = validateCartExportZip({ ...req, jobId: "drag" });
  if (!v.ok) return v;
  return {
    ok: true,
    captureIds: v.captureIds,
    preset: v.preset,
    suggestedName: v.suggestedName
  };
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

/** Copy all puts every image on the clipboard eagerly (PNG bytes per item on
 *  macOS), so it is capped well below the Zip. */
export const MAX_COPY_ALL_IDS = 100;
/** Past this, contact sheet tiles are too small to read. */
export const MAX_CONTACT_SHEET_IDS = 200;

type Invalid = { ok: false; error: PwrSnapError };

/** Shared `captureIds` rule: non-empty strings, deduped in first-seen order,
 *  at most `max` distinct ids. */
function parseCaptureIds(value: unknown, max: number): { ok: true; captureIds: string[] } | Invalid {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      error: validationError("captureIds_required", "captureIds must be a non-empty array")
    };
  }
  const captureIds: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0) {
      return {
        ok: false,
        error: validationError("captureId_invalid", "every captureId must be a non-empty string")
      };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    captureIds.push(id);
  }
  if (captureIds.length > max) {
    return {
      ok: false,
      error: validationError("too_many", `cannot export more than ${max} captures at once`)
    };
  }
  return { ok: true, captureIds };
}

function parsePreset(value: unknown): { ok: true; preset: RenderPreset } | Invalid {
  if (value !== "low" && value !== "med" && value !== "high") {
    return { ok: false, error: validationError("preset_invalid", "preset must be one of low | med | high") };
  }
  return { ok: true, preset: value };
}

function parseJobId(value: unknown): { ok: true; jobId: string } | Invalid {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return { ok: false, error: validationError("jobId_invalid", "jobId must be a 1–128 character string") };
  }
  return { ok: true, jobId: value };
}

function parseSuggestedName(value: unknown): { ok: true; suggestedName: string | undefined } | Invalid {
  if (value === undefined || value === null) return { ok: true, suggestedName: undefined };
  if (typeof value !== "string") {
    return { ok: false, error: validationError("suggestedName_invalid", "suggestedName must be a string") };
  }
  return { ok: true, suggestedName: value.slice(0, 200) };
}

function parseSheetSize(value: unknown): { ok: true; size: ContactSheetSize } | Invalid {
  if (!(CONTACT_SHEET_SIZES as readonly unknown[]).includes(value)) {
    return { ok: false, error: validationError("size_invalid", "size must be one of s | m | l") };
  }
  return { ok: true, size: value as ContactSheetSize };
}

function parseSheetLayout(value: unknown): { ok: true; layout: ContactSheetLayout } | Invalid {
  if (!isRecord(value)) {
    return { ok: false, error: validationError("layout_invalid", "layout must be an object") };
  }
  if (!isContactSheetColumns(value.columns)) {
    return { ok: false, error: validationError("columns_invalid", "columns must be \"auto\" or 1–8") };
  }
  if (!(CONTACT_SHEET_SPACINGS as readonly unknown[]).includes(value.spacing)) {
    return { ok: false, error: validationError("spacing_invalid", "spacing must be none | tight | roomy") };
  }
  if (!(CONTACT_SHEET_BACKGROUNDS as readonly unknown[]).includes(value.background)) {
    return {
      ok: false,
      error: validationError("background_invalid", "background must be clear | hatch | black | white")
    };
  }
  return {
    ok: true,
    layout: {
      columns: value.columns,
      spacing: value.spacing as ContactSheetLayout["spacing"],
      background: value.background as ContactSheetLayout["background"]
    }
  };
}

/** `cart:copyAll` — `{ captureIds; preset; jobId }`. */
export function validateCartCopyAll(
  req: unknown
): { ok: true; captureIds: string[]; preset: RenderPreset; jobId: string } | Invalid {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  const ids = parseCaptureIds(req.captureIds, MAX_COPY_ALL_IDS);
  if (!ids.ok) return ids;
  const preset = parsePreset(req.preset);
  if (!preset.ok) return preset;
  const job = parseJobId(req.jobId);
  if (!job.ok) return job;
  return { ok: true, captureIds: ids.captureIds, preset: preset.preset, jobId: job.jobId };
}

/** `cart:prepareFilesDrag` — `{ captureIds; preset }`. */
export function validateCartPrepareFilesDrag(
  req: unknown
): { ok: true; captureIds: string[]; preset: RenderPreset } | Invalid {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  const v = validateCartCopyAll({ ...req, jobId: "drag" });
  if (!v.ok) return v;
  return { ok: true, captureIds: v.captureIds, preset: v.preset };
}

export type ValidContactSheetRequest = {
  captureIds: string[];
  size: ContactSheetSize;
  layout: ContactSheetLayout;
  suggestedName: string | undefined;
};

/** `cart:prepareSheetDrag` — `{ captureIds; size; layout; suggestedName? }`. */
export function validateCartPrepareSheetDrag(
  req: unknown
): ({ ok: true } & ValidContactSheetRequest) | Invalid {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  const ids = parseCaptureIds(req.captureIds, MAX_CONTACT_SHEET_IDS);
  if (!ids.ok) return ids;
  const size = parseSheetSize(req.size);
  if (!size.ok) return size;
  const layout = parseSheetLayout(req.layout);
  if (!layout.ok) return layout;
  const name = parseSuggestedName(req.suggestedName);
  if (!name.ok) return name;
  return {
    ok: true,
    captureIds: ids.captureIds,
    size: size.size,
    layout: layout.layout,
    suggestedName: name.suggestedName
  };
}

/** `cart:contactSheet` — the drag shape plus `action` and `jobId`. */
export function validateCartContactSheet(
  req: unknown
): ({ ok: true; action: "copy" | "save"; jobId: string } & ValidContactSheetRequest) | Invalid {
  if (!isRecord(req)) {
    return { ok: false, error: validationError("not_object", "payload must be an object") };
  }
  const base = validateCartPrepareSheetDrag(req);
  if (!base.ok) return base;
  if (req.action !== "copy" && req.action !== "save") {
    return { ok: false, error: validationError("action_invalid", "action must be copy | save") };
  }
  const job = parseJobId(req.jobId);
  if (!job.ok) return job;
  return { ...base, action: req.action, jobId: job.jobId };
}
