import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildThirdPartyLicenseNotice,
  declaredLicenseFallbackText,
} from "../generate-third-party-licenses.mjs";
import { checkPackageLicensePolicy } from "../check-package-license-policy.mjs";

let tempRoots = [];

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-license-test-"));
  tempRoots.push(root);
  return root;
}

function packageDir(root, name, version, licenseText, packageJson = {}) {
  const dir = join(root, `${name.replace("/", "+")}@${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version,
        license: packageJson.license ?? "MIT",
        homepage: packageJson.homepage ?? `https://example.test/${name}`,
        author: packageJson.author,
        repository: packageJson.repository,
      },
      null,
      2,
    ),
  );
  if (licenseText !== undefined) {
    writeFileSync(join(dir, "LICENSE"), licenseText);
  }
  return dir;
}

function report(recordsByLicense) {
  const out = {};
  for (const [license, records] of Object.entries(recordsByLicense)) {
    out[license] = records.map((record) => ({
      name: record.name,
      versions: [record.version],
      paths: [record.packagePath],
      license,
      homepage: record.homepage,
      author: record.author,
      description: record.description,
    }));
  }
  return out;
}

describe("buildThirdPartyLicenseNotice", () => {
  test("groups shared license text once and lists all packages it applies to", () => {
    const root = tempRoot();
    const sharedMit = "MIT License\n\nPermission is hereby granted.";
    const alpha = packageDir(root, "alpha", "1.0.0", sharedMit);
    const beta = packageDir(root, "beta", "2.0.0", sharedMit);
    const electron = packageDir(root, "electron", "41.2.1", "MIT License\n\nElectron runtime.");

    const output = buildThirdPartyLicenseNotice({
      productionReport: report({
        MIT: [
          { name: "alpha", version: "1.0.0", packagePath: alpha },
          { name: "beta", version: "2.0.0", packagePath: beta },
        ],
      }),
      allReport: report({
        MIT: [{ name: "electron", version: "41.2.1", packagePath: electron }],
      }),
      supplementalRecords: [],
    });

    expect(output).toContain("alpha@1.0.0 (MIT)");
    expect(output).toContain("- alpha@1.0.0 (MIT)");
    expect(output).toContain("- beta@2.0.0 (MIT)");
    expect(output.match(/Permission is hereby granted/g)).toHaveLength(1);
    expect(output).toContain("electron@41.2.1");
  });

  test("includes Geist OFL packages and bundled asset note", () => {
    const root = tempRoot();
    const ofl = "SIL OPEN FONT LICENSE Version 1.1\n\nCopyright 2024 The Geist Project Authors";
    const sans = packageDir(root, "@fontsource/geist-sans", "5.2.5", ofl, {
      license: "OFL-1.1",
      homepage: "https://fontsource.org/fonts/geist-sans",
    });
    const mono = packageDir(root, "@fontsource/geist-mono", "5.2.7", ofl, {
      license: "OFL-1.1",
      homepage: "https://fontsource.org/fonts/geist-mono",
    });

    const output = buildThirdPartyLicenseNotice({
      productionReport: report({
        "OFL-1.1": [
          { name: "@fontsource/geist-sans", version: "5.2.5", packagePath: sans },
          { name: "@fontsource/geist-mono", version: "5.2.7", packagePath: mono },
        ],
      }),
      allReport: {},
      supplementalRecords: [],
    });

    expect(output).toContain("Bundled Asset Notes");
    expect(output).toContain("Geist Sans and Geist Mono webfont assets");
    expect(output).toContain("OFL-1.1");
    expect(output).toContain("@fontsource/geist-sans@5.2.5");
    expect(output).toContain("@fontsource/geist-mono@5.2.7");
    expect(output).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  test("lists explicit macOS native optional runtime notices independent of host OS", () => {
    const output = buildThirdPartyLicenseNotice({
      productionReport: {},
      allReport: {},
    });

    expect(output).toContain("@img/sharp-darwin-arm64@0.34.5");
    expect(output).toContain("@img/sharp-libvips-darwin-arm64@1.2.4");
    expect(output).toContain("deterministic when checked on Linux CI");
  });

  test("appends full canonical LGPL texts and relink offers for weak-copyleft bundled binaries", () => {
    const output = buildThirdPartyLicenseNotice({
      productionReport: {},
      allReport: {},
    });

    // Dedicated section heading.
    expect(output).toContain("Full License Texts — Weak-Copyleft Bundled Binaries");

    // Full canonical FSF texts, identified by their unmistakable version lines.
    expect(output).toContain("Version 2.1, February 1999");
    expect(output).toContain("Version 3, 29 June 2007");
    expect(output.match(/GNU LESSER GENERAL PUBLIC LICENSE/g).length).toBeGreaterThanOrEqual(2);

    // Relink / written-source offer for each binary.
    expect(output).toContain("Relinking / source offer");
    expect(output).toContain("three years from the date of distribution");

    // The misleading "no license text" stub must not be emitted for libvips.
    expect(output).not.toContain(
      "No license text file was found in the installed package for @img/sharp-libvips-darwin-arm64",
    );
  });

  test("uses deterministic fallback text for MIT packages without license files", () => {
    const text = declaredLicenseFallbackText(
      {
        name: "no-license-file",
        version: "1.0.0",
        declaredLicense: "MIT",
      },
      { author: { name: "Example Author" } },
    );

    expect(text).toContain("package metadata declares MIT");
    expect(text).toContain("Copyright (c) Example Author");
  });

  test("emits a clear placeholder for non-MIT packages without license files", () => {
    const text = declaredLicenseFallbackText(
      {
        name: "custom-license-package",
        version: "1.0.0",
        declaredLicense: "BSD-3-Clause",
      },
      {},
    );

    expect(text).toContain("No license text file was found");
    expect(text).toContain("license: BSD-3-Clause");
  });
});

describe("checkPackageLicensePolicy", () => {
  function writePackage(root, relPath, license) {
    const fullPath = join(root, relPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, JSON.stringify({ license }, null, 2));
  }

  function writeExpectedPackages(root, overrides = {}) {
    const expected = {
      "package.json": "MIT",
      "apps/desktop/package.json": "MIT",
      "packages/codex-app-server-protocol/package.json": "MIT",
      "packages/shared/package.json": "MIT",
      "packages/pwrsnap/package.json": "MIT",
      ...overrides,
    };
    for (const [path, license] of Object.entries(expected)) {
      writePackage(root, path, license);
    }
  }

  test("allows the all-MIT package layout", () => {
    const root = tempRoot();
    writeExpectedPackages(root);

    expect(checkPackageLicensePolicy(root)).toEqual([]);
  });

  test("fails when an internal package drifts away from MIT", () => {
    const root = tempRoot();
    writeExpectedPackages(root, {
      "apps/desktop/package.json": "UNLICENSED",
    });

    expect(checkPackageLicensePolicy(root)).toContain(
      'apps/desktop/package.json declares license "UNLICENSED"; expected "MIT"',
    );
  });

  test("fails when a new package is not covered by the policy", () => {
    const root = tempRoot();
    writeExpectedPackages(root);
    writePackage(root, "packages/new-package/package.json", "MIT");

    expect(checkPackageLicensePolicy(root)).toContain(
      "packages/new-package/package.json is not covered by scripts/check-package-license-policy.mjs; add an explicit expected license",
    );
  });
});
