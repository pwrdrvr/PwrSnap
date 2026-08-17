import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildThirdPartyLicenseNotice,
  declaredLicenseFallbackText,
  findUnmaterializedRecords,
  locateShippedPlatformPackages,
  resolvePackageDirFrom,
  SHIPPED_PLATFORM_PACKAGES,
  STALE_INSTALL_CODE,
} from "../generate-third-party-licenses.mjs";
import { checkPackageLicensePolicy } from "../check-package-license-policy.mjs";

// Nothing here may hardcode a shipping version. The real ones are read from the
// installed packages, so a test that pins 0.35.3 would keep passing after a
// sharp bump — exactly the drift that let the notice claim
// @img/sharp-darwin-arm64@0.34.5 while 0.35.3 shipped.
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

/**
 * Build a pnpm-shaped tree: sharp and its @img slices are SIBLINGS inside one
 * `node_modules`, which is what the upward node_modules walk has to traverse.
 * Returns sharp's package directory.
 */
function sharpTree(root, { version = "0.35.3", slices = [] }) {
  const nodeModules = join(root, "node_modules");
  const sharpDir = join(nodeModules, "sharp");
  mkdirSync(sharpDir, { recursive: true });
  writeFileSync(
    join(sharpDir, "package.json"),
    JSON.stringify(
      {
        name: "sharp",
        version,
        license: "Apache-2.0",
        optionalDependencies: Object.fromEntries(
          slices.map((slice) => [slice.name, slice.pin ?? slice.version]),
        ),
      },
      null,
      2,
    ),
  );
  for (const slice of slices) {
    const dir = join(nodeModules, slice.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: slice.name,
          version: slice.version,
          license: slice.license,
          description: slice.description,
        },
        null,
        2,
      ),
    );
    if (slice.licenseText !== undefined) {
      writeFileSync(join(dir, "LICENSE"), slice.licenseText);
    }
  }
  return sharpDir;
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

// Zero out everything the notice would otherwise read off disk, for tests that
// only care about the report-derived records.
const NO_BUNDLED = {
  platformPackageRecords: [],
  bundledBinaryRecords: [],
  weakCopyleftBinaries: [],
};

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
      ...NO_BUNDLED,
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
      ...NO_BUNDLED,
    });

    expect(output).toContain("Bundled Asset Notes");
    expect(output).toContain("Geist Sans and Geist Mono webfont assets");
    expect(output).toContain("OFL-1.1");
    expect(output).toContain("@fontsource/geist-sans@5.2.5");
    expect(output).toContain("@fontsource/geist-mono@5.2.7");
    expect(output).toContain("SIL OPEN FONT LICENSE Version 1.1");
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

  test("bundled-binary records are exempt — they are not npm packages", () => {
    expect(
      findUnmaterializedRecords([
        { name: "FFmpeg", version: "8.1.1", packagePath: undefined, bundledBinary: true },
      ]),
    ).toEqual([]);
  });

  test("shipped platform packages are NOT exempt from the materialization check", () => {
    // They are read from disk like any other package, so a slice that vanished
    // must trip the same guard rather than quietly dropping out of the notice.
    const root = tempRoot();
    const missing = findUnmaterializedRecords([
      {
        name: "@img/sharp-win32-x64",
        version: "0.35.3",
        packagePath: join(root, "gone"),
        shippedIn: "Windows x64 installer",
      },
    ]);

    expect(missing.map((record) => record.name)).toEqual(["@img/sharp-win32-x64"]);
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
        ...NO_BUNDLED,
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
    // Regression for an ordering bug: locating the platform slices reads sharp's
    // installed directory, so when it ran first a drifted sharp produced
    // "@img/sharp-darwin-arm64 is not installed" — blaming supportedArchitectures
    // instead of the install, with no STALE_INSTALL_CODE, which meant runCli
    // rethrew it as a raw stack trace. This call shape matches generateNotice():
    // no platform/bundled-binary overrides.
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
});

