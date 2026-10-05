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

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// `.pnpmfile.cjs` is CommonJS and deliberately not in any tsconfig, so
// it is loaded the same way pnpm itself loads it.
const require = createRequire(import.meta.url);
const pnpmfile = require(fileURLToPath(new URL("../../.pnpmfile.cjs", import.meta.url)));
const { isGitSpec, gitSpecsInWorkspaceOverrides } = pnpmfile;
const { readPackage } = pnpmfile.hooks;

// Every shape pnpm resolves through the `git` or `gitHostedTarball`
// fetcher. Widening the allow side must not quietly drop one of these.
const GIT_SPECS = [
  "https://bitbucket.org/user/repo/get/v1.0.0.tar.gz",
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

// Electron on Linux loads sharp's wasm build (apps/desktop/src/main/
// sharp-wasm-steer.ts). sharp does not depend on it, and its manifest has no
// platform fields, so without these edits pnpm would either hide it from
// sharp's loader or install it on the hosts that stage release builds.
describe("readPackage / sharp wasm wiring", () => {
  test("adds @img/sharp-wasm32 to sharp's optional dependencies at sharp's own version", () => {
    const pkg = {
      name: "sharp",
      version: "9.8.7",
      optionalDependencies: { "@img/sharp-linux-x64": "9.8.7" }
    };
    readPackage(pkg);
    expect(pkg.optionalDependencies).toEqual({
      "@img/sharp-linux-x64": "9.8.7",
      "@img/sharp-wasm32": "9.8.7"
    });
  });

  test("gates @img/sharp-wasm32 to linux without pnpm inferring a wasm32 host CPU", () => {
    const pkg = { name: "@img/sharp-wasm32", version: "0.35.4", cpu: ["wasm32"] };
    readPackage(pkg);
    expect(pkg.cpu).toEqual(["any"]);
    expect(pkg.os).toEqual(["linux"]);
  });

  test("drops the FreeBSD / WebContainers wrappers' edge so pnpm cannot skip it through them", () => {
    for (const name of ["@img/sharp-freebsd-wasm32", "@img/sharp-webcontainers-wasm32"]) {
      const pkg = { name, os: ["freebsd"], dependencies: { "@img/sharp-wasm32": "0.35.4" } };
      readPackage(pkg);
      expect(pkg.dependencies).toEqual({});
      expect(pkg.os).toEqual(["freebsd"]);
    }
  });

  test("leaves every other @img package's platform fields alone", () => {
    const pkg = { name: "@img/sharp-linux-x64", os: ["linux"], cpu: ["x64"], libc: ["glibc"] };
    readPackage(pkg);
    expect(pkg).toEqual({ name: "@img/sharp-linux-x64", os: ["linux"], cpu: ["x64"], libc: ["glibc"] });
  });

  test("the installed sharp exposes its wasm binding only on Linux", () => {
    const desktopRequire = createRequire(
      fileURLToPath(new URL("../../apps/desktop/package.json", import.meta.url))
    );
    const sharpRequire = createRequire(desktopRequire.resolve("sharp"));
    const resolveBinding = () => sharpRequire.resolve("@img/sharp-wasm32/sharp.node");
    if (process.platform === "linux") {
      expect(resolveBinding()).toContain("sharp-wasm32");
    } else {
      expect(resolveBinding).toThrow(/Cannot find module/);
    }
  });

  test("the lockfile carries both edits, so a frozen install on Linux gets the wasm build", () => {
    const lockfile = readFileSync(fileURLToPath(new URL("../../pnpm-lock.yaml", import.meta.url)), "utf8");
    const packageEntry = /\n {2}'@img\/sharp-wasm32@[^']+':\n((?: {4}.*\n)+)/.exec(lockfile);
    expect(packageEntry, "@img/sharp-wasm32 package entry").not.toBeNull();
    expect(packageEntry[1]).toMatch(/^ {4}os: \[linux\]$/m);
    expect(packageEntry[1]).toMatch(/^ {4}cpu: \[any\]$/m);

    const snapshots = lockfile.slice(lockfile.lastIndexOf("\nsnapshots:\n"));
    const sharpSnapshot = /\n {2}sharp@([0-9][^(':]*)[^:]*:\n((?: {4}.*\n)+)/.exec(snapshots);
    expect(sharpSnapshot, "sharp snapshot entry").not.toBeNull();
    expect(sharpSnapshot[2]).toContain(`'@img/sharp-wasm32': ${sharpSnapshot[1]}`);

    for (const wrapper of ["sharp-freebsd-wasm32", "sharp-webcontainers-wasm32"]) {
      const entry = new RegExp(`\\n {2}'@img\\/${wrapper}@[^']+':\\n((?: {4}.*\\n)*)`).exec(snapshots);
      expect(entry, `${wrapper} snapshot entry`).not.toBeNull();
      expect(entry[1]).not.toContain("@img/sharp-wasm32");
    }
  });
});

// `pnpm.overrides` and `resolutions` are not dependency fields, so the
// DEPENDENCY_FIELDS loop never sees them — yet pnpm resolves their values
// exactly like a spec. An override repoints a TRANSITIVE package, so it
// shows up in nobody's dependencies block: the quietest place in the
// manifest to park a git URL. The fetcher still refuses such an install,
// but its error names neither the package nor the field, so without this
// scan the layer that gives an actionable diagnostic is the one that misses.
describe("readPackage / override fields", () => {
  test.each(["pnpm.overrides", "resolutions"])(
    "throws on a git spec in %s and names the field",
    (label) => {
      const pkg =
        label === "pnpm.overrides"
          ? { name: "pwrsnap-workspace", pnpm: { overrides: { "is-number": "github:a/b" } } }
          : { name: "pwrsnap-workspace", resolutions: { "is-number": "github:a/b" } };
      expect(() => readPackage(pkg)).toThrow(/Blocked git dependency/);
      // The field name is the whole point of catching it here rather than
      // letting the fetcher refuse it anonymously.
      expect(() => readPackage(pkg)).toThrow(new RegExp(`\\b${label.replace(".", "\\.")}\\b`));
      expect(() => readPackage(pkg)).toThrow(/is-number/);
    }
  );

  // pnpm only honours overrides declared by the workspace root, so a
  // registry package's own copy is inert — flagging it would be a false
  // positive with nothing behind it.
  test("ignores a transitive package's own overrides", () => {
    expect(() =>
      readPackage({ name: "some-registry-package", pnpm: { overrides: { lodash: "github:a/b" } } })
    ).not.toThrow();
    expect(() =>
      readPackage({ name: "some-registry-package", resolutions: { lodash: "github:a/b" } })
    ).not.toThrow();
  });

  // Every legitimate override value shape pnpm accepts. `$name` is pnpm's
  // reference-a-declared-dependency form; the scoped `$@types/node` spelling
  // is the one that looks most like a `user/repo` shortcut and is worth
  // pinning explicitly after the character-class change.
  test.each([
    "0.5.1",
    "24.12.4",
    ">=4.0.0",
    "^1.2.3",
    "npm:other@1.0.0",
    "$some-dep",
    "$@types/node",
    "workspace:*",
  ])("allows the legitimate override value %s", (spec) => {
    expect(() =>
      readPackage({ name: "pwrsnap-workspace", pnpm: { overrides: { "is-number": spec } } })
    ).not.toThrow();
  });

  test("does not trip on the overrides this repo actually ships", async () => {
    const root = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
    );
    const workspace = readFileSync(
      fileURLToPath(new URL("../../pnpm-workspace.yaml", import.meta.url)), "utf8"
    );
    expect(root.pnpm).toBeUndefined();
    expect(workspace).toMatch(/^overrides:$/m);
    expect(gitSpecsInWorkspaceOverrides(workspace)).toEqual([]);
    expect(() => readPackage(root)).not.toThrow();
  });

  test("a missing or empty overrides block is not an error", () => {
    for (const pkg of [
      { name: "pwrsnap-workspace" },
      { name: "pwrsnap-workspace", pnpm: {} },
      { name: "pwrsnap-workspace", pnpm: { overrides: {} } },
      { name: "pwrsnap-workspace", resolutions: {} },
    ]) {
      expect(() => readPackage(pkg)).not.toThrow();
    }
  });
});

// pnpm 10 also accepts a top-level `overrides:` in pnpm-workspace.yaml.
// That file is not a package manifest, so readPackage is never handed it —
// before this scan a git spec there reached the fetcher and was refused by
// `Blocked pnpm git dependency fetch`, naming neither package nor field.
//
// It is scanned with a small line reader rather than js-yaml, because a
// pnpmfile runs during resolution and cannot require a package that may not
// be installed yet. These pin what that reader does and does not claim to
// understand: anything it cannot read confidently is skipped, which costs a
// diagnostic and never the protection, since the fetcher still refuses.
describe("gitSpecsInWorkspaceOverrides", () => {
  test("finds a git spec in the overrides block", () => {
    const yaml = ['packages:', '  - apps/*', 'overrides:', '  is-number: "github:a/b"'].join("\n");
    expect(gitSpecsInWorkspaceOverrides(yaml)).toEqual([["is-number", "github:a/b"]]);
  });

  test.each([
    ["  is-number: github:a/b", "unquoted"],
    ["  is-number: 'github:a/b'", "single-quoted"],
    ['  "is-number": "github:a/b"', "quoted key"],
    ['  is-number: "github:a/b" # pinned', "trailing comment"],
  ])("reads %s (%s)", (line) => {
    expect(gitSpecsInWorkspaceOverrides(`overrides:\n${line}`)).toEqual([["is-number", "github:a/b"]]);
  });

  test.each([
    ["0.5.1", "plain version"],
    [">=4.0.0", "range"],
    ["$some-dep", "reference form"],
    ["npm:other@1.0.0", "npm alias"],
    ["file:../local", "local path"],
  ])("does not flag the legitimate value %s (%s)", (value) => {
    expect(gitSpecsInWorkspaceOverrides(`overrides:\n  is-number: "${value}"`)).toEqual([]);
  });

  test("stops at the next top-level key", () => {
    const yaml = [
      "overrides:",
      '  a: "1.0.0"',
      "packages:",
      // Not an override — a sibling top-level key's contents must not be read.
      '  b: "github:a/b"',
    ].join("\n");
    expect(gitSpecsInWorkspaceOverrides(yaml)).toEqual([]);
  });

  test("ignores a file with no overrides block", () => {
    expect(gitSpecsInWorkspaceOverrides("packages:\n  - apps/*\nminimumReleaseAge: 10080")).toEqual([]);
  });

  test("ignores comments and blank lines inside the block", () => {
    const yaml = ["overrides:", "  # a comment", "", '  a: "github:x/y"'].join("\n");
    expect(gitSpecsInWorkspaceOverrides(yaml)).toEqual([["a", "github:x/y"]]);
  });

  // The repo's own file must stay clean, and must parse to "nothing to flag"
  // rather than throwing.
  test("this repo's pnpm-workspace.yaml declares no git override", async () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../pnpm-workspace.yaml", import.meta.url)),
      "utf8"
    );
    expect(gitSpecsInWorkspaceOverrides(text)).toEqual([]);
  });
});

// Frozen installs can fetch locked packages without calling readPackage.
// pnpm 12 reads this array at the top level, not under hooks.fetchers.
describe("pnpm 12 git fetch guard", () => {
  const [fetcher] = pnpmfile.fetchers;

  test.each([
    { type: "git", repo: "https://example.com/team/pkg.git", commit: "abc" },
    { tarball: "https://github.com/team/pkg/archive/abc.tar.gz" },
    { tarball: "https://codeload.github.com/team/pkg/tar.gz/abc" },
    { tarball: "https://gitlab.com/team/pkg/-/archive/abc/pkg.tar.gz" },
    { tarball: "https://bitbucket.org/team/pkg/get/abc.tar.gz" }
  ])("blocks locked git resolution %j", async (resolution) => {
    expect(fetcher.canFetch("pkg", resolution)).toBe(true);
    await expect(fetcher.fetch(null, resolution)).rejects.toThrow(
      "Blocked pnpm git dependency fetch"
    );
  });

  test.each([
    { integrity: "sha512-example" },
    { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" },
    { type: "directory", directory: "../local" }
  ])("leaves registry and local resolution %j to pnpm", (resolution) => {
    expect(fetcher.canFetch("pkg", resolution)).toBe(false);
  });
});
