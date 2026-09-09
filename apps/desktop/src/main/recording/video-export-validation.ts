// THE bus-boundary validator for every verb that takes a
// `VideoExportCoordinates`-shaped request — `video:export`,
// `clipboard:copyVideoFile`, `clipboard:copyVideoPath`. One
// implementation, one set of error codes, so a payload that
// `video:export` rejects can't sneak in through the clipboard door.
//
// Why this has to run BEFORE `resolveVideoExport`: the resolver
// hands the caller's range straight to `normalizeRange`, which is a
// clamp (`Math.max(0, Math.min(x, d))`) — and a clamp is not a
// sanitizer. `NaN` survives it untouched, then poisons everything
// downstream: it can never equal a cached row's range (NaN !== NaN),
// it renders into a cache filename like `rNaN-NaN`, and it reaches
// ffmpeg as `-ss NaN -t NaN`. Every call re-encodes and every encode
// fails. Same class of problem for negative or inverted ranges, which
// normalizeRange silently rewrites into something the caller never
// asked for.
//
// Renderers are not the only client: the Phase 7 HTTP RPC transport
// and a future MCP transport dispatch through the same bus, so
// "the UI would never send that" is not a defense.

import { ok, err } from "@pwrsnap/shared";
import type { PwrSnapError, Result, VideoExportCoordinates } from "@pwrsnap/shared";

function validationError(code: string, message: string): PwrSnapError {
  return { kind: "validation", code, message };
}

/**
 * Validate a video export request without crossing the bus. We can't
 * trust the renderer (or a future HTTP/MCP transport) to send well-
 * formed range or audio payloads, so every arm is checked.
 *
 * `verb` prefixes the messages so a rejection names the caller that
 * produced it. The request is returned unchanged on success — this is
 * a gate, not a normalizer; clamping to the source duration stays in
 * `normalizeRange`, which runs once the values are known-sane.
 */
export function validateVideoExportRequest<
  T extends VideoExportCoordinates & { runId?: unknown }
>(
  req: T,
  verb: string
): Result<T, PwrSnapError> {
  if (typeof req !== "object" || req === null) {
    return err(validationError("invalid_request", `${verb}: request must be an object`));
  }
  if (typeof req.captureId !== "string" || req.captureId.length === 0) {
    return err(
      validationError("invalid_capture_id", `${verb}: captureId must be a non-empty string`)
    );
  }
  if (req.format !== "gif" && req.format !== "mp4") {
    return err(validationError("invalid_format", `${verb}: format must be "gif" or "mp4"`));
  }
  if (req.preset !== "low" && req.preset !== "med" && req.preset !== "high") {
    return err(
      validationError("invalid_preset", `${verb}: preset must be "low", "med", or "high"`)
    );
  }
  if (
    req.runId !== undefined &&
    (typeof req.runId !== "string" || req.runId.length === 0 || req.runId.length > 128)
  ) {
    return err(
      validationError(
        "invalid_run_id",
        `${verb}: runId must be a non-empty string of at most 128 characters`
      )
    );
  }
  if (req.range !== undefined) {
    const r = req.range;
    if (typeof r !== "object" || r === null) {
      return err(validationError("invalid_range", `${verb}: range must be an object`));
    }
    if (typeof r.start !== "number" || typeof r.end !== "number") {
      return err(validationError("invalid_range", `${verb}: range start/end must be numbers`));
    }
    // `Number.isFinite` is the NaN / ±Infinity gate. Both survive
    // `normalizeRange` and poison the export cache key.
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) {
      return err(validationError("invalid_range", `${verb}: range start/end must be finite`));
    }
    if (r.start < 0 || r.end < 0) {
      return err(validationError("invalid_range", `${verb}: range start/end must be >= 0`));
    }
    // Zero-length and inverted ranges both encode nothing. The
    // renderer's `clampRange` already enforces a MIN_RANGE_SEC gap, so
    // a request that lands here is a bug or a hostile client.
    if (r.end <= r.start) {
      return err(validationError("invalid_range", `${verb}: range end must be > start`));
    }
  }
  if (req.audio !== undefined) {
    const a = req.audio;
    if (typeof a !== "object" || a === null) {
      return err(validationError("invalid_audio", `${verb}: audio must be an object`));
    }
    if (
      typeof a.includeSystemAudio !== "boolean" ||
      typeof a.includeMicrophone !== "boolean"
    ) {
      return err(validationError("invalid_audio", `${verb}: audio toggles must be booleans`));
    }
  }
  return ok(req);
}
