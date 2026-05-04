// Result-pattern smoke tests. The helpers themselves are trivial; we
// pin the discriminator shape so the IPC envelope can't change out
// from under callers without a test failure (`result.ok === true`
// implies `result.value`, `result.ok === false` implies `result.error`,
// no other shapes).

import { describe, expect, test } from "vitest";
import { err, ok, pwrSnapError, type PwrSnapError, type Result } from "../result";

describe("ok / err constructors", () => {
  test("ok produces a discriminated success", () => {
    const result = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
    if (result.ok) {
      // Exhaustiveness check — TypeScript narrows `value` to number.
      const n: number = result.value;
      expect(n).toBe(42);
    }
  });

  test("err produces a discriminated failure", () => {
    const error: PwrSnapError = pwrSnapError("capture", "tcc_denied", "Screen recording denied");
    const result = err(error);
    expect(result).toEqual({ ok: false, error });
    expect(result.ok).toBe(false);
  });

  test("results round-trip JSON cleanly (transports use structured-clone)", () => {
    const original: Result<{ id: string }, PwrSnapError> = ok({ id: "abc" });
    const cloned = JSON.parse(JSON.stringify(original)) as typeof original;
    expect(cloned).toEqual(original);
  });
});

describe("pwrSnapError factory", () => {
  test("preserves all fields and accepts an arbitrary cause", () => {
    const cause = new Error("upstream blew up");
    const e = pwrSnapError("render", "compose_failed", "Could not compose preview", cause);
    expect(e.kind).toBe("render");
    expect(e.code).toBe("compose_failed");
    expect(e.message).toBe("Could not compose preview");
    expect(e.cause).toBe(cause);
  });

  test("cause defaults to undefined and serializes through JSON", () => {
    const e = pwrSnapError("validation", "invalid_input", "rect must be positive");
    expect(e.cause).toBeUndefined();
    // Cause stripping over IPC: structured-clone drops Error instances.
    // Make sure the rest of the envelope survives.
    const cloned = JSON.parse(JSON.stringify(e)) as typeof e;
    expect(cloned.kind).toBe("validation");
    expect(cloned.code).toBe("invalid_input");
    expect(cloned.message).toBe("rect must be positive");
  });
});
