// Project-level pnpm install hooks. Loaded automatically by pnpm
// every time it resolves dependencies (`pnpm install`, `pnpm add`,
// `pnpm install --frozen-lockfile` in CI). The companion `.npmrc`
// sets `global-pnpmfile=` so contributors with a user-level
// `global-pnpmfile` configured don't accidentally double-apply hooks
// and break `--frozen-lockfile` via pnpmfileChecksum drift — every
// machine that runs pnpm in this repo (yours, mine, CI) hashes
// exactly this file and nothing else.
//
// ── Why this file exists ────────────────────────────────────────────
//
// Refuse to install dependencies specified via git URLs (git@, git+,
// ssh://git@, GitHub/GitLab/Bitbucket HTTP, `user/repo`-style
// shortcuts, etc.). Two reasons:
//
//   1. Supply-chain integrity. Git specs aren't pinned to a tarball
//      hash the way npm specs are — the lockfile records a commit
//      SHA, but the act of installing runs the package's lifecycle
//      scripts (`prepare`, `prepack`, `install`, etc.) against
//      arbitrary code fetched from arbitrary git remotes. There's no
//      registry-side integrity check.
//
//   2. Reproducibility. A git spec can resolve differently across
//      time (force-pushed tags, deleted commits, registry outages).
//      Tarball specs with integrity hashes either match or don't.
//
// The codebase has no git deps today. This hook locks that in — a
// malicious or careless PR that adds one will fail `pnpm install`
// with a loud error before anything is fetched or any lifecycle
// script runs.
//
// Adapted from the user-level pattern many of us already run as
// `~/.pnpm/global_pnpmfile.cjs`; moved into the repo so the
// protection is a project guarantee, reviewable in PRs, active in CI
// without depending on per-contributor machine setup.

"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

// Match the spec shapes pnpm itself recognizes as git fetches. The
// last alternation (`user/repo#ref?`) is the GitHub shortcut form npm
// supports — pnpm treats it the same as `github:user/repo`.
//
// That last alternation excludes `:` from its first character class
// (`[^/@\s:]`) and the omission is load-bearing. A shortcut spec never
// contains a colon before the slash, but a PROTOCOL spec whose path
// has exactly one segment does: `file:../local` reads as `file:..` +
// `/` + `local`, `link:../local` and `workspace:../pkg` the same. With
// `:` allowed, all three parsed as `user/repo` shortcuts and were
// blocked as git dependencies. Specs with two or more path segments
// (`file:./packages/x`) escaped only because the trailing class cannot
// match a second `/` — an accident, not a design.
//
// `git@github.com:user/repo.git` still matches, via the `git@` branch
// above rather than this one, so the exclusion costs no coverage.
const GIT_SPEC_PATTERN =
  /^(?:git(?:\+|:)|git@|ssh:\/\/git@|github:|gitlab:|bitbucket:|https?:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\.com\/|[^/@\s:]+\/[^/\s]+(?:#.*)?$)/;

function isGitSpec(spec) {
  return typeof spec === "string" && GIT_SPEC_PATTERN.test(spec);
}

function readPackage(pkg) {
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!isGitSpec(spec)) continue;
      // Transitive packages' `devDependencies` are never installed by
      // pnpm — they only matter when the package is being developed
      // on, not when it's pulled in as a dep. The original intent of
      // this hook was to block git specs that would actually run
      // lifecycle scripts, which is the install-time risk; transitive
      // devDeps are stripped silently so we don't false-positive on
      // upstream maintainers' tooling choices (e.g. yauzl →
      // buffer-crc32@0.2.3 has an ancient `tap` devDep tree that
      // bottoms out in github:iansu/eslint-plugin-node-core).
      //
      // The root workspace's devDependencies are still scanned: pnpm
      // calls readPackage on every package, including our own, so a
      // git devDep in apps/desktop/package.json or any sibling still
      // throws below.
      if (field === "devDependencies" && !isWorkspaceRootPackage(pkg)) {
        delete deps[name];
        continue;
      }
      throw new Error(blockedGitSpecMessage(name, spec, field));
    }
  }

  // `pnpm.overrides` — and the yarn-style `resolutions` pnpm also honours
  // — are NOT dependency fields, so the loop above never sees them. pnpm
  // resolves their VALUES exactly like a spec, so a git URL parked in one
  // reaches the fetcher having appeared in nobody's dependencies block.
  //
  // That makes an override the quietest injection point in the manifest:
  // it silently repoints a TRANSITIVE package, so a reviewer scanning a
  // diff for a git URL under `dependencies` does not see it. The fetcher
  // still refuses the install, but its error names neither the package
  // nor where it was declared — so without this scan the layer that
  // produces the actionable diagnostic is the one that misses it.
  //
  // Gated on `isWorkspaceRootPackage` because pnpm only honours overrides
  // declared by the workspace root; scanning a registry package's own
  // copy would be a false positive with nothing behind it. (The predicate
  // also admits our non-root `@pwrsnap/*` packages, whose overrides pnpm
  // ignores — flagging a git spec there is over-broad in the safe
  // direction, and it would be worth deleting anyway.)
  if (isWorkspaceRootPackage(pkg)) {
    for (const [label, entries] of [
      ["pnpm.overrides", pkg.pnpm ? pkg.pnpm.overrides : undefined],
      ["resolutions", pkg.resolutions]
    ]) {
      if (!entries) continue;
      for (const [name, spec] of Object.entries(entries)) {
        if (!isGitSpec(spec)) continue;
        throw new Error(blockedGitSpecMessage(name, spec, label));
      }
    }

    // pnpm 10 ALSO accepts a top-level `overrides:` in pnpm-workspace.yaml,
    // and that file is not a package manifest — readPackage is never handed
    // it, so everything above misses it. Measured on 10.33.0: a git spec
    // there resolves, reaches the fetcher, and is refused by the anonymous
    // `Blocked pnpm git dependency fetch`, which names neither the package
    // nor the field. That is the exact diagnostic gap this scan exists to
    // close, so the root scan reads the file itself.
    const workspaceHit = workspaceOverrideGitSpecs()[0];
    if (workspaceHit !== undefined) {
      throw new Error(
        blockedGitSpecMessage(workspaceHit[0], workspaceHit[1], "pnpm-workspace.yaml overrides")
      );
    }
  }

  return pkg;
}

