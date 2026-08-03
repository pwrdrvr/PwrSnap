import { describe, expect, test } from "vitest";
import { validateSettingsWrite } from "../settings-validators";

describe("validateSettingsWrite — localAgents", () => {
  test("accepts the MCP listener gate", () => {
    expect(validateSettingsWrite({ localAgents: { enabled: true } }).ok).toBe(true);
    expect(validateSettingsWrite({ localAgents: { enabled: false } }).ok).toBe(true);
    expect(validateSettingsWrite({ localAgents: {} }).ok).toBe(true);
  });

  test("rejects non-boolean gate values", () => {
    expect(validateSettingsWrite({ localAgents: { enabled: "yes" } }).ok).toBe(false);
    expect(validateSettingsWrite({ localAgents: { enabled: null } }).ok).toBe(false);
  });

  test("rejects policy state replacement through settings:write", () => {
    for (const key of ["grants", "roles", "audit"] as const) {
      const result = validateSettingsWrite({ localAgents: { [key]: [] } });
      expect(result).toMatchObject({
        ok: false,
        error: { code: `invalid_localAgents_${key}` }
      });
    }
  });
});
