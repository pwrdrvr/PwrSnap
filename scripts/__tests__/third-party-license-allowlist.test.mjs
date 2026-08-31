import { describe, expect, test } from "vitest";
import {
  ALLOWED_LICENSE_IDS,
  ALLOWED_PLATFORM_COPYLEFT_IDS,
  checkNoticeDevDependencyLicenses,
  checkNpmDependencyLicenses,
  checkShippedPlatformLicenses,
  checkThirdPartyLicenseAllowlist,
  evaluateSpdxExpression,
  isPermissive,
  isStructuralToken,
  locatePlatformRecordsOrDefer,
  NOTICE_DEV_DEPENDENCIES,
  SpdxParseError,
  tokenizeSpdxExpression,
} from "../check-third-party-license-allowlist.mjs";
import {
  flattenLicenseReport,
  SHIPPED_PACKAGE_CODE,
  STALE_INSTALL_CODE,
  WEAK_COPYLEFT_LICENSE_TEXTS,
} from "../generate-third-party-licenses.mjs";

/**
 * Build records the way the CLI does — through the generator's own flattener,
 * so a change to the report shape breaks these tests rather than letting them
 * pass against a shape production never sees.
 */
function records(licenseToPackages) {
  const report = {};
  for (const [license, names] of Object.entries(licenseToPackages)) {
    report[license] = names.map((name) => ({ name, versions: ["1.0.0"], paths: ["/tmp/x"] }));
  }
  return flattenLicenseReport(report);
}

