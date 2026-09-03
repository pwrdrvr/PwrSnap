import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkAppMetadataPolicy } from "../check-app-metadata-policy.mjs";

let tempRoots = [];

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-app-metadata-policy-test-"));
  tempRoots.push(root);
  return root;
}

function writePackage(root, relPath, packageJson) {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(packageJson, null, 2));
}

/** Writes both covered manifests with the same description. */
function writeRoot(root, description, { rootDescription = description } = {}) {
  writePackage(root, "apps/desktop/package.json", { description });
  writePackage(root, "package.json", { description: rootDescription });
  return root;
}

describe("checkAppMetadataPolicy", () => {
  test("accepts a platform-neutral description present in both manifests", () => {
    const root = writeRoot(tempRoot(), "Screen capture with a local-first library");
    expect(checkAppMetadataPolicy(root)).toEqual([]);
  });

  test("passes the description the repo actually ships", () => {
    // Guards the real tree, not just a fixture: this is the string that lands
    // in the Windows installer's FileDescription and the .lnk comment.
    expect(checkAppMetadataPolicy()).toEqual([]);
  });

  // The regression that prompted the gate: v1.1's Windows installer and
  // taskbar jump list both read "Mac-first agentic screen capture tool".
  test("rejects the v1.1 Mac-first description", () => {
    const root = writeRoot(tempRoot(), "Mac-first agentic screen capture tool");
    const failures = checkAppMetadataPolicy(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/platform-neutral/);
    expect(failures[0]).toMatch(/Mac-first agentic screen capture tool/);
  });

  test.each([
    ["macOS-first screen capture", "macOS attached to a word"],
    ["Screen capture for Windows", "the platform we ship to, still wrong on macOS"],
    ["A Darwin-native capture tool", "darwin"],
    ["Capture tool for Linux desktops", "linux"],
    ["An Apple-silicon capture tool", "apple"],
    ["Capture for iOS and the desktop", "ios"],
    ["A Cocoa capture tool", "cocoa"],
  ])("rejects %j (%s)", (description) => {
    const root = writeRoot(tempRoot(), description);
    expect(checkAppMetadataPolicy(root)).toEqual([expect.stringMatching(/platform-neutral/)]);
  });

  test.each([
    "Screen capture with a local-first library",
    "Local-first capture, annotation, and a searchable library",
    "Macro-free screen capture",
  ])("accepts %j", (description) => {
    const root = writeRoot(tempRoot(), description);
    expect(checkAppMetadataPolicy(root)).toEqual([]);
  });

  test("rejects a missing description", () => {
    const root = tempRoot();
    writePackage(root, "apps/desktop/package.json", { name: "@pwrsnap/desktop" });
    writePackage(root, "package.json", { name: "pwrsnap-workspace" });
    expect(checkAppMetadataPolicy(root)).toEqual([
      expect.stringMatching(/must be a non-empty string/),
    ]);
  });

  test("rejects a whitespace-only description", () => {
    const root = writeRoot(tempRoot(), "   ");
    expect(checkAppMetadataPolicy(root)).toEqual([
      expect.stringMatching(/must be a non-empty string/),
    ]);
  });

  test("does not also report a sync mismatch when the description is unusable", () => {
    // One root cause should produce one failure line, not two.
    const root = writeRoot(tempRoot(), "", { rootDescription: "Something else" });
    expect(checkAppMetadataPolicy(root)).toHaveLength(1);
  });

  test("rejects a description too long for a one-line label", () => {
    const description = `Screen capture ${"and annotation ".repeat(6)}`.trim();
    expect(description.length).toBeGreaterThan(80);
    const root = writeRoot(tempRoot(), description);
    expect(checkAppMetadataPolicy(root)).toEqual([expect.stringMatching(/characters/)]);
  });

  test("rejects drift between the root and desktop manifests", () => {
    const root = writeRoot(tempRoot(), "Screen capture with a local-first library", {
      rootDescription: "Screen capture with a local first library",
    });
    expect(checkAppMetadataPolicy(root)).toEqual([expect.stringMatching(/must match/)]);
  });

  test("reports an unreadable desktop manifest instead of throwing", () => {
    const root = tempRoot();
    mkdirSync(join(root, "apps/desktop"), { recursive: true });
    writeFileSync(join(root, "apps/desktop/package.json"), "{ not json");
    expect(checkAppMetadataPolicy(root)).toEqual([
      expect.stringMatching(/could not be read/),
    ]);
  });
});