// The shipped native slices are optional dependencies: `--no-optional` hides
// them entirely and `--prod` reports only the slice matching the machine that
// ran the listing. They used to be hardcoded, so a sharp bump left the shipped
// notice claiming @img/sharp-darwin-arm64@0.34.5 and libvips@1.2.4 while 0.35.3
// / 1.3.2 shipped, and no platform could detect it. They are now read off disk.
describe("locateShippedPlatformPackages", () => {
  const SLICES = [
    {
      name: "@img/sharp-darwin-arm64",
      version: "0.35.3",
      license: "Apache-2.0",
      description: "Prebuilt sharp for macOS arm64",
      licenseText: "Apache License 2.0 — real text on disk",
    },
    {
      name: "@img/sharp-win32-x64",
      version: "0.35.3",
      license: "Apache-2.0 AND LGPL-3.0-or-later",
      description: "Prebuilt sharp for Windows x64",
      licenseText: "Apache License 2.0 — real text on disk",
    },
  ];
  const SHIPPED = [
    { name: "@img/sharp-darwin-arm64", shippedIn: "macOS universal build (arm64 slice)" },
    {
      name: "@img/sharp-win32-x64",
      shippedIn: "Windows x64 installer",
      lgpl: {
        library: "libvips and libvips-cpp",
        form: "separate dynamic libraries (DLLs) loaded at runtime",
        sourceRepo: "https://github.com/lovell/sharp-libvips",
      },
    },
  ];

  function locate(root, slices = SLICES, shipped = SHIPPED) {
    const sharpDir = sharpTree(root, { slices });
    return locateShippedPlatformPackages(
      [{ name: "sharp", version: "0.35.3", packagePath: sharpDir }],
      shipped,
    );
  }

  test("resolves each slice through the node_modules walk from sharp", () => {
    const root = tempRoot();
    expect(resolvePackageDirFrom(join(root, "node_modules", "sharp"), "@img/nope")).toBeUndefined();

    const located = locate(root);
    expect(located.map((record) => record.name)).toEqual([
      "@img/sharp-darwin-arm64",
      "@img/sharp-win32-x64",
    ]);
  });

  test("reads version, license and description from each package's own manifest", () => {
    const located = locate(tempRoot());

    expect(located[0]).toMatchObject({
      version: "0.35.3",
      declaredLicense: "Apache-2.0",
      description: "Prebuilt sharp for macOS arm64",
      shippedIn: "macOS universal build (arm64 slice)",
    });
    expect(located[1].declaredLicense).toBe("Apache-2.0 AND LGPL-3.0-or-later");
  });

  test("tracks the installed version rather than a hardcoded pin", () => {
    const root = tempRoot();
    const located = locate(
      root,
      SLICES.map((slice) => ({ ...slice, version: "9.9.9" })),
    );

    expect(located.every((record) => record.version === "9.9.9")).toBe(true);
  });

  test("throws — never placeholders — when a shipped slice is not installed", () => {
    const root = tempRoot();

    expect(() => locate(root, [SLICES[0]])).toThrow(
      /@img\/sharp-win32-x64 is not installed anywhere reachable/,
    );
    expect(() => locate(root, [SLICES[0]])).toThrow(/supportedArchitectures/);
    expect(() => locate(root, [SLICES[0]])).toThrow(
      /Refusing to emit a notice that omits a shipped package/,
    );
  });

  test("throws when the installed slice disagrees with the version sharp pins", () => {
    // release.mjs copies the pinned version into the packaged app, so a
    // disagreement means the notice would name a version that never shipped.
    const root = tempRoot();

    expect(() =>
      locate(
        root,
        SLICES.map((slice) => ({ ...slice, pin: "0.35.4" })),
      ),
    ).toThrow(/resolves to 0\.35\.3 on disk, but sharp@0\.35\.3 pins 0\.35\.4/);
  });

  test("refuses to guess when more than one sharp version resolves", () => {
    const root = tempRoot();
    const sharpDir = sharpTree(root, { slices: SLICES });

    expect(() =>
      locateShippedPlatformPackages(
        [
          { name: "sharp", version: "0.35.3", packagePath: sharpDir },
          { name: "sharp", version: "0.33.1", packagePath: sharpDir },
        ],
        SHIPPED,
      ),
    ).toThrow(/2 sharp versions resolved/);
  });

  test("throws when sharp is absent from the production report", () => {
    expect(() => locateShippedPlatformPackages([], SHIPPED)).toThrow(/no `sharp` record/);
  });

  test("the shipped set covers both macOS arches and Windows x64, and no Linux", () => {
    // electron-builder.yml ships a universal macOS dmg/zip and an x64 Windows
    // nsis. Linux is a build gate only — there is no `linux:` block — so a Linux
    // slice appearing here would be claiming something PwrSnap does not
    // distribute.
    const names = SHIPPED_PLATFORM_PACKAGES.map((entry) => entry.name);

    expect(names).toContain("@img/sharp-darwin-arm64");
    expect(names).toContain("@img/sharp-darwin-x64");
    expect(names).toContain("@img/sharp-libvips-darwin-arm64");
    expect(names).toContain("@img/sharp-libvips-darwin-x64");
    expect(names).toContain("@img/sharp-win32-x64");
    expect(names.filter((name) => name.includes("linux"))).toEqual([]);
  });
});

