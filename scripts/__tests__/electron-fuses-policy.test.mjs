import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  REQUIRED_FUSES,
  checkElectronFusesPolicy,
  parseElectronFusesBlock,
} from "../check-electron-fuses-policy.mjs";

let tempRoots = [];

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-electron-fuses-policy-test-"));
  tempRoots.push(root);
  return root;
}

/** Writes an electron-builder.yml whose fuse block starts from the required
 *  posture, with `overrides` applied on top (a `null` value drops the key). */
function writeBuilderYml(root, overrides = {}) {
  const fuses = { ...REQUIRED_FUSES, ...overrides };
  const body = Object.entries(fuses)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `  ${name}: ${value}`)
    .join("\n");
  const yaml = [
    "appId: com.pwrdrvr.pwrsnap",
    "",
    "electronFuses:",
    body,
    "",
    "mac:",
    "  hardenedRuntime: true",
    "",
  ].join("\n");
  const fullPath = join(root, "apps/desktop/electron-builder.yml");
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, yaml);
  return root;
}

describe("checkElectronFusesPolicy", () => {
  test("accepts the required posture", () => {
    expect(checkElectronFusesPolicy(writeBuilderYml(tempRoot()))).toEqual([]);
  });

  test("passes against the config the repo actually ships", () => {
    // Guards the real tree, not just a fixture. Fuses are burned into the
    // packaged binary and cannot be read back at runtime, so this assertion is
    // the only thing standing between a flipped value and an installer.
    expect(checkElectronFusesPolicy()).toEqual([]);
  });

  test("rejects re-enabling cookie encryption", () => {
    // The regression this gate exists for: enabling the fuse makes Electron
    // fetch the app's Safe Storage key from the login keychain at network
    // service startup, which is a macOS keychain password prompt before any
    // window exists. PwrSnap stores no cookies, so it protects nothing.
    const failures = checkElectronFusesPolicy(
      writeBuilderYml(tempRoot(), { enableCookieEncryption: true }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("enableCookieEncryption must be false");
  });

  test.each([
    ["runAsNode", true],
    ["enableNodeOptionsEnvironmentVariable", true],
    ["enableNodeCliInspectArguments", true],
    ["enableEmbeddedAsarIntegrityValidation", false],
    ["onlyLoadAppFromAsar", false],
  ])("rejects weakening %s", (name, wrongValue) => {
    const failures = checkElectronFusesPolicy(
      writeBuilderYml(tempRoot(), { [name]: wrongValue }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`${name} must be ${REQUIRED_FUSES[name]}`);
  });

  test("rejects a pinned fuse that was deleted rather than flipped", () => {
    const failures = checkElectronFusesPolicy(
      writeBuilderYml(tempRoot(), { enableCookieEncryption: null }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("enableCookieEncryption is missing");
  });

  test("reports a missing electronFuses block instead of passing vacuously", () => {
    const root = tempRoot();
    const fullPath = join(root, "apps/desktop/electron-builder.yml");
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, "appId: com.pwrdrvr.pwrsnap\n");
    expect(checkElectronFusesPolicy(root)).toEqual([
      "apps/desktop/electron-builder.yml has no top-level electronFuses block",
    ]);
  });

  test("reports an unreadable config", () => {
    const failures = checkElectronFusesPolicy(tempRoot());
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("could not be read");
  });
});

describe("parseElectronFusesBlock", () => {
  test("ends the block at the next top-level key", () => {
    const fuses = parseElectronFusesBlock(
      ["electronFuses:", "  runAsNode: false", "mac:", "  hardenedRuntime: true", ""].join("\n"),
    );
    expect(fuses).toEqual({ runAsNode: "false" });
  });

  test("skips comments and blank lines, and strips trailing comments", () => {
    const fuses = parseElectronFusesBlock(
      [
        "electronFuses:",
        "  # MUST stay false -- see the solutions doc.",
        "",
        "  enableCookieEncryption: false # pinned",
        "",
      ].join("\n"),
    );
    expect(fuses).toEqual({ enableCookieEncryption: "false" });
  });

  test("surfaces a nested entry rather than guessing at the shape", () => {
    const fuses = parseElectronFusesBlock(
      ["electronFuses:", "  grantFileProtocolExtraPrivileges:", "    - nope", ""].join("\n"),
    );
    expect(fuses.__parseError).toContain("unexpected line");
  });

  test("returns undefined when there is no block", () => {
    expect(parseElectronFusesBlock("appId: com.pwrdrvr.pwrsnap\n")).toBeUndefined();
  });
});
