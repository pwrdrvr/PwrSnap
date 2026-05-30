import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkDependencyVersionPolicy,
  isCliEntrypoint,
} from "../check-dependency-version-policy.mjs";

let tempRoots = [];

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-dependency-policy-test-"));
  tempRoots.push(root);
  return root;
}

function writePackage(root, relPath, packageJson) {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(packageJson, null, 2));
}

function writeLockfile(root, { react = "19.2.5", reactDom = "19.2.5" } = {}) {
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'

importers:

  apps/desktop:
    dependencies:
      react:
        specifier: ^19.2.0
        version: ${react}
      react-dom:
        specifier: ^19.2.0
        version: ${reactDom}(react@${react})
`,
  );
}

describe("checkDependencyVersionPolicy", () => {
  test("allows matching React runtime manifest specifiers and lockfile versions", () => {
    const root = tempRoot();
    writePackage(root, "apps/desktop/package.json", {
      dependencies: {
        react: "^19.2.0",
        "react-dom": "^19.2.0",
      },
    });
    writeLockfile(root);

    expect(checkDependencyVersionPolicy(root)).toEqual([]);
  });

  test("fails when Dependabot bumps react without react-dom in package.json", () => {
    const root = tempRoot();
    writePackage(root, "apps/desktop/package.json", {
      dependencies: {
        react: "^19.2.6",
        "react-dom": "^19.2.0",
      },
    });
    writeLockfile(root, { react: "19.2.6", reactDom: "19.2.5" });

    expect(checkDependencyVersionPolicy(root)).toEqual([
      "apps/desktop/package.json: React runtime versions must match exactly; found react@^19.2.6, react-dom@^19.2.0",
      "pnpm-lock.yaml importer apps/desktop: React runtime versions must match exactly; found react@19.2.6, react-dom@19.2.5",
    ]);
  });

  test("fails when the manifest ranges match but the lockfile resolves mismatched React versions", () => {
    const root = tempRoot();
    writePackage(root, "apps/desktop/package.json", {
      dependencies: {
        react: "^19.2.0",
        "react-dom": "^19.2.0",
      },
    });
    writeLockfile(root, { react: "19.2.6", reactDom: "19.2.5" });

    expect(checkDependencyVersionPolicy(root)).toEqual([
      "pnpm-lock.yaml importer apps/desktop: React runtime versions must match exactly; found react@19.2.6, react-dom@19.2.5",
    ]);
  });

  test("recognizes the CLI entrypoint when the checkout path has escaped characters", () => {
    const scriptPath = join(tempRoot(), "path with spaces", "check-dependency-version-policy.mjs");

    expect(isCliEntrypoint(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
  });
});