// Read once. `__dirname` — not `process.cwd()` — because this file sits AT
// the workspace root next to pnpm-workspace.yaml, while cwd is wherever the
// user invoked pnpm from.
let workspaceOverridesCache;

function workspaceOverrideGitSpecs() {
  if (workspaceOverridesCache === undefined) {
    try {
      workspaceOverridesCache = gitSpecsInWorkspaceOverrides(
        readFileSync(join(__dirname, "pnpm-workspace.yaml"), "utf8")
      );
    } catch {
      workspaceOverridesCache = [];
    }
  }

  return workspaceOverridesCache;
}

// A deliberately small line scanner, NOT a YAML parser. A pnpmfile runs
// during resolution, so it cannot `require("js-yaml")`: that package is not
// a declared dependency of this workspace, and node_modules may not exist
// yet on a cold install. This understands the flat `name: spec` mapping that
// an overrides block actually is, and ignores any line it cannot read
// confidently — the fetcher remains the enforcement layer, so failing open
// costs a better error message, never the protection itself.
function gitSpecsInWorkspaceOverrides(yamlText) {
  const hits = [];
  let inBlock = false;

  for (const line of yamlText.split(/\r?\n/)) {
    if (!inBlock) {
      if (/^overrides:[ \t]*(?:#.*)?$/.test(line)) inBlock = true;
      continue;
    }

    if (line.trim() === "" || /^[ \t]*#/.test(line)) continue;
    // Any line back at column 0 is the next top-level key: the block ended.
    if (!/^[ \t]/.test(line)) break;

    const entry = /^[ \t]+(?:"([^"]*)"|'([^']*)'|([^:#]+?))[ \t]*:[ \t]*(\S.*)$/.exec(line);
    if (entry === null) continue;

    const spec = unquoteScalar(entry[4]);
    if (spec !== null && isGitSpec(spec)) {
      hits.push([(entry[1] ?? entry[2] ?? entry[3]).trim(), spec]);
    }
  }

  return hits;
}

function unquoteScalar(raw) {
  const text = raw.trim();

  for (const quote of ['"', "'"]) {
    if (!text.startsWith(quote)) continue;
    const end = text.indexOf(quote, 1);
    return end === -1 ? null : text.slice(1, end);
  }

  // Unquoted: a ` #` starts a trailing comment.
  const comment = text.indexOf(" #");
  const value = (comment === -1 ? text : text.slice(0, comment)).trim();

  return value === "" ? null : value;
}

// Shared so an override rejection reads the same as a dependency one and
// names the field it came from — `pnpm.overrides` is worth saying out
// loud, since that is the field a reader is least likely to have checked.
function blockedGitSpecMessage(name, spec, field) {
  return (
    `[pwrsnap pnpmfile] Blocked git dependency ${name}@${spec} declared in ` +
    `\`${field}\`. Git specs bypass tarball integrity checks and run ` +
    `arbitrary lifecycle scripts against arbitrary remotes. If you need ` +
    `this package, publish a registry tarball or vendor the source.`
  );
}

// Workspace packages live under @pwrsnap/* (plus the unscoped root
// `pwrsnap-workspace`). Transitive packages from the registry never
// use these names, so a name check is a precise way to tell "is this
// our own code" without depending on pnpm-internal context this hook
// doesn't get.
function isWorkspaceRootPackage(pkg) {
  if (typeof pkg.name !== "string") return false;
  return pkg.name.startsWith("@pwrsnap/") || pkg.name === "pwrsnap-workspace";
}

// Belt-and-suspenders: even if a git spec somehow slipped past
// readPackage (e.g., transitive dep introduced via a registry
// package's manifest at fetch time), the corresponding pnpm fetcher
// itself refuses to run.
//
// pnpm's `hooks.fetchers` API treats each entry as a FACTORY function
// that's called with `({ defaultFetchers })` at fetcher-registry
// build time; the factory's RETURN VALUE is the actual fetcher pnpm
// invokes later when a dep needs fetching. So this function takes
// the factory shape (the arg is ignored — we're not delegating to a
// default) and returns the throwing fetcher.
function blockGitFetcher(/* { defaultFetchers } */) {
  return async () => {
    throw new Error(
      "[pwrsnap pnpmfile] Blocked pnpm git dependency fetch. See .pnpmfile.cjs."
    );
  };
}

module.exports = {
  // Exported for `scripts/__tests__/pnpmfile.test.mjs`. pnpm only ever
  // reads `hooks`, so extra keys here are inert at install time.
  isGitSpec,
  gitSpecsInWorkspaceOverrides,
  hooks: {
    readPackage,
    fetchers: {
      // `git`: direct git URL fetches (`git+ssh://`, `git@`, etc.)
      // `gitHostedTarball`: pnpm's shortcut for github/gitlab/bitbucket
      //   URLs and `user/repo` shortcuts — pnpm downloads a tarball of
      //   the resolved commit instead of cloning. Different fetcher,
      //   same supply-chain concern.
      git: blockGitFetcher,
      gitHostedTarball: blockGitFetcher
    }
  }
};
