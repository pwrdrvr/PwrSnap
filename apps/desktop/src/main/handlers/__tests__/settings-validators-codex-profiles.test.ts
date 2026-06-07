// Unit tests for the Codex auth-profile-name validators
// (`validateCodexProfileCreate` / `validateCodexProfileLogin`). These guard
// the `codex:profiles:create` / `codex:profiles:login` bus inputs and reuse
// the kit's `normalizeProfileName` / `isValidProfileName`, so the assertions
// here pin the normalize-then-validate contract at the trust boundary.

import { describe, expect, test } from "vitest";
import {
  validateCodexProfileCreate,
  validateCodexProfileLogin
} from "../settings-validators";

describe("validateCodexProfileCreate", () => {
  test("accepts an already-canonical name unchanged", () => {
    const result = validateCodexProfileCreate({ name: "work" });
    expect(result).toEqual({ ok: true, value: { name: "work" } });
  });

  test("normalizes mixed-case / spaced input to a canonical name", () => {
    const result = validateCodexProfileCreate({ name: "  My Work Account  " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("my-work-account");
  });

  test("rejects empty / whitespace-only input", () => {
    for (const name of ["", "   "]) {
      const result = validateCodexProfileCreate({ name });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("validation");
        expect(result.error.code).toBe("empty_profile_name");
      }
    }
  });

  test("rejects input that normalizes to nothing usable", () => {
    const result = validateCodexProfileCreate({ name: "!!!" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_profile_name");
  });

  test("rejects a non-string name", () => {
    const result = validateCodexProfileCreate({ name: 42 as unknown as string });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_profile_name");
  });

  test("rejects an over-long name", () => {
    const result = validateCodexProfileCreate({ name: "a".repeat(65) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("profile_name_too_long");
  });
});

describe("validateCodexProfileLogin", () => {
  test("accepts the empty-string System-default sentinel", () => {
    const result = validateCodexProfileLogin({ name: "" });
    expect(result).toEqual({ ok: true, value: { name: "" } });
  });

  test("normalizes a named profile", () => {
    const result = validateCodexProfileLogin({ name: "Personal" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("personal");
  });

  test("rejects garbage that normalizes to nothing", () => {
    const result = validateCodexProfileLogin({ name: "***" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_profile_name");
  });
});
