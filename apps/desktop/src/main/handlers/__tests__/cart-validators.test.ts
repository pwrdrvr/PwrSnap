import { describe, expect, it } from "vitest";
import {
  validateCartCaptureId,
  validateCartCommitToExisting,
  validateCartCommitToNew,
  validateCartRename,
  validateCartReorder
} from "../cart-validators";

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
