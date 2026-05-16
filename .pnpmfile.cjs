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

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

// Match the spec shapes pnpm itself recognizes as git fetches. The
// last alternation (`user/repo#ref?`) is the GitHub shortcut form npm
// supports — pnpm treats it the same as `github:user/repo`.
const GIT_SPEC_PATTERN =
  /^(?:git(?:\+|:)|git@|ssh:\/\/git@|github:|gitlab:|bitbucket:|https?:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\.com\/|[^/@\s]+\/[^/\s]+(?:#.*)?$)/;

function isGitSpec(spec) {
  return typeof spec === "string" && GIT_SPEC_PATTERN.test(spec);
}

function readPackage(pkg) {
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (isGitSpec(spec)) {
        throw new Error(
          `[pwrsnap pnpmfile] Blocked git dependency ${name}@${spec}. ` +
            `Git specs bypass tarball integrity checks and run arbitrary ` +
            `lifecycle scripts against arbitrary remotes. If you need this ` +
            `package, publish a registry tarball or vendor the source.`
        );
      }
    }
  }
  return pkg;
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