describe("weak-copyleft disclosure", () => {
  // Real shipped shape: two Darwin libvips slices carrying the dylib, plus the
  // Windows slice that carries the libvips DLLs inside the same package.
  const SLICES = [
    {
      name: "@img/sharp-libvips-darwin-arm64",
      version: "1.3.2",
      license: "LGPL-3.0-or-later",
      description: "Prebuilt libvips for macOS arm64",
      // Deliberately no LICENSE file — these packages genuinely ship none.
    },
    {
      name: "@img/sharp-libvips-darwin-x64",
      version: "1.3.2",
      license: "LGPL-3.0-or-later",
      description: "Prebuilt libvips for macOS x64",
    },
    {
      name: "@img/sharp-win32-x64",
      version: "0.35.3",
      license: "Apache-2.0 AND LGPL-3.0-or-later",
      description: "Prebuilt sharp for Windows x64",
      licenseText: "Apache License\nVersion 2.0, January 2004",
    },
  ];
  const LGPL = {
    library: "libvips-cpp",
    form: "a dynamic library loaded at runtime",
    sourceRepo: "https://github.com/lovell/sharp-libvips",
  };
  const SHIPPED = [
    {
      name: "@img/sharp-libvips-darwin-arm64",
      shippedIn: "macOS universal build (arm64 slice)",
      lgpl: LGPL,
    },
    {
      name: "@img/sharp-libvips-darwin-x64",
      shippedIn: "macOS universal build (x64 slice)",
      lgpl: LGPL,
    },
    {
      name: "@img/sharp-win32-x64",
      shippedIn: "Windows x64 installer",
      lgpl: { ...LGPL, library: "libvips and libvips-cpp" },
    },
  ];

  function notice() {
    const root = tempRoot();
    const sharpDir = sharpTree(root, { slices: SLICES });
    const platformPackageRecords = locateShippedPlatformPackages(
      [{ name: "sharp", version: "0.35.3", packagePath: sharpDir }],
      SHIPPED,
    );
    return buildThirdPartyLicenseNotice({
      productionReport: {},
      allReport: {},
      platformPackageRecords,
    });
  }

  test("appends full canonical LGPL texts and relink offers for every shipped copyleft binary", () => {
    const output = notice();

    expect(output).toContain("Full License Texts — Weak-Copyleft Bundled Binaries");
    // Full canonical FSF texts, identified by their unmistakable version lines.
    expect(output).toContain("Version 2.1, February 1999");
    expect(output).toContain("Version 3, 29 June 2007");
    expect(output).toContain("Relinking / source offer");
    expect(output).toContain("three years from the date of distribution");
  });

  test("the relink / source offer names every shipped LGPL library", () => {
    const output = notice();
    const section = output.slice(output.lastIndexOf("Full License Texts — Weak-Copyleft"));

    for (const name of [
      "FFmpeg@8.1.1",
      "@img/sharp-libvips-darwin-arm64@1.3.2",
      "@img/sharp-libvips-darwin-x64@1.3.2",
      "@img/sharp-win32-x64@0.35.3",
    ]) {
      expect(section).toContain(name);
    }
  });

  test("emits each canonical license text once, with an Applies-to roster", () => {
    // Three slices share LGPL-3.0. Repeating the full FSF text per binary would
    // triple a multi-thousand-line block for no legal benefit.
    const output = notice();

    expect(output.match(/Version 3, 29 June 2007/g)).toHaveLength(1);
    expect(output.match(/Version 2\.1, February 1999/g)).toHaveLength(1);
    expect(output).toContain("GNU LESSER GENERAL PUBLIC LICENSE, Version 3:");
  });

  test("a dual-licensed slice's partial license file is never left standing alone", () => {
    // @img/sharp-win32-x64 declares "Apache-2.0 AND LGPL-3.0-or-later" because
    // it bundles the libvips DLLs, but ships only the Apache-2.0 text. Emitting
    // that text with no pointer would under-disclose the LGPL half.
    const output = notice();

    expect(output).toContain("@img/sharp-win32-x64@0.35.3 (Apache-2.0 AND LGPL-3.0-or-later)");
    expect(output).toContain(
      "@img/sharp-win32-x64 ships libvips and libvips-cpp under the GNU Lesser General Public License,",
    );
  });

  test("libvips slices ship no license file, so the notice says so and points at the LGPL text", () => {
    const output = notice();

    // Truthful: these packages really do ship no license file.
    expect(output).toContain(
      "No license text file was found in the installed package for @img/sharp-libvips-darwin-x64@1.3.2.",
    );
    // But never left as the whole story.
    expect(output).toContain(
      "@img/sharp-libvips-darwin-x64 ships libvips-cpp under the GNU Lesser General Public License,",
    );
  });

  test("the shipped-platform roster in Bundled Asset Notes is derived, not narrated", () => {
    const output = notice();

    expect(output).toContain(
      "- @img/sharp-win32-x64@0.35.3 (Apache-2.0 AND LGPL-3.0-or-later) — Windows x64 installer",
    );
    expect(output).toContain("identical on every platform including Linux CI");
  });

  test("builds end-to-end through the default path generateNotice() uses", () => {
    // No platform/bundled-binary/weak-copyleft arguments — the shape the CLI
    // runs, which every other test short-circuits.
    const root = tempRoot();
    const sharpDir = sharpTree(root, { slices: SLICES });
    const output = buildThirdPartyLicenseNotice({
      productionReport: report({
        "Apache-2.0": [{ name: "sharp", version: "0.35.3", packagePath: sharpDir }],
      }),
      allReport: {},
      platformPackageRecords: locateShippedPlatformPackages(
        [{ name: "sharp", version: "0.35.3", packagePath: sharpDir }],
        SHIPPED,
      ),
    });

    expect(output).toContain("Full License Texts — Weak-Copyleft Bundled Binaries");
    expect(output).toContain("FFmpeg@8.1.1");
    expect(output).not.toContain("@undefined");
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
