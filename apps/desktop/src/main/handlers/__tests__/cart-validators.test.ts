import { describe, expect, it } from "vitest";
import {
  validateCartCaptureId,
  validateCartCommitToExisting,
  validateCartCommitToNew,
  validateCartExportZip,
  validateCartExportZipCancel,
  validateCartRename,
  validateCartReorder
} from "../cart-validators";

describe("validateCartExportZip", () => {
  it("accepts ids + a valid preset, dedupes ids", () => {
    const r = validateCartExportZip({
      captureIds: ["a", "b", "a"],
      preset: "med",
      jobId: "job-1"
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.captureIds).toEqual(["a", "b"]);
      expect(r.preset).toBe("med");
      expect(r.suggestedName).toBeUndefined();
      expect(r.jobId).toBe("job-1");
    }
  });

  it("accepts + truncates a suggestedName", () => {
    const r = validateCartExportZip({
      captureIds: ["a"],
      preset: "low",
      suggestedName: "x".repeat(500),
      jobId: "job-1"
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suggestedName?.length).toBe(200);
  });

  it("rejects a missing / non-string jobId", () => {
    expect(validateCartExportZip({ captureIds: ["a"], preset: "low" })).toMatchObject({
      ok: false,
      error: { code: "jobId_invalid" }
    });
    expect(
      validateCartExportZip({ captureIds: ["a"], preset: "low", jobId: "" })
    ).toMatchObject({ ok: false, error: { code: "jobId_invalid" } });
  });

  it("rejects empty / non-array captureIds", () => {
    expect(validateCartExportZip({ captureIds: [], preset: "low" })).toMatchObject({
      ok: false,
      error: { code: "captureIds_required" }
    });
    expect(validateCartExportZip({ captureIds: "a", preset: "low" })).toMatchObject({
      ok: false,
      error: { code: "captureIds_required" }
    });
  });

  it("caps cardinality", () => {
    const many = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    expect(validateCartExportZip({ captureIds: many, preset: "low" })).toMatchObject({
      ok: false,
      error: { code: "too_many" }
    });
  });

  it("rejects a non-string id", () => {
    expect(validateCartExportZip({ captureIds: ["a", 2], preset: "low" })).toMatchObject({
      ok: false,
      error: { code: "captureId_invalid" }
    });
  });

  it("rejects an invalid preset", () => {
    expect(validateCartExportZip({ captureIds: ["a"], preset: "ultra" })).toMatchObject({
      ok: false,
      error: { code: "preset_invalid" }
    });
  });
});

describe("validateCartExportZipCancel", () => {
  it("accepts a non-empty jobId", () => {
    const r = validateCartExportZipCancel({ jobId: "job-1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jobId).toBe("job-1");
  });

  it("rejects non-object / empty / over-long jobId", () => {
    expect(validateCartExportZipCancel(null)).toMatchObject({
      ok: false,
      error: { code: "not_object" }
    });
    expect(validateCartExportZipCancel({ jobId: "" })).toMatchObject({
      ok: false,
      error: { code: "jobId_invalid" }
    });
    expect(validateCartExportZipCancel({ jobId: "x".repeat(129) })).toMatchObject({
      ok: false,
      error: { code: "jobId_invalid" }
    });
  });
});

describe("validateCartCaptureId", () => {
  it("accepts a non-empty captureId", () => {
    const r = validateCartCaptureId({ captureId: "cap-1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.captureId).toBe("cap-1");
  });

  it("rejects non-object payload", () => {
    expect(validateCartCaptureId(null)).toMatchObject({
      ok: false,
      error: { code: "not_object" }
    });
  });

  it("rejects empty / missing captureId", () => {
    expect(validateCartCaptureId({})).toMatchObject({
      ok: false,
      error: { code: "captureId_required" }
    });
    expect(validateCartCaptureId({ captureId: "" })).toMatchObject({
      ok: false,
      error: { code: "captureId_required" }
    });
    expect(validateCartCaptureId({ captureId: 42 })).toMatchObject({
      ok: false,
      error: { code: "captureId_required" }
    });
  });
});

describe("validateCartReorder", () => {
  it("accepts non-negative integers", () => {
    const r = validateCartReorder({ from: 0, to: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.from).toBe(0);
      expect(r.to).toBe(3);
    }
  });

  it("rejects negatives", () => {
    expect(validateCartReorder({ from: -1, to: 0 })).toMatchObject({
      ok: false,
      error: { code: "from_invalid" }
    });
    expect(validateCartReorder({ from: 0, to: -2 })).toMatchObject({
      ok: false,
      error: { code: "to_invalid" }
    });
  });

  it("rejects non-integers", () => {
    expect(validateCartReorder({ from: 1.5, to: 0 })).toMatchObject({
      ok: false,
      error: { code: "from_invalid" }
    });
    expect(validateCartReorder({ from: 0, to: NaN })).toMatchObject({
      ok: false,
      error: { code: "to_invalid" }
    });
  });

  it("rejects missing fields", () => {
    expect(validateCartReorder({ from: 0 })).toMatchObject({
      ok: false,
      error: { code: "to_invalid" }
    });
  });
});

describe("validateCartRename", () => {
  it("accepts a string name (including empty — store collapses it)", () => {
    expect(validateCartRename({ name: "Demo" })).toMatchObject({ ok: true });
    expect(validateCartRename({ name: "" })).toMatchObject({ ok: true });
  });

  it("rejects non-string name", () => {
    expect(validateCartRename({ name: 42 })).toMatchObject({
      ok: false,
      error: { code: "name_invalid" }
    });
  });

  it("rejects an over-long name", () => {
    expect(validateCartRename({ name: "x".repeat(201) })).toMatchObject({
      ok: false,
      error: { code: "name_too_long" }
    });
  });

  it("accepts a name exactly at the 200-char cap", () => {
    expect(validateCartRename({ name: "x".repeat(200) })).toMatchObject({
      ok: true
    });
  });
});

describe("validateCartCommitToNew", () => {
  it("accepts an empty / null payload (name optional)", () => {
    expect(validateCartCommitToNew(undefined)).toMatchObject({
      ok: true,
      name: undefined
    });
    expect(validateCartCommitToNew({})).toMatchObject({ ok: true, name: undefined });
    expect(validateCartCommitToNew({ name: null })).toMatchObject({
      ok: true,
      name: undefined
    });
  });

  it("accepts a provided name", () => {
    const r = validateCartCommitToNew({ name: "My Reel" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe("My Reel");
  });

  it("rejects non-string name", () => {
    expect(validateCartCommitToNew({ name: 42 })).toMatchObject({
      ok: false,
      error: { code: "name_invalid" }
    });
  });

  it("rejects an over-long name", () => {
    expect(validateCartCommitToNew({ name: "x".repeat(201) })).toMatchObject({
      ok: false,
      error: { code: "name_too_long" }
    });
  });
});

describe("validateCartCommitToExisting", () => {
  it("accepts a non-empty projectId", () => {
    const r = validateCartCommitToExisting({ projectId: "proj-1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.projectId).toBe("proj-1");
  });

  it("rejects non-object payload", () => {
    expect(validateCartCommitToExisting(null)).toMatchObject({
      ok: false,
      error: { code: "not_object" }
    });
  });

  it("rejects empty / missing projectId", () => {
    expect(validateCartCommitToExisting({})).toMatchObject({
      ok: false,
      error: { code: "projectId_required" }
    });
    expect(validateCartCommitToExisting({ projectId: "" })).toMatchObject({
      ok: false,
      error: { code: "projectId_required" }
    });
  });
});
