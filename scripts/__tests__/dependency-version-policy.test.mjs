import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkDependencyVersionPolicy,
  isCliEntrypoint,
} from "../check-dependency-version-policy.mjs";
import { syncPackagedElectronVersion } from "../sync-packaged-electron-version.mjs";

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

function writeElectronReleaseInputs(root, { resolved, packaged, builderConfig }) {
  writePackage(root, "apps/desktop/package.json", {
    devDependencies: resolved === undefined ? {} : { electron: `^${resolved}` },
  });
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    resolved === undefined
      ? `lockfileVersion: '9.0'

importers:

  apps/desktop:
    devDependencies: {}
`
      : `lockfileVersion: '9.0'

importers:

  apps/desktop:
    devDependencies:
      electron:
        specifier: ^${resolved}
        version: ${resolved}
`,
  );
  writeFileSync(
    join(root, "apps", "desktop", "electron-builder.yml"),
    builderConfig ?? `electronVersion: ${packaged}\n`,
  );
}

function readBuilderConfig(root) {
  return readFileSync(join(root, "apps", "desktop", "electron-builder.yml"), "utf8");
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

  test("allows the packaged Electron runtime to match the resolved dependency", () => {
    const root = tempRoot();
    writeElectronReleaseInputs(root, {
      resolved: "41.10.3",
      packaged: "41.10.3",
    });

    expect(checkDependencyVersionPolicy(root)).toEqual([]);
  });

  test("fails when electron-builder packages a different Electron runtime", () => {
    const root = tempRoot();
    writeElectronReleaseInputs(root, {
      resolved: "41.10.3",
      packaged: "41.2.1",
    });

    expect(checkDependencyVersionPolicy(root)).toEqual([
      "Electron runtime versions must match exactly; pnpm-lock.yaml resolves electron@41.10.3, apps/desktop/electron-builder.yml packages electron@41.2.1",
    ]);
  });

  test("recognizes the CLI entrypoint when the checkout path has escaped characters", () => {
    const scriptPath = join(tempRoot(), "path with spaces", "check-dependency-version-policy.mjs");

    expect(isCliEntrypoint(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
  });
});

describe("syncPackagedElectronVersion", () => {
  test("rewrites the packaged runtime to the lockfile version and clears the policy failure", () => {
    const root = tempRoot();
    // The exact shape of PR #565: Dependabot moved the lockfile to 41.10.7 and
    // left electron-builder.yml pinned at 41.10.3.
    writeElectronReleaseInputs(root, { resolved: "41.10.7", packaged: "41.10.3" });
    expect(checkDependencyVersionPolicy(root)).toEqual([
      "Electron runtime versions must match exactly; pnpm-lock.yaml resolves electron@41.10.7, apps/desktop/electron-builder.yml packages electron@41.10.3",
    ]);

    expect(syncPackagedElectronVersion(root)).toEqual({
      changed: true,
      from: "41.10.3",
      to: "41.10.7",
    });

    expect(readBuilderConfig(root)).toBe("electronVersion: 41.10.7\n");
    expect(checkDependencyVersionPolicy(root)).toEqual([]);
  });

  test("reports no change and rewrites nothing when the pin already matches", () => {
    const root = tempRoot();
    writeElectronReleaseInputs(root, { resolved: "41.10.7", packaged: "41.10.7" });
    const before = readBuilderConfig(root);

    expect(syncPackagedElectronVersion(root)).toEqual({
      changed: false,
      from: "41.10.7",
      to: "41.10.7",
    });

    // Byte-identical: the workflow commits only when `git diff` sees a change,
    // so a rewrite that reformats an unchanged file would push a pointless
    // commit onto somebody else's branch.
    expect(readBuilderConfig(root)).toBe(before);
  });

  test("touches only the electronVersion line, keeping comments and spacing", () => {
    const root = tempRoot();
    // electron-builder.yml is mostly load-bearing prose — the afterPack
    // rationale, the asarUnpack sharp/libvips notes — and three other regex
    // parsers read it. A YAML round-trip would rewrite all of that.
    const builderConfig = [
      "appId: com.pwrdrvr.pwrsnap",
      "productName: PwrSnap",
      "",
      "# Sign nested .appex Quick Look extensions BEFORE electron-builder signs",
      "# the parent app's main binary.",
      "afterPack: \"scripts/afterpack-sign-appex.mjs\"",
      "",
      "electronVersion:   41.10.3 # pinned to the resolved dependency",
      "",
      "asar: true",
      "asarUnpack:",
      '  - "**/*.node"',
      "",
    ].join("\n");
    writeElectronReleaseInputs(root, { resolved: "41.10.7", builderConfig });

    expect(syncPackagedElectronVersion(root)).toEqual({
      changed: true,
      from: "41.10.3",
      to: "41.10.7",
    });

    expect(readBuilderConfig(root)).toBe(
      builderConfig.replace(
        "electronVersion:   41.10.3 # pinned",
        "electronVersion:   41.10.7 # pinned",
      ),
    );
    expect(checkDependencyVersionPolicy(root)).toEqual([]);
  });

  test("throws when the lockfile resolves no Electron for apps/desktop", () => {
    const root = tempRoot();
    writeElectronReleaseInputs(root, { packaged: "41.10.3" });

    expect(() => syncPackagedElectronVersion(root)).toThrow(
      /does not resolve an electron version/,
    );
    expect(readBuilderConfig(root)).toBe("electronVersion: 41.10.3\n");
  });

  test("throws rather than writing a lockfile version that is not a plain version", () => {
    const root = tempRoot();
    writeElectronReleaseInputs(root, { resolved: "41.10.3", packaged: "41.10.3" });
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'

importers:

  apps/desktop:
    devDependencies:
      electron:
        specifier: "https://example.invalid/electron.tgz"
        version: https://example.invalid/electron.tgz
`,
    );

    expect(() => syncPackagedElectronVersion(root)).toThrow(/not a plain version/);
    expect(readBuilderConfig(root)).toBe("electronVersion: 41.10.3\n");
  });

  test("throws when electron-builder.yml has no electronVersion line", () => {
    const root = tempRoot();
    writeElectronReleaseInputs(root, {
      resolved: "41.10.7",
      builderConfig: "appId: com.pwrdrvr.pwrsnap\n",
    });

    expect(() => syncPackagedElectronVersion(root)).toThrow(
      /no electronVersion line to sync/,
    );
  });

  test("refuses to guess when electronVersion is declared twice", () => {
    const root = tempRoot();
    writeElectronReleaseInputs(root, {
      resolved: "41.10.7",
      builderConfig: "electronVersion: 41.10.3\nasar: true\nelectronVersion: 41.10.5\n",
    });

    expect(() => syncPackagedElectronVersion(root)).toThrow(/declares electronVersion 2 times/);
    expect(readBuilderConfig(root)).toBe(
      "electronVersion: 41.10.3\nasar: true\nelectronVersion: 41.10.5\n",
    );
  });
});
