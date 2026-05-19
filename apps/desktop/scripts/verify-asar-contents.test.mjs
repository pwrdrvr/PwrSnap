import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  findForbiddenAsarEntries,
  findMissingPackagedResources,
  verifyAsarListing,
  verifyPackagedResources,
} from "./verify-asar-contents.mjs";

let tempRoots = [];

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function fakeApp() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-app-"));
  const appPath = join(root, "PwrSnap.app");
  const resources = join(appPath, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  tempRoots.push(root);
  return { appPath, resources };
}

function writeResource(resources, name) {
  writeFileSync(join(resources, name), `${name}\n`);
}

describe("verify-asar-contents", () => {
  test("flags forbidden ASAR entries", () => {
    expect(
      findForbiddenAsarEntries([
        "/out/main/index.js",
        "/node_modules/@pwrsnap/shared/src/index.ts",
        "/docs/readme.md",
      ]),
    ).toEqual([
      { label: "TypeScript source", entry: "/node_modules/@pwrsnap/shared/src/index.ts" },
      { label: "Markdown", entry: "/docs/readme.md" },
    ]);
  });

  test("throws with a grouped message for forbidden ASAR entries", () => {
    expect(() => verifyAsarListing(["/docs/readme.md"])).toThrow(
      /forbidden file\(s\) in app\.asar/,
    );
  });

  test("allows app-owned prompt Markdown in ASAR", () => {
    expect(findForbiddenAsarEntries(["/out/main/prompts/capture-enrichment.md"])).toEqual([]);
    expect(() => verifyAsarListing(["/out/main/prompts/capture-enrichment.md"])).not.toThrow();
  });

  test("passes packaged resource verification when notices and changelog exist", () => {
    const { appPath, resources } = fakeApp();
    writeResource(resources, "THIRD_PARTY_LICENSES");
    writeResource(resources, "CHANGELOG.md");

    expect(findMissingPackagedResources(appPath)).toEqual([]);
    expect(() => verifyPackagedResources(appPath)).not.toThrow();
  });

  test("fails packaged resource verification when third-party notices are missing", () => {
    const { appPath, resources } = fakeApp();
    writeResource(resources, "CHANGELOG.md");

    expect(findMissingPackagedResources(appPath)).toEqual(["THIRD_PARTY_LICENSES"]);
    expect(() => verifyPackagedResources(appPath)).toThrow(
      /missing packaged resource\(s\): THIRD_PARTY_LICENSES/,
    );
  });

  test("fails packaged resource verification when changelog is missing", () => {
    const { appPath, resources } = fakeApp();
    writeResource(resources, "THIRD_PARTY_LICENSES");

    expect(findMissingPackagedResources(appPath)).toEqual(["CHANGELOG.md"]);
    expect(() => verifyPackagedResources(appPath)).toThrow(
      /missing packaged resource\(s\): CHANGELOG\.md/,
    );
  });
});