describe("SPDX evaluation", () => {
  const allow = (id) => id === "MIT" || id === "Apache-2.0" || id === "BSD-2-Clause";

  test("a bare allowed identifier passes and a bare disallowed one fails", () => {
    expect(evaluateSpdxExpression("MIT", allow)).toBe(true);
    expect(evaluateSpdxExpression("GPL-3.0", allow)).toBe(false);
  });

  test("OR is satisfied by either side, so a dual license passes on its good half", () => {
    // This is why WTFPL never needs allowlisting: "(MIT OR WTFPL)" lets us take
    // the MIT option. Collapsing OR to AND here would fail a real dependency.
    expect(evaluateSpdxExpression("(MIT OR WTFPL)", allow)).toBe(true);
    expect(evaluateSpdxExpression("(BSD-2-Clause OR MIT OR Apache-2.0)", allow)).toBe(true);
    expect(evaluateSpdxExpression("(GPL-3.0 OR AGPL-3.0)", allow)).toBe(false);
  });

  test("AND requires both sides, so a permissive half cannot launder a copyleft half", () => {
    expect(evaluateSpdxExpression("Apache-2.0 AND MIT", allow)).toBe(true);
    expect(evaluateSpdxExpression("Apache-2.0 AND GPL-3.0", allow)).toBe(false);
  });

  test("AND binds tighter than OR, per SPDX", () => {
    // MIT OR (Apache-2.0 AND GPL-3.0) is satisfiable; (MIT OR Apache-2.0) AND
    // GPL-3.0 is not. Getting the precedence backwards would accept the latter.
    expect(evaluateSpdxExpression("MIT OR Apache-2.0 AND GPL-3.0", allow)).toBe(true);
    expect(evaluateSpdxExpression("(MIT OR Apache-2.0) AND GPL-3.0", allow)).toBe(false);
  });

  test("operators are recognized case-insensitively", () => {
    expect(evaluateSpdxExpression("MIT or GPL-3.0", allow)).toBe(true);
    expect(evaluateSpdxExpression("MIT and GPL-3.0", allow)).toBe(false);
  });

  test("nested parentheses are handled", () => {
    expect(evaluateSpdxExpression("((MIT))", allow)).toBe(true);
    expect(evaluateSpdxExpression("(MIT OR (Apache-2.0 AND GPL-3.0))", allow)).toBe(true);
  });

  test("tokenizer splits parens that are flush against identifiers", () => {
    expect(tokenizeSpdxExpression("(MIT OR WTFPL)")).toEqual(["(", "MIT", "OR", "WTFPL", ")"]);
  });

  test("isStructuralToken is what both the parser and the reporter agree on", () => {
    // Sharing one predicate is the point: when they diverged, a failure message
    // could name "OR" as though it were a rejected license identifier.
    for (const token of ["(", ")", "OR", "AND", "or", "and"]) {
      expect(isStructuralToken(token), token).toBe(true);
    }
    for (const token of ["MIT", "GPL-3.0", "WITH"]) {
      expect(isStructuralToken(token), token).toBe(false);
    }
  });

  test("an unparseable expression throws rather than guessing", () => {
    // "SEE LICENSE IN ..." and a dangling operator must not silently evaluate
    // to true on some substring. For a legal gate, refusing to guess is the
    // safe direction.
    expect(() => evaluateSpdxExpression("MIT OR", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("(MIT", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("AND MIT", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("SEE LICENSE IN LICENSE.md", allow)).toThrow(
      SpdxParseError,
    );
  });

  test("a WITH exception throws instead of being read as its bare license", () => {
    // "MIT WITH <exception>" must not be accepted as plain MIT — the exception
    // is the part that changes the terms.
    expect(() => evaluateSpdxExpression("MIT WITH Classpath-exception-2.0", allow)).toThrow(
      SpdxParseError,
    );
  });

  test("an empty or whitespace-only license throws", () => {
    expect(() => evaluateSpdxExpression("", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("   ", allow)).toThrow(SpdxParseError);
  });
});

describe("case folding", () => {
  test("SPDX identifiers match case-insensitively, per the spec", () => {
    // A package declaring "license": "mit" is legal SPDX and exists in the
    // wild. Matching case-sensitively turned that into an unfixable red build.
    expect(isPermissive("MIT")).toBe(true);
    expect(isPermissive("mit")).toBe(true);
    expect(isPermissive("Apache-2.0")).toBe(true);
    expect(isPermissive("APACHE-2.0")).toBe(true);
  });

  test("folding case does not let a disallowed id through in any casing", () => {
    for (const id of ["GPL-3.0", "gpl-3.0", "Gpl-3.0", "AGPL-3.0", "agpl-3.0"]) {
      expect(isPermissive(id), id).toBe(false);
    }
  });

  test("a lowercase declaration passes the npm check end to end", () => {
    expect(checkNpmDependencyLicenses(records({ mit: ["lowercase-dep"] }))).toEqual([]);
  });
});

describe("npm dependency licenses", () => {
  test("passes the license set the tree actually declared when the gate was written", () => {
    expect(
      checkNpmDependencyLicenses(
        records({
          MIT: ["react"],
          "Apache-2.0": ["typescript"],
          ISC: ["semver"],
          "BSD-2-Clause": ["dotenv"],
          "BSD-3-Clause": ["source-map"],
          "BlueOak-1.0.0": ["jackspeak"],
          "OFL-1.1": ["@fontsource/geist-sans"],
          "Python-2.0": ["argparse"],
          "(MIT OR WTFPL)": ["expand-template"],
          "(BSD-2-Clause OR MIT OR Apache-2.0)": ["rc"],
        }),
      ),
    ).toEqual([]);
  });

  test("rejects a dependency that flipped from MIT to GPL", () => {
    // The scenario this gate exists for: the generator would happily transcribe
    // a new "GPL-3.0" section into THIRD_PARTY_LICENSES and `--check` would
    // then pass, because the committed file matches the generated one.
    const failures = checkNpmDependencyLicenses(records({ "GPL-3.0": ["some-dep"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/some-dep@1\.0\.0/);
    expect(failures[0]).toMatch(/GPL-3\.0/);
    expect(failures[0]).toMatch(/not on the allowlist/);
  });

  test("a copyleft failure warns against allowlisting it to go green", () => {
    const [failure] = checkNpmDependencyLicenses(records({ "AGPL-3.0-only": ["some-dep"] }));
    expect(failure).toMatch(/copyleft/);
    expect(failure).toMatch(/do not allowlist it to make CI green/);
  });

  test("the copyleft steer covers LGPL too, not just GPL and AGPL", () => {
    // The first pattern was anchored so that "LGPL-3.0-or-later" missed it, and
    // the reader lost the one line telling them not to allowlist their way out.
    const [failure] = checkNpmDependencyLicenses(records({ "LGPL-3.0-or-later": ["some-dep"] }));
    expect(failure).toMatch(/do not allowlist it to make CI green/);
  });

  test("rejects a transitive GPL dep dragged in by a bump", () => {
    const failures = checkNpmDependencyLicenses(
      records({ MIT: ["react", "hono"], "GPL-2.0-or-later": ["sneaky-transitive"] }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/sneaky-transitive/);
  });

  test("rejects weak copyleft on an ordinary npm dependency", () => {
    // LGPL is permitted only for a shipped platform slice carrying disclosure.
    // An npm dep arriving under it has no FSF text and no source offer.
    const failures = checkNpmDependencyLicenses(records({ "LGPL-3.0-or-later": ["some-dep"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/LGPL-3\.0-or-later/);
  });

  test("rejects an unresolvable license string", () => {
    const failures = checkNpmDependencyLicenses(
      records({ UNLICENSED: ["private-thing"], "SEE LICENSE IN LICENSE.md": ["vague-thing"] }),
    );
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toMatch(/private-thing/);
    expect(failures.join("\n")).toMatch(/not a parseable SPDX expression/);
  });

  test("names every offending dependency, not just the first", () => {
    const failures = checkNpmDependencyLicenses(records({ "GPL-3.0": ["one", "two"], MIT: ["ok"] }));
    expect(failures).toHaveLength(2);
  });
});

describe("shipped devDependencies", () => {
  test("Electron is gated even though --prod never reports it", () => {
    // Electron is a devDependency that ships, so the generator merges it in
    // from the `all` report. Reading only the production report left the single
    // largest shipped component with an unchecked license.
    expect(NOTICE_DEV_DEPENDENCIES.has("electron")).toBe(true);
    const failures = checkNoticeDevDependencyLicenses(records({ "GPL-3.0": ["electron"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/electron/);
  });

  test("a permissive Electron passes", () => {
    expect(checkNoticeDevDependencyLicenses(records({ MIT: ["electron"] }))).toEqual([]);
  });

  test("devDependencies the notice does not disclose are not gated", () => {
    // Dev-only tooling does not ship, so its license is out of scope; gating it
    // would turn an unrelated GPL dev tool into a failed build.
    expect(checkNoticeDevDependencyLicenses(records({ "GPL-3.0": ["some-dev-tool"] }))).toEqual([]);
  });
});

describe("shipped platform slices", () => {
  const PLATFORM = [
    { name: "@img/sharp-darwin-arm64" },
    { name: "@img/sharp-win32-x64", lgpl: { library: "libvips" } },
  ];

  test("permits weak copyleft on a slice that carries an lgpl descriptor", () => {
    expect(
      checkShippedPlatformLicenses(
        [
          {
            name: "@img/sharp-win32-x64",
            version: "0.35.3",
            declaredLicense: "Apache-2.0 AND LGPL-3.0-or-later",
          },
        ],
        PLATFORM,
      ),
    ).toEqual([]);
  });

  test("rejects weak copyleft on a slice with no lgpl descriptor", () => {
    // Mirrors the generator's own validatePlatformRecord guard from the other
    // side: such a record would ship copyleft with no FSF text and no offer.
    const failures = checkShippedPlatformLicenses(
      [
        {
          name: "@img/sharp-darwin-arm64",
          version: "0.35.3",
          declaredLicense: "LGPL-3.0-or-later",
        },
      ],
      PLATFORM,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no `lgpl` descriptor/);
  });

  test("rejects weak copyleft on a slice absent from the platform list entirely", () => {
    const failures = checkShippedPlatformLicenses(
      [{ name: "@img/sharp-linux-x64", version: "0.35.3", declaredLicense: "LGPL-3.0-or-later" }],
      PLATFORM,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no `lgpl` descriptor/);
  });

  test("rejects strong copyleft on a slice even when it carries a descriptor", () => {
    // lgplFamilyOf() does not match a bare "GPL-3.0", so before this gate a
    // hand-added GPL platform entry passed every existing check.
    const failures = checkShippedPlatformLicenses(
      [{ name: "@img/sharp-win32-x64", version: "0.35.3", declaredLicense: "GPL-3.0" }],
      PLATFORM,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/not permitted in a shipped artifact/);
    expect(failures[0]).toMatch(/do not allowlist it to make CI green/);
  });

  test("an empty platform list is not a failure", () => {
    expect(checkShippedPlatformLicenses([], PLATFORM)).toEqual([]);
  });
});

describe("stale-install deferral", () => {
  const staleError = () => Object.assign(new Error("not installed"), { code: STALE_INSTALL_CODE });
  const shippedError = () => Object.assign(new Error("bad entry"), { code: SHIPPED_PACKAGE_CODE });

  test("resolves platform records when the install is materialized", () => {
    const located = [{ name: "@img/sharp-win32-x64" }];
    expect(locatePlatformRecordsOrDefer([], () => located)).toEqual({
      records: located,
      deferred: false,
    });
  });

  test("defers on the generator's two install-drift codes", () => {
    // The generator reports both of these with a message pointing at
    // `pnpm install`; re-reporting them here would put a worse diagnostic in
    // front of a better one.
    for (const makeError of [staleError, shippedError]) {
      expect(
        locatePlatformRecordsOrDefer([], () => {
          throw makeError();
        }),
      ).toEqual({ records: [], deferred: true });
    }
  });

  test("rethrows anything that is not install drift", () => {
    // Swallowing an unknown failure would silently drop the platform surface
    // and still print a pass.
    expect(() =>
      locatePlatformRecordsOrDefer([], () => {
        throw new Error("something else entirely");
      }),
    ).toThrow(/something else entirely/);
  });
});

describe("allowlist contents", () => {
  test("no copyleft or source-available id is on the permissive allowlist", () => {
    for (const id of ALLOWED_LICENSE_IDS) {
      expect(id).not.toMatch(/GPL|SSPL|BUSL|Commons-Clause|Elastic|RSAL/i);
    }
  });

  test("every allowed platform copyleft id has canonical FSF text in the generator", () => {
    // An id allowed here but absent from WEAK_COPYLEFT_LICENSE_TEXTS would pass
    // this gate and then fail the notice build for want of a license text.
    for (const id of ALLOWED_PLATFORM_COPYLEFT_IDS) {
      const family = /^(LGPL-\d+\.\d+)/.exec(id)?.[1];
      expect(family, `${id} should name an LGPL family`).toBeDefined();
      expect(WEAK_COPYLEFT_LICENSE_TEXTS[family], `${id} has no canonical text`).toBeDefined();
    }
  });
});

describe("combined check", () => {
  test("reports npm, devDependency and platform failures together, sorted", () => {
    const failures = checkThirdPartyLicenseAllowlist({
      productionRecords: records({ "GPL-3.0": ["zzz-dep"] }),
      allRecords: records({ "GPL-3.0": ["electron"] }),
      platformRecords: [
        { name: "@img/sharp-win32-x64", version: "0.35.3", declaredLicense: "GPL-3.0" },
      ],
    });
    expect(failures).toHaveLength(3);
    expect(failures).toEqual([...failures].sort((a, b) => a.localeCompare(b)));
  });

  test("a clean tree produces no failures", () => {
    expect(
      checkThirdPartyLicenseAllowlist({
        productionRecords: records({ MIT: ["react"] }),
        allRecords: records({ MIT: ["electron"] }),
        platformRecords: [],
      }),
    ).toEqual([]);
  });

  test("omitted surfaces default to empty rather than throwing", () => {
    expect(checkThirdPartyLicenseAllowlist()).toEqual([]);
  });
});
