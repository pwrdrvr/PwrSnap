import { describe, expect, test } from "vitest";
import {
  ALLOWED_LICENSE_IDS,
  ALLOWED_PLATFORM_COPYLEFT_IDS,
  checkNpmDependencyLicenses,
  checkShippedPlatformLicenses,
  checkThirdPartyLicenseAllowlist,
  evaluateSpdxExpression,
  SpdxParseError,
  tokenizeSpdxExpression,
} from "../check-third-party-license-allowlist.mjs";
import { WEAK_COPYLEFT_LICENSE_TEXTS } from "../generate-third-party-licenses.mjs";

/**
 * Shape a `pnpm licenses list --json` report: keys are declared license
 * strings, values are the packages that declared them.
 */
function report(licenseToPackages) {
  const out = {};
  for (const [license, names] of Object.entries(licenseToPackages)) {
    out[license] = names.map((name) => ({ name, versions: ["1.0.0"], paths: ["/tmp/x"] }));
  }
  return out;
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

  test("tokenizer splits parens that are flush against identifiers", () => {
    expect(tokenizeSpdxExpression("(MIT OR WTFPL)")).toEqual(["(", "MIT", "OR", "WTFPL", ")"]);
  });

  test("an unparseable expression throws rather than guessing", () => {
    // "SEE LICENSE IN ..." and a dangling operator must not silently evaluate
    // to true on some substring. For a legal gate, refusing to guess is the
    // safe direction.
    expect(() => evaluateSpdxExpression("MIT OR", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("(MIT", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("AND MIT", allow)).toThrow(SpdxParseError);
  });
});

describe("npm dependency licenses", () => {
  test("passes the license set the tree actually declared when the gate was written", () => {
    expect(
      checkNpmDependencyLicenses(
        report({
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
    const failures = checkNpmDependencyLicenses(report({ "GPL-3.0": ["some-dep"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/some-dep@1\.0\.0/);
    expect(failures[0]).toMatch(/GPL-3\.0/);
    expect(failures[0]).toMatch(/not on the allowlist/);
  });

  test("a copyleft failure warns against allowlisting it to go green", () => {
    const [failure] = checkNpmDependencyLicenses(report({ "AGPL-3.0-only": ["some-dep"] }));
    expect(failure).toMatch(/copyleft/);
    expect(failure).toMatch(/do not allowlist it to make CI green/);
  });

  test("rejects a transitive GPL dep dragged in by a bump", () => {
    const failures = checkNpmDependencyLicenses(
      report({ MIT: ["react", "hono"], "GPL-2.0-or-later": ["sneaky-transitive"] }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/sneaky-transitive/);
  });

  test("rejects weak copyleft on an ordinary npm dependency", () => {
    // LGPL is permitted only for a shipped platform slice carrying disclosure.
    // An npm dep arriving under it has no FSF text and no source offer.
    const failures = checkNpmDependencyLicenses(report({ "LGPL-3.0-or-later": ["some-dep"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/LGPL-3\.0-or-later/);
  });

  test("rejects an unresolvable license string", () => {
    const failures = checkNpmDependencyLicenses(
      report({ UNLICENSED: ["private-thing"], "SEE LICENSE IN LICENSE.md": ["vague-thing"] }),
    );
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toMatch(/private-thing/);
    expect(failures.join("\n")).toMatch(/not a parseable SPDX expression/);
  });

  test("names every offending dependency, not just the first", () => {
    const failures = checkNpmDependencyLicenses(
      report({ "GPL-3.0": ["one", "two"], MIT: ["fine"] }),
    );
    expect(failures).toHaveLength(2);
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

  test("rejects strong copyleft on a slice even when it carries a descriptor", () => {
    // lgplFamilyOf() does not match a bare "GPL-3.0", so before this gate a
    // hand-added GPL platform entry passed every existing check.
    const failures = checkShippedPlatformLicenses(
      [{ name: "@img/sharp-win32-x64", version: "0.35.3", declaredLicense: "GPL-3.0" }],
      PLATFORM,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/not permitted in a shipped artifact/);
  });

  test("an empty platform list is not a failure", () => {
    expect(checkShippedPlatformLicenses([], PLATFORM)).toEqual([]);
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
  test("reports npm and platform failures together, sorted", () => {
    const failures = checkThirdPartyLicenseAllowlist({
      productionReport: report({ "GPL-3.0": ["zzz-dep"] }),
      platformRecords: [
        { name: "@img/sharp-win32-x64", version: "0.35.3", declaredLicense: "GPL-3.0" },
      ],
    });
    expect(failures).toHaveLength(2);
    expect(failures).toEqual([...failures].sort((a, b) => a.localeCompare(b)));
  });

  test("a clean tree produces no failures", () => {
    expect(
      checkThirdPartyLicenseAllowlist({
        productionReport: report({ MIT: ["react"] }),
        platformRecords: [],
      }),
    ).toEqual([]);
  });
});
