import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BUNDLED_FFMPEG,
  buildThirdPartyLicenseNotice,
  compareStrings,
  declaredLicenseFallbackText,
  describeNoticeDrift,
  findUnmaterializedRecords,
  generateNotice,
  lgplFamilyOf,
  locateShippedPlatformPackages,
  npmPackageUrl,
  NOTICE_PACKAGE_NAME,
  NOTICE_PNPM_ARGS,
  NOTICE_PNPM_FILTER,
  resolvePackageDirFrom,
  SHIPPED_PACKAGE_CODE,
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
function writeManifest(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
}

/**
 * Build a pnpm-shaped tree. Slices default to living beside `sharp` in one
 * `node_modules` (what the upward walk traverses); a slice with `parent` is
 * instead placed inside THAT package's own `node_modules`, mirroring how pnpm
 * gives each @img binding its own libvips copy. Returns sharp's directory.
 */
function sharpTree(root, { version = "0.35.3", slices = [] }) {
  const nodeModules = join(root, "node_modules");
  const sharpDir = join(nodeModules, "sharp");
  const dirOf = new Map([["sharp", sharpDir]]);
  const pinsFor = (owner) =>
    Object.fromEntries(
      slices
        .filter((slice) => (slice.parent ?? "sharp") === owner)
        .map((slice) => [slice.name, slice.pin ?? slice.version]),
    );

  writeManifest(sharpDir, {
    name: "sharp",
    version,
    license: "Apache-2.0",
    optionalDependencies: pinsFor("sharp"),
  });

  for (const slice of slices) {
    const parent = slice.parent ?? "sharp";
    const parentDir = dirOf.get(parent);
    if (parentDir === undefined) {
      throw new Error(`fixture slice ${slice.name} lists parent ${parent} before it is defined`);
    }
    // Siblings of the parent for sharp-owned slices; nested under the parent
    // otherwise — both are shapes the node_modules walk must handle.
    const dir =
      parent === "sharp"
        ? join(nodeModules, slice.name)
        : join(parentDir, "node_modules", slice.name);
    writeManifest(dir, {
      name: slice.name,
      version: slice.version,
      license: slice.license,
      optionalDependencies: pinsFor(slice.name),
    });
    dirOf.set(slice.name, dir);
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
  const APACHE = "Apache License 2.0 — real text on disk";
  const SLICES = [
    {
      name: "@img/sharp-darwin-arm64",
      version: "0.35.3",
      license: "Apache-2.0",
      licenseText: APACHE,
    },
    {
      name: "@img/sharp-win32-x64",
      version: "0.35.3",
      license: "Apache-2.0 AND LGPL-3.0-or-later",
      licenseText: APACHE,
    },
  ];
  const WIN32_LGPL = {
    library: "libvips and libvips-cpp",
    form: "separate dynamic libraries (DLLs) loaded at runtime",
    sourceRepo: "https://github.com/lovell/sharp-libvips",
  };
  const SHIPPED = [
    { name: "@img/sharp-darwin-arm64", shippedIn: "macOS universal build (arm64 slice)" },
    { name: "@img/sharp-win32-x64", shippedIn: "Windows x64 installer", lgpl: WIN32_LGPL },
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
      shippedIn: "macOS universal build (arm64 slice)",
    });
    expect(located[1].declaredLicense).toBe("Apache-2.0 AND LGPL-3.0-or-later");
  });

  test("tracks the installed version rather than a hardcoded pin", () => {
    const located = locate(
      tempRoot(),
      SLICES.map((slice) => ({ ...slice, version: "9.9.9" })),
    );

    expect(located.every((record) => record.version === "9.9.9")).toBe(true);
  });

  test("resolves a slice from its own parent, not from sharp", () => {
    // sharp never loads the libvips packages — each @img/sharp-<platform>
    // binding does, and pnpm materializes a separate copy under that binding.
    // Resolving from sharp would validate a copy the artifact never ships.
    const root = tempRoot();
    const located = locateShippedPlatformPackages(
      [
        {
          name: "sharp",
          version: "0.35.3",
          packagePath: sharpTree(root, {
            slices: [
              ...SLICES,
              // Same name at two versions: sharp's copy, and the binding's own.
              { name: "@img/sharp-libvips-darwin-arm64", version: "1.0.0", license: "LGPL-3.0-or-later" },
              {
                name: "@img/sharp-libvips-darwin-arm64",
                version: "1.3.2",
                license: "LGPL-3.0-or-later",
                parent: "@img/sharp-darwin-arm64",
              },
            ],
          }),
        },
      ],
      [
        ...SHIPPED,
        {
          name: "@img/sharp-libvips-darwin-arm64",
          resolveFrom: "@img/sharp-darwin-arm64",
          shippedIn: "macOS universal build (arm64 slice)",
          lgpl: {
            library: "libvips-cpp",
            form: "a dynamic library (dylib) loaded at runtime",
            sourceRepo: "https://github.com/lovell/sharp-libvips",
          },
        },
      ],
    );

    const libvips = located.find((record) => record.name === "@img/sharp-libvips-darwin-arm64");
    expect(libvips.version).toBe("1.3.2");
  });

  test("throws — never placeholders — when a shipped slice is not installed", () => {
    const root = tempRoot();
    let thrown;
    try {
      locate(root, [SLICES[0]]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown.message).toMatch(/@img\/sharp-win32-x64 is not installed anywhere reachable/);
    expect(thrown.message).toMatch(/supportedArchitectures/);
    expect(thrown.message).toMatch(/Refusing to emit a notice that omits a shipped package/);
    // Must carry a code, or runCli rethrows it as a raw stack trace and buries
    // the remediation — the misdiagnosis mode PR #426 fixed.
    expect(thrown.code).toBe(SHIPPED_PACKAGE_CODE);
  });

  test("the node_modules walk stops at the repo root", () => {
    // Unbounded, the walk escapes to / and can adopt a stray ~/node_modules or
    // /node_modules copy, publishing a foreign package's LICENSE as PwrSnap's.
    const root = tempRoot();
    const outside = join(root, "outside");
    writeManifest(join(outside, "node_modules", "@img/stray"), {
      name: "@img/stray",
      version: "1.0.0",
      license: "MIT",
    });
    const inner = join(outside, "workspace", "node_modules", "sharp");
    mkdirSync(inner, { recursive: true });

    expect(resolvePackageDirFrom(inner, "@img/stray", outside)).toContain("outside");
    expect(resolvePackageDirFrom(inner, "@img/stray", join(outside, "workspace"))).toBeUndefined();
    // And with the DEFAULT boundary (the repo root), a walk rooted in a temp
    // tree must find nothing at all rather than running to the filesystem root.
    expect(resolvePackageDirFrom(inner, "@img/stray")).toBeUndefined();
    // A walk rooted outside the boundary must not search at all — bounding only
    // the upper end would still let it run to the filesystem root.
    expect(
      resolvePackageDirFrom(inner, "@img/stray", join(outside, "unrelated")),
    ).toBeUndefined();
  });

  test("throws when the installed slice disagrees with the version its parent pins", () => {
    // release.mjs copies the pinned version into the packaged app, so a
    // disagreement means the notice would name a version that never shipped.
    expect(() =>
      locate(
        tempRoot(),
        SLICES.map((slice) => ({ ...slice, pin: "0.35.4" })),
      ),
    ).toThrow(/resolves to 0\.35\.3 on disk, but sharp pins 0\.35\.4/);
  });

  test("refuses to guess when sharp resolves to more than one install", () => {
    // Distinct PATHS are the hazard, not just distinct versions: two installs of
    // one version under different peer sets resolve different dependency trees.
    const root = tempRoot();
    const a = sharpTree(root, { slices: SLICES });
    const b = sharpTree(join(root, "second"), { slices: SLICES });

    expect(() =>
      locateShippedPlatformPackages(
        [
          { name: "sharp", version: "0.35.3", packagePath: a },
          { name: "sharp", version: "0.35.3", packagePath: b },
        ],
        SHIPPED,
      ),
    ).toThrow(/2 sharp installs resolved/);
  });

  test("throws when sharp is absent from the production report", () => {
    expect(() => locateShippedPlatformPackages([], SHIPPED)).toThrow(/no `sharp` record/);
  });

  test("rejects a slice whose declared license has an LGPL component but no lgpl descriptor", () => {
    // The disclosure must follow the declared license, not a hand-set key.
    // Dropping `lgpl:` previously removed the FSF text and the written source
    // offer for a shipped copyleft binary with every test still green.
    const root = tempRoot();
    let thrown;
    try {
      locate(root, SLICES, [
        SHIPPED[0],
        { name: "@img/sharp-win32-x64", shippedIn: "Windows x64 installer" },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown.message).toMatch(/contains an LGPL component/);
    expect(thrown.message).toMatch(/no `lgpl` descriptor/);
    expect(thrown.code).toBe(SHIPPED_PACKAGE_CODE);
  });

  test("rejects an lgpl descriptor on a package that declares no LGPL component", () => {
    expect(() =>
      locate(tempRoot(), SLICES, [
        { ...SHIPPED[0], lgpl: WIN32_LGPL },
        SHIPPED[1],
      ]),
    ).toThrow(/names no LGPL component/);
  });

  test("rejects a manifest with no version or no license", () => {
    const root = tempRoot();
    expect(() =>
      locate(root, [{ ...SLICES[0], version: "" }, SLICES[1]]),
    ).toThrow(/has no version in its manifest/);

    expect(() =>
      locate(tempRoot(), [{ ...SLICES[0], license: "" }, SLICES[1]]),
    ).toThrow(/declares no license in its manifest/);
  });

  test("lgplFamilyOf reads the LGPL component out of a compound SPDX expression", () => {
    expect(lgplFamilyOf("Apache-2.0 AND LGPL-3.0-or-later")).toBe("LGPL-3.0");
    expect(lgplFamilyOf("LGPL-2.1-or-later")).toBe("LGPL-2.1");
    expect(lgplFamilyOf("Apache-2.0")).toBeUndefined();
    expect(lgplFamilyOf(undefined)).toBeUndefined();
  });

  test("the shipped set is exactly the packages the release artifacts bundle", () => {
    // electron-builder.yml ships a universal macOS dmg/zip and an x64 Windows
    // nsis. An exact-set assertion, because a one-directional `toContain` check
    // cannot catch an ADDED entry — and over-claiming makes the notice assert
    // PwrSnap distributes an artifact it does not. Linux is a build gate only
    // (no `linux:` block), so no Linux slice belongs here.
    expect(SHIPPED_PLATFORM_PACKAGES.map((entry) => entry.name)).toEqual([
      "@img/sharp-darwin-arm64",
      "@img/sharp-darwin-x64",
      "@img/sharp-libvips-darwin-arm64",
      "@img/sharp-libvips-darwin-x64",
      "@img/sharp-win32-x64",
    ]);
  });

  test("every entry's resolveFrom is declared before it", () => {
    const seen = new Set(["sharp"]);
    for (const entry of SHIPPED_PLATFORM_PACKAGES) {
      expect(seen).toContain(entry.resolveFrom ?? "sharp");
      seen.add(entry.name);
    }
  });
});

describe("deterministic output", () => {
  test("record ordering is code-unit, not locale-collated", () => {
    // localeCompare collates through ICU using the ambient LANG, which made the
    // emitted byte order machine-dependent: `--check` passed under LANG=C but
    // failed under et_EE.UTF-8 / cs_CZ.UTF-8 / lt_LT.UTF-8.
    expect(compareStrings("FFmpeg", "accepts")).toBeLessThan(0);
    expect("FFmpeg".localeCompare("accepts")).toBeGreaterThan(0);
    expect([..."zod,zwitch,tar,ståhl,Zip".split(",")].sort(compareStrings)).toEqual([
      "Zip",
      "ståhl",
      "tar",
      "zod",
      "zwitch",
    ]);
  });

  test("the pnpm selector keeps its `...` suffix", () => {
    // A bare `--filter @pwrsnap/desktop` selects that ONE project, so anything
    // reached through a workspace dependency ships but is never listed and
    // never license-checked. Dropping the three dots is a one-character edit
    // that leaves every other test in this file passing, so pin the string.
    expect(NOTICE_PNPM_FILTER).toBe("@pwrsnap/desktop...");
    expect(NOTICE_PACKAGE_NAME).toBe("@pwrsnap/desktop");
  });

  test("describeNoticeDrift names the packages that appeared or vanished", () => {
    const committed = ["- left-pad@1.0.0 | MIT", "- zod@4.0.0 | MIT"].join("\n");
    const generated = ["- right-pad@2.0.0 | MIT", "- zod@4.0.0 | MIT"].join("\n");

    const drift = describeNoticeDrift(committed, generated);
    expect(drift).toContain("only in the generated notice: right-pad@2.0.0");
    expect(drift).toContain("only in the committed notice: left-pad@1.0.0");
  });

  test("describeNoticeDrift falls back to the first differing line", () => {
    // Same package set, different text — a bare "out of date" here is exactly
    // the unactionable case this helper exists for.
    const committed = ["Scope", "- zod@4.0.0 | MIT"].join("\n");
    const generated = ["Scope", "- zod@4.0.0 | Apache-2.0"].join("\n");

    const drift = describeNoticeDrift(committed, generated);
    expect(drift).toContain("same package set; first difference at line 2");
    expect(drift).toContain("committed:  - zod@4.0.0 | MIT");
    expect(drift).toContain("generated:  - zod@4.0.0 | Apache-2.0");
  });

  test("generateNotice passes --no-optional on both listings", () => {
    // This is the determinism mechanism, not an optimization: with optional deps
    // included, `pnpm licenses list` reports only the HOST's platform slice.
    expect(NOTICE_PNPM_ARGS.production).toContain("--no-optional");
    expect(NOTICE_PNPM_ARGS.all).toContain("--no-optional");

    const calls = [];
    expect(() =>
      generateNotice((args) => {
        calls.push(args);
        return {};
      }),
    ).toThrow(/no `sharp` record/);
    expect(calls).toEqual([["--prod", "--no-optional"], ["--no-optional"]]);
  });

  test("npmPackageUrl keeps scoped names intact", () => {
    // encodeURIComponent left the slash percent-encoded, producing a 404 URL.
    expect(npmPackageUrl("@img/sharp-win32-x64")).toBe(
      "https://www.npmjs.com/package/@img/sharp-win32-x64",
    );
  });
});

describe("weak-copyleft disclosure", () => {
  // Real shipped shape: two Darwin libvips slices carrying the dylib, plus the
  // Windows slice that carries the libvips DLLs inside the same package.
  const SLICES = [
    {
      name: "@img/sharp-darwin-arm64",
      version: "0.35.3",
      license: "Apache-2.0",
      licenseText: "Apache License\nVersion 2.0, January 2004",
    },
    {
      name: "@img/sharp-libvips-darwin-arm64",
      version: "1.3.2",
      license: "LGPL-3.0-or-later",
      parent: "@img/sharp-darwin-arm64",
      // Deliberately no LICENSE file — these packages genuinely ship none.
    },
    {
      name: "@img/sharp-libvips-darwin-x64",
      version: "1.3.2",
      license: "LGPL-3.0-or-later",
    },
    {
      name: "@img/sharp-win32-x64",
      version: "0.35.3",
      license: "Apache-2.0 AND LGPL-3.0-or-later",
      licenseText: "Apache License\nVersion 2.0, January 2004",
    },
  ];
  const LGPL = {
    library: "libvips-cpp",
    form: "a dynamic library loaded at runtime",
    sourceRepo: "https://github.com/lovell/sharp-libvips",
  };
  const SHIPPED = [
    { name: "@img/sharp-darwin-arm64", shippedIn: "macOS universal build (arm64 slice)" },
    {
      name: "@img/sharp-libvips-darwin-arm64",
      resolveFrom: "@img/sharp-darwin-arm64",
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

  function platformRecords(slices = SLICES, shipped = SHIPPED) {
    const sharpDir = sharpTree(tempRoot(), { slices });
    return locateShippedPlatformPackages(
      [{ name: "sharp", version: "0.35.3", packagePath: sharpDir }],
      shipped,
    );
  }

  function notice(slices = SLICES, shipped = SHIPPED) {
    return buildThirdPartyLicenseNotice({
      productionReport: {},
      allReport: {},
      platformPackageRecords: platformRecords(slices, shipped),
    });
  }

  test("appends full canonical LGPL texts and relink offers for every shipped copyleft binary", () => {
    const output = notice();

    expect(output).toContain("Full License Texts — Weak-Copyleft Bundled Binaries");
    expect(output).toContain("Version 2.1, February 1999");
    expect(output).toContain("Version 3, 29 June 2007");
    expect(output).toContain("Relinking / source offer");
    expect(output).toContain("three years from the date of distribution");
  });

  test("the relink / source offer names every shipped LGPL library", () => {
    const section = notice().slice(
      notice().lastIndexOf("Full License Texts — Weak-Copyleft"),
    );

    for (const name of [
      `FFmpeg@${BUNDLED_FFMPEG.version}`,
      "@img/sharp-libvips-darwin-arm64@1.3.2",
      "@img/sharp-libvips-darwin-x64@1.3.2",
      "@img/sharp-win32-x64@0.35.3",
    ]) {
      expect(section).toContain(name);
    }
  });

  test("emits each canonical license text once, with an Applies-to roster", () => {
    const output = notice();

    expect(output.match(/Version 3, 29 June 2007/g)).toHaveLength(1);
    expect(output.match(/Version 2\.1, February 1999/g)).toHaveLength(1);
    expect(output).toContain("GNU LESSER GENERAL PUBLIC LICENSE, Version 3:");
  });

  test("the FFmpeg disclosure is platform-neutral — Windows ships it too", () => {
    // package-win.mjs hard-fails a --release build without a vetted LGPL
    // ffmpeg.exe, so scoping the written source offer to macOS would leave
    // Windows recipients uncovered by the offer inside their own installer.
    const output = notice();
    // Anchor inside the weak-copyleft section — the FFmpeg@<version> line also appears in
    // the Bundled Asset Notes summary sentence far above it.
    const section = output.slice(output.lastIndexOf("Full License Texts — Weak-Copyleft"));
    const start = section.indexOf(`\nFFmpeg@${BUNDLED_FFMPEG.version} (LGPL-2.1-or-later)\n~`);
    const ffmpegBlock = section.slice(start, section.indexOf("GNU LESSER", start));

    expect(output).toContain("PwrSnap bundles an FFmpeg executable");
    // The whole FFmpeg disclosure must name no single platform — scoping it
    // either way leaves the other artifact's recipients outside the offer.
    expect(ffmpegBlock).not.toMatch(/macOS|Windows|darwin|win32/i);
  });

  test("the emitted license id follows the manifest instead of a hardcoded LGPL-3.0", () => {
    // An upstream relicense must not leave this section asserting a version the
    // package's own manifest contradicts.
    const output = notice(
      SLICES.map((slice) =>
        slice.name === "@img/sharp-libvips-darwin-x64"
          ? { ...slice, license: "LGPL-2.1-or-later" }
          : slice,
      ),
    );

    expect(output).toContain("@img/sharp-libvips-darwin-x64@1.3.2 (LGPL-2.1-or-later)");
    expect(output).not.toContain("@img/sharp-libvips-darwin-x64@1.3.2 (LGPL-3.0-or-later)");
    // ...and it must be filed under the matching canonical text.
    const lgpl21 = output.slice(output.indexOf("GNU LESSER GENERAL PUBLIC LICENSE, Version 2.1:"));
    expect(lgpl21).toContain("@img/sharp-libvips-darwin-x64@1.3.2");
  });

  test("a compound-licensed slice's partial license file is never left standing alone", () => {
    const output = notice();

    expect(output).toContain("@img/sharp-win32-x64@0.35.3 (Apache-2.0 AND LGPL-3.0-or-later)");
    expect(output).toContain(
      "@img/sharp-win32-x64 ships libvips and libvips-cpp under the GNU Lesser General Public License,",
    );
    // The appended cross-reference is PwrSnap's, not the upstream file's.
    expect(output).toContain(
      "Representative file: @img/sharp-win32-x64@0.35.3/LICENSE + PwrSnap cross-reference",
    );
  });

  test("libvips slices ship no license file, so the notice says so and points at the LGPL text", () => {
    const output = notice();

    expect(output).toContain(
      "No license text file was found in the installed package for @img/sharp-libvips-darwin-x64@1.3.2.",
    );
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

  test("a platform record with a dead path throws instead of emitting a placeholder", () => {
    // The materialization guard must cover records merged after the report ones.
    // Previously it ran first, so a caller-supplied record with a dead path
    // silently produced "No license text file was found..." standing in for a
    // live copyleft slice's license.
    let thrown;
    try {
      buildThirdPartyLicenseNotice({
        productionReport: {},
        allReport: {},
        platformPackageRecords: [
          {
            name: "@img/sharp-libvips-darwin-arm64",
            version: "1.3.2",
            declaredLicense: "LGPL-3.0-or-later",
            shippedIn: "macOS universal build (arm64 slice)",
            packagePath: "/definitely/not/here",
            lgpl: LGPL,
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe(STALE_INSTALL_CODE);
    expect(thrown.message).toContain("@img/sharp-libvips-darwin-arm64@1.3.2");
  });

  test("caller-supplied platform records are validated, not trusted", () => {
    // The deleted validateMacArm64Versions covered the caller path on purpose;
    // without it a missing field rendered as `@undefined` in the Dependency
    // Summary or a bare `undefined` mid-sentence in the relink offer.
    const base = {
      name: "@img/sharp-win32-x64",
      version: "0.35.3",
      declaredLicense: "Apache-2.0",
      shippedIn: "Windows x64 installer",
      packagePath: undefined,
    };
    const build = (overrides) =>
      buildThirdPartyLicenseNotice({
        productionReport: {},
        allReport: {},
        platformPackageRecords: [{ ...base, ...overrides }],
      });

    expect(() => build({ version: undefined })).toThrow(/has no version/);
    expect(() => build({ shippedIn: undefined })).toThrow(/has no shippedIn/);
    expect(() => build({ declaredLicense: undefined })).toThrow(/has no declaredLicense/);
    expect(() => build({ version: "^0.36.0" })).toThrow(/not an exact version/);
  });

  test("builds end-to-end through the default path generateNotice() uses", () => {
    // No platform/bundled-binary/weak-copyleft arguments — the shape the CLI
    // runs. Every other test short-circuits this branch by passing records in.
    const root = tempRoot();
    const sharpDir = sharpTree(root, {
      slices: [
        { name: "@img/sharp-darwin-arm64", version: "0.35.3", license: "Apache-2.0", licenseText: "Apache" },
        { name: "@img/sharp-darwin-x64", version: "0.35.3", license: "Apache-2.0", licenseText: "Apache" },
        { name: "@img/sharp-libvips-darwin-arm64", version: "1.3.2", license: "LGPL-3.0-or-later", parent: "@img/sharp-darwin-arm64" },
        { name: "@img/sharp-libvips-darwin-x64", version: "1.3.2", license: "LGPL-3.0-or-later", parent: "@img/sharp-darwin-x64" },
        { name: "@img/sharp-win32-x64", version: "0.35.3", license: "Apache-2.0 AND LGPL-3.0-or-later", licenseText: "Apache" },
      ],
    });

    // Exercises SHIPPED_PLATFORM_PACKAGES itself, including each entry's
    // resolveFrom chain — the branch the CLI takes and no other test reaches.
    const output = buildThirdPartyLicenseNotice({
      productionReport: report({
        "Apache-2.0": [{ name: "sharp", version: "0.35.3", packagePath: sharpDir }],
      }),
      allReport: {},
    });

    for (const entry of SHIPPED_PLATFORM_PACKAGES) {
      expect(output).toContain(entry.name);
    }
    expect(output).toContain("Full License Texts — Weak-Copyleft Bundled Binaries");
    expect(output).toContain(`FFmpeg@${BUNDLED_FFMPEG.version}`);
    expect(output).not.toContain("@undefined");
    expect(output).not.toContain("— undefined");
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
