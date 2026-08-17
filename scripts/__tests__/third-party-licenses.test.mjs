import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BUNDLED_FFMPEG_VERSION,
  buildThirdPartyLicenseNotice,
  declaredLicenseFallbackText,
  findUnmaterializedRecords,
  resolveMacArm64Versions,
  STALE_INSTALL_CODE,
} from "../generate-third-party-licenses.mjs";
import { checkPackageLicensePolicy } from "../check-package-license-policy.mjs";

// Arbitrary sentinel versions. The real ones are derived from the installed
// sharp manifest, so tests must never hardcode the shipping values — that is
// exactly the drift that let the notice claim sharp 0.34.5 while 0.35.3 shipped.
const PINNED_MAC_ARM64_VERSIONS = {
  sharpDarwinArm64: "9.9.9",
  libvipsDarwinArm64: "8.8.8",
};

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
        optionalDependencies: packageJson.optionalDependencies,
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
      macArm64Versions: PINNED_MAC_ARM64_VERSIONS,
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
      macArm64Versions: PINNED_MAC_ARM64_VERSIONS,
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
      macArm64Versions: PINNED_MAC_ARM64_VERSIONS,
    });

    expect(output).toContain("@img/sharp-darwin-arm64@9.9.9");
    expect(output).toContain("@img/sharp-libvips-darwin-arm64@8.8.8");
    expect(output).toContain("deterministic when checked on Linux CI");
  });

  test("appends full canonical LGPL texts and relink offers for weak-copyleft bundled binaries", () => {
    const output = buildThirdPartyLicenseNotice({
      productionReport: {},
      allReport: {},
      macArm64Versions: PINNED_MAC_ARM64_VERSIONS,
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

// Regression: node_modules drifting from pnpm-lock.yaml (the usual cause is a
// branch switch across a dependency bump without reinstalling) used to be
// absorbed silently — pnpm reports lockfile-derived paths, those directories do
// not exist, and enrichRecord quietly swapped each package's real license text
// for generated boilerplate and its manifest `repository` URL for the pnpm
// homepage. The result looked plausible and made `--check` report the COMMITTED
// file as stale, which invited regenerating and committing the degraded notice.
describe("stale-install detection", () => {
  test("flags report records whose package directory is not on disk", () => {
    const root = tempRoot();
    const present = packageDir(root, "present", "1.0.0", "MIT License");

    const missing = findUnmaterializedRecords([
      { name: "present", version: "1.0.0", packagePath: present },
      { name: "absent", version: "2.0.0", packagePath: join(root, "absent@2.0.0") },
      { name: "no-path", version: "3.0.0", packagePath: undefined },
    ]);

    expect(missing.map((record) => record.name)).toEqual(["absent", "no-path"]);
  });

  test("supplemental records are exempt — they never have an installed path", () => {
    expect(
      findUnmaterializedRecords([
        { name: "FFmpeg", version: BUNDLED_FFMPEG_VERSION, packagePath: undefined, supplemental: true },
      ]),
    ).toEqual([]);
  });

  test("throws instead of emitting placeholder text when a package is unmaterialized", () => {
    const root = tempRoot();

    let thrown;
    try {
      buildThirdPartyLicenseNotice({
        productionReport: report({
          MIT: [
            // Path is reported by pnpm but was never materialized.
            { name: "ghost", version: "1.0.0", packagePath: join(root, "ghost@1.0.0") },
          ],
        }),
        allReport: {},
        supplementalRecords: [],
        weakCopyleftBinaries: [],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe(STALE_INSTALL_CODE);
    expect(thrown.message).toContain("ghost@1.0.0");
    expect(thrown.message).toContain("node_modules is out of sync with pnpm-lock.yaml");
    // The misdiagnosis that caused the original incident.
    expect(thrown.message).toContain("Do NOT run `pnpm licenses:generate`");
  });

  test("reports a stale install even when sharp itself is the drifted package", () => {
    // Regression for an ordering bug: version resolution reads sharp's manifest
    // off disk, so when it ran first a drifted sharp produced "cannot resolve
    // sharpDarwinArm64" — blaming sharp instead of the install, with no
    // STALE_INSTALL_CODE, which meant runCli rethrew it as a raw stack trace.
    // This call shape matches generateNotice(): no supplemental/version pins.
    const root = tempRoot();

    let thrown;
    try {
      buildThirdPartyLicenseNotice({
        productionReport: report({
          "Apache-2.0": [
            { name: "sharp", version: "0.35.3", packagePath: join(root, "sharp@0.35.3") },
          ],
        }),
        allReport: {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe(STALE_INSTALL_CODE);
    expect(thrown.message).toContain("sharp@0.35.3");
    expect(thrown.message).toContain("Run `pnpm install` and retry");
  });

  test("builds end-to-end through the default path generateNotice() uses", () => {
    // No supplemental/weak-copyleft/version arguments — the shape the CLI runs,
    // which every other test short-circuits via `??`.
    const root = tempRoot();
    const sharp = packageDir(root, "sharp", "0.35.3", "Apache License 2.0", {
      license: "Apache-2.0",
      optionalDependencies: {
        "@img/sharp-darwin-arm64": "0.35.3",
        "@img/sharp-libvips-darwin-arm64": "1.3.2",
      },
    });

    const output = buildThirdPartyLicenseNotice({
      productionReport: report({
        "Apache-2.0": [{ name: "sharp", version: "0.35.3", packagePath: sharp }],
      }),
      allReport: {},
    });

    // Derived supplemental records and the weak-copyleft section both present.
    expect(output).toContain("@img/sharp-darwin-arm64@0.35.3");
    expect(output).toContain("@img/sharp-libvips-darwin-arm64@1.3.2");
    expect(output).toContain("Full License Texts — Weak-Copyleft Bundled Binaries");
    expect(output).toContain(`FFmpeg@${BUNDLED_FFMPEG_VERSION}`);
    expect(output).not.toContain("@undefined");
  });
});

// Regression: the macOS arm64 native sharp packages are optional deps, so they
// are invisible to `--no-optional` on macOS and absent entirely on Linux CI.
// They were hardcoded, so a sharp bump left the shipped notice claiming
// @img/sharp-darwin-arm64@0.34.5 and libvips@1.2.4 while 0.35.3 / 1.3.2 shipped,
// and no platform could detect it.
describe("resolveMacArm64Versions", () => {
  test("derives versions from the installed sharp manifest", () => {
    const root = tempRoot();
    const sharp = packageDir(root, "sharp", "0.35.3", "Apache License", {
      license: "Apache-2.0",
      optionalDependencies: {
        "@img/sharp-darwin-arm64": "0.35.3",
        "@img/sharp-libvips-darwin-arm64": "1.3.2",
        "@img/sharp-linux-x64": "0.35.3",
      },
    });

    expect(
      resolveMacArm64Versions([{ name: "sharp", version: "0.35.3", packagePath: sharp }]),
    ).toEqual({ sharpDarwinArm64: "0.35.3", libvipsDarwinArm64: "1.3.2" });
  });

  test("the emitted notice tracks sharp's manifest rather than a hardcoded pin", () => {
    const root = tempRoot();
    const sharp = packageDir(root, "sharp", "1.2.3", "Apache License", {
      license: "Apache-2.0",
      optionalDependencies: {
        "@img/sharp-darwin-arm64": "1.2.3",
        "@img/sharp-libvips-darwin-arm64": "4.5.6",
      },
    });

    const output = buildThirdPartyLicenseNotice({
      productionReport: report({
        "Apache-2.0": [{ name: "sharp", version: "1.2.3", packagePath: sharp }],
      }),
      allReport: {},
    });

    expect(output).toContain("@img/sharp-darwin-arm64@1.2.3");
    expect(output).toContain("@img/sharp-libvips-darwin-arm64@4.5.6");
    // The record's own version (1.2.3) must not leak in as the libvips version.
    expect(output).not.toContain("@img/sharp-libvips-darwin-arm64@1.2.3");
  });

  test("rejects a semver range — the notice must never claim a version that was never shipped", () => {
    const root = tempRoot();
    const sharp = packageDir(root, "sharp", "0.35.3", "Apache License", {
      license: "Apache-2.0",
      optionalDependencies: {
        "@img/sharp-darwin-arm64": "^0.36.0",
        "@img/sharp-libvips-darwin-arm64": "1.3.2",
      },
    });

    expect(() =>
      resolveMacArm64Versions([{ name: "sharp", version: "0.35.3", packagePath: sharp }]),
    ).toThrow(/version range rather than an exact version/);
  });

  test("refuses to guess when more than one sharp version resolves", () => {
    const root = tempRoot();
    const opts = {
      license: "Apache-2.0",
      optionalDependencies: {
        "@img/sharp-darwin-arm64": "0.35.3",
        "@img/sharp-libvips-darwin-arm64": "1.3.2",
      },
    };

    expect(() =>
      resolveMacArm64Versions([
        { name: "sharp", version: "0.35.3", packagePath: packageDir(root, "sharp", "0.35.3", "A", opts) },
        { name: "sharp", version: "0.33.1", packagePath: packageDir(root, "sharp", "0.33.1", "A", opts) },
      ]),
    ).toThrow(/2 sharp versions resolved/);
  });

  test("validates caller-supplied versions instead of trusting them", () => {
    // The `??` default must not become a way to inject an unvalidated version:
    // a partial object previously emitted "@undefined" into the notice.
    expect(() =>
      buildThirdPartyLicenseNotice({
        productionReport: {},
        allReport: {},
        macArm64Versions: { sharpDarwinArm64: "1.2.3" },
      }),
    ).toThrow(/libvipsDarwinArm64/);
  });

  test("accepts caller-supplied supplemental records without a hand-set flag", () => {
    // Regression: the exemption used to be stamped only inside the factory, so
    // a hand-built supplemental record was rejected as an unmaterialized package.
    const output = buildThirdPartyLicenseNotice({
      productionReport: {},
      allReport: {},
      supplementalRecords: [
        {
          name: "SomeBundledBinary",
          version: "1.0.0",
          declaredLicense: "MIT",
          source: "https://example.test/bin",
          licenseText: "MIT License\n\nBundled binary.",
        },
      ],
      weakCopyleftBinaries: [],
    });

    expect(output).toContain("SomeBundledBinary@1.0.0");
  });

  test("throws when sharp is missing or declares no darwin-arm64 optional deps", () => {
    const root = tempRoot();
    const sharp = packageDir(root, "sharp", "0.35.3", "Apache License", {
      license: "Apache-2.0",
      optionalDependencies: { "@img/sharp-linux-x64": "0.35.3" },
    });

    expect(() => resolveMacArm64Versions([])).toThrow(/no `sharp` record/);
    expect(() =>
      resolveMacArm64Versions([{ name: "sharp", version: "0.35.3", packagePath: sharp }]),
    ).toThrow(/sharpDarwinArm64/);
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
