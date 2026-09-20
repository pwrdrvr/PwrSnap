// Guards `.pnpmfile.cjs`'s git-spec predicate on BOTH sides.
//
// The block side was always covered by the fact that the repo installs
// at all; the ALLOW side was covered by nothing, which is exactly how a
// false positive shipped. `GIT_SPEC_PATTERN`'s `user/repo` shortcut
// branch let `:` into its first character class, so every protocol spec
// with a one-segment path — `file:../local`, `link:../local`,
// `workspace:../pkg` — parsed as a GitHub shortcut and threw
// `Blocked git dependency`. Nothing in the repo uses those shapes
// today, so the install stayed green and the bug stayed invisible.
//
// A test that only asserted git specs are blocked would still pass
// against the broken pattern. Both tables below are load-bearing.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// `.pnpmfile.cjs` is CommonJS and deliberately not in any tsconfig, so
// it is loaded the same way pnpm itself loads it.
const require = createRequire(import.meta.url);
const pnpmfile = require(fileURLToPath(new URL("../../.pnpmfile.cjs", import.meta.url)));
const { isGitSpec } = pnpmfile;
const { readPackage } = pnpmfile.hooks;

// Every shape pnpm resolves through the `git` or `gitHostedTarball`
// fetcher. Widening the allow side must not quietly drop one of these.
const GIT_SPECS = [
  "github:user/repo",
  "user/repo",
  "user/repo#v1.0.0",
  "user/repo#semver:^1.0.0",
  "git+https://github.com/user/repo.git",
  "git+ssh://git@github.com/user/repo.git",
  "git://github.com/user/repo.git",
  "git@github.com:user/repo.git",
  "ssh://git@github.com/user/repo.git",
  "gitlab:x/y",
  "bitbucket:x/y",
  "https://github.com/user/repo",
  "https://www.gitlab.com/x/y",
  "git+file:///srv/repo.git",
];

// Legitimate non-git specs. The first three are the regression: each
// was blocked before the `:` exclusion. The rest are shapes that were
// never blocked and must stay that way.
const NON_GIT_SPECS = [
  "file:../local",
  "link:../local",
  "workspace:../pkg",
  "file:./packages/x",
  "file:../../a/b",
  "workspace:*",
  "workspace:^",
  "npm:foo@1.0.0",
  "catalog:default",
  "^1.2.3",
  "1.2.3",
  "latest",
  "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",
];

describe("isGitSpec", () => {
  test.each(GIT_SPECS)("blocks the git spec %s", (spec) => {
    expect(isGitSpec(spec)).toBe(true);
  });

  test.each(NON_GIT_SPECS)("allows the non-git spec %s", (spec) => {
    expect(isGitSpec(spec)).toBe(false);
  });

  test("ignores non-string specs rather than throwing", () => {
    for (const spec of [undefined, null, 42, {}, []]) {
      expect(isGitSpec(spec)).toBe(false);
    }
  });
});

// The predicate is only half the story: `readPackage` is what pnpm
// actually calls, and it treats a workspace package's devDependencies
// differently from a transitive one's. Pin the behaviour end to end so
// a future change to either piece has to be deliberate.
describe("readPackage", () => {
  test("throws on a git dependency in a workspace manifest", () => {
    expect(() =>
      readPackage({ name: "pwrsnap-workspace", dependencies: { evil: "github:user/repo" } })
    ).toThrow(/Blocked git dependency/);
  });

  test("throws on a git devDependency in a workspace manifest", () => {
    expect(() =>
      readPackage({ name: "@pwrsnap/desktop", devDependencies: { evil: "user/repo#main" } })
    ).toThrow(/Blocked git dependency/);
  });

  test("strips rather than throws for a transitive package's git devDependency", () => {
    const pkg = { name: "buffer-crc32", devDependencies: { tap: "github:iansu/x", ok: "^1.0.0" } };
    expect(() => readPackage(pkg)).not.toThrow();
    expect(pkg.devDependencies).toEqual({ ok: "^1.0.0" });
  });

  test("leaves a local file: / link: / workspace: dependency alone", () => {
    const deps = { a: "file:../local", b: "link:../local", c: "workspace:../pkg" };
    const pkg = { name: "pwrsnap-workspace", dependencies: { ...deps } };
    expect(() => readPackage(pkg)).not.toThrow();
    expect(pkg.dependencies).toEqual(deps);
  });
});
