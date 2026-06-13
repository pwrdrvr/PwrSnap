// Role parsing for the two-process split (agent ↔ library). The
// supervisor passes `--pwrsnap-role=library` when spawning the library
// child; everything else must land on `combined` — a typo here would
// boot a windowless half-app.

import { describe, expect, test } from "vitest";
import { parseProcessRole, processRoleFlag, resolveProcessRole } from "../process-role";

describe("parseProcessRole", () => {
  test("defaults to combined when no flag is present", () => {
    expect(parseProcessRole(["/usr/bin/electron", "."])).toBe("combined");
    expect(parseProcessRole([])).toBe("combined");
  });

  test("parses each role", () => {
    expect(parseProcessRole(["app", "--pwrsnap-role=agent"])).toBe("agent");
    expect(parseProcessRole(["app", "--pwrsnap-role=library"])).toBe("library");
    expect(parseProcessRole(["app", "--pwrsnap-role=combined"])).toBe("combined");
  });

  test("last flag wins", () => {
    expect(
      parseProcessRole(["app", "--pwrsnap-role=agent", "--pwrsnap-role=library"])
    ).toBe("library");
  });

  test("unrecognized value falls back to combined, even with an earlier valid flag", () => {
    expect(parseProcessRole(["app", "--pwrsnap-role=tray"])).toBe("combined");
    expect(
      parseProcessRole(["app", "--pwrsnap-role=agent", "--pwrsnap-role=garbage"])
    ).toBe("combined");
  });

  test("ignores unrelated args and near-miss flags", () => {
    expect(
      parseProcessRole(["app", "--seed=profile", "--pwrsnap-role", "agent"])
    ).toBe("combined");
  });

  test("processRoleFlag round-trips through the parser", () => {
    expect(parseProcessRole(["app", processRoleFlag("library")])).toBe("library");
  });
});

describe("resolveProcessRole", () => {
  const base = {
    argv: ["app"],
    env: {},
    platform: "darwin" as NodeJS.Platform,
    experimentalProcessSplit: false
  };

  test("macOS defaults to combined (experimental.processSplit ships OFF)", () => {
    expect(resolveProcessRole(base)).toBe("combined");
  });

  test("the settings toggle ON makes macOS boot the agent", () => {
    expect(resolveProcessRole({ ...base, experimentalProcessSplit: true })).toBe("agent");
  });

  test("explicit argv flag always wins", () => {
    expect(
      resolveProcessRole({
        ...base,
        argv: ["app", processRoleFlag("library")],
        env: { PWRSNAP_PROCESS_SPLIT: "1" }
      })
    ).toBe("library");
  });

  test("PWRSNAP_PROCESS_SPLIT env overrides the setting in both directions", () => {
    expect(
      resolveProcessRole({
        ...base,
        env: { PWRSNAP_PROCESS_SPLIT: "1" },
        experimentalProcessSplit: false
      })
    ).toBe("agent");
    expect(
      resolveProcessRole({
        ...base,
        env: { PWRSNAP_PROCESS_SPLIT: "0" },
        experimentalProcessSplit: true
      })
    ).toBe("combined");
  });

  test("the split is darwin-only (Windows stays combined even with everything on)", () => {
    expect(
      resolveProcessRole({
        ...base,
        env: { PWRSNAP_PROCESS_SPLIT: "1" },
        platform: "win32"
      })
    ).toBe("combined");
  });

  test("E2E forces combined regardless of setting and env flag", () => {
    expect(
      resolveProcessRole({
        ...base,
        env: { PWRSNAP_PROCESS_SPLIT: "1", PWRSNAP_E2E: "1" }
      })
    ).toBe("combined");
  });

  test("the E2E split lane opts in with PWRSNAP_E2E_SPLIT=1 (darwin only)", () => {
    expect(
      resolveProcessRole({
        ...base,
        env: { PWRSNAP_E2E: "1", PWRSNAP_E2E_SPLIT: "1" }
      })
    ).toBe("agent");
    expect(
      resolveProcessRole({
        ...base,
        env: { PWRSNAP_E2E: "1", PWRSNAP_E2E_SPLIT: "1" },
        platform: "linux"
      })
    ).toBe("combined");
  });
});
