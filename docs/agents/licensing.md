# Agent rules: Dependency licensing

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Dependency licensing — what we ship and what we even look at

PwrSnap is **MIT** licensed. The
[scripts/check-package-license-policy.mjs](../../scripts/check-package-license-policy.mjs)
gate covers what we **ship**; this section covers what we even **look at**.

### Hard rule: do not read source for restrictively-licensed projects

If a project's license is source-available-but-not-open-source — anything
with commercial-use restrictions, no-derivatives clauses, no-competition
clauses, employee-count or revenue tiers, the Business Source License (BSL)
until it converts, the Server Side Public License (SSPL), the Commons
Clause, or any custom license that isn't on the always-allowed list below
— do **not**:

- Add it as a runtime or build dependency.
- Clone, browse, or open its source repository.
- Reference its public API shape, file layout, schema, or implementation
  patterns from prior knowledge.
- Translate its docs/examples into PwrSnap code.

This protects PwrSnap from contamination claims. Even line-of-sight to
restricted source can create derivative-work exposure when we later ship a
feature in the same domain. If you've previously read a now-banned
project's source, **don't write PwrSnap code in the same domain from
memory** — note the conflict and ask before proceeding.

### Currently banned (do-not-look list)

| Project | License | Why |
|---|---|---|
| **Remotion** (`remotion`, `@remotion/*`) | Remotion License (source-available, commercial-use restricted) | Initial Phase 6 sizzle-reel plan referenced it; retracted on license review. Do not browse [github.com/remotion-dev/remotion](https://github.com/remotion-dev/remotion), do not `npm install` it, do not copy patterns from its docs into PwrSnap. Phase 6 composition engine is now an open research item — see plan §"Phase 6". |

Extend this table whenever a new candidate hits the same problem class.

### Always-allowed licenses

MIT, BSD (2-clause / 3-clause), Apache-2.0, MPL-2.0, ISC, 0BSD, Unlicense,
CC0. Anything else: **pause and confirm with the user** before reading the
project's source or adding the dep.

### The gate that enforces this

[scripts/check-third-party-license-allowlist.mjs](../../scripts/check-third-party-license-allowlist.mjs),
run by `pnpm licenses:check` (so, by `pnpm lint`, so by CI). It evaluates every
declared license in the shipped tree against `ALLOWED_LICENSE_IDS` as a real
SPDX expression — `OR` satisfied by either side, `AND` by both — so
`(MIT OR WTFPL)` passes on its MIT half while `Apache-2.0 AND GPL-3.0` fails.
An unparseable string (`UNLICENSED`, `SEE LICENSE IN ...`) fails rather than
being guessed at.

**Do not confuse it with the other two license scripts:**

| Script | Checks |
|---|---|
| `check-package-license-policy.mjs` | OUR four workspace `package.json` files declare MIT. Never looks at a dependency. |
| `check-third-party-license-allowlist.mjs` | Three of the four sources the notice is built from (below) are allowlisted. |
| `generate-third-party-licenses.mjs` | Transcribes the tree into `THIRD_PARTY_LICENSES`. **Judges nothing.** |

**Know exactly what the gate covers** — it reads the npm production tree, the
devDependencies the notice discloses anyway (`NOTICE_DEV_DEPENDENCIES`, i.e.
Electron, which `--prod` never reports), and the located
`SHIPPED_PLATFORM_PACKAGES` slices. It does **not** cover optional dependencies
beyond those slices — `--no-optional` is what makes the notice platform-
identical, so the report cannot enumerate them — nor `BUNDLED_FFMPEG`, whose
license is a hand-written constant. **A new optional dependency that ships must
be added to `SHIPPED_PLATFORM_PACKAGES` to be disclosed AND gated; neither
script can discover one on its own.**

`NOTICE_DEV_DEPENDENCIES` mirrors the `record.name === "electron"` special case
in `buildThirdPartyLicenseNotice`. Keep the two in step — a name the generator
discloses but the set omits is a shipped component with an ungated license.

That last row is the reason the gate exists. The generator groups records by
whatever license string pnpm hands it, so before the gate a dep flipping
MIT → GPL-3.0 wrote a new `GPL-3.0` section into the notice and
`licenses:generate --check` then PASSED — committed file matches generated
file, green CI, copyleft shipped, nobody told. The only safety was that a
human might spot a new heading in the diff, which is worth nothing once
regeneration is automated on Dependabot branches.

Weak copyleft (LGPL) is permitted **only** for a `SHIPPED_PLATFORM_PACKAGES`
entry carrying an `lgpl` descriptor — the thing that puts its FSF text and
written source offer in the notice. Strong copyleft (GPL/AGPL) and
source-available terms (BSL, SSPL, Commons Clause) are permitted nowhere.

Adding an id to `ALLOWED_LICENSE_IDS` is a legal decision. Make it in a commit
that says why — **never to make CI green.** Note that the seeded list is wider
than the paragraph above: `BlueOak-1.0.0`, `OFL-1.1` and `Python-2.0` were
already in the tree, undocumented, when the gate was written. That drift is
exactly what an unenforced policy accumulates.

### Dependabot PRs regenerate the notice automatically

`licenses:check` hashes the dependency tree, so **any** dependency change makes
the committed notice stale, and Dependabot cannot run `pnpm licenses:generate`
itself. Every Dependabot PR therefore used to land with `Lint` and
`Windows (lint + build + test)` red on that one line and needed a hand-pushed
follow-up commit.
[dependabot-licenses.yml](../../.github/workflows/dependabot-licenses.yml) does that
push. Read its header before editing — the `pull_request_target` trigger, the
manifest-only file guard, and `pnpm install --ignore-scripts` are the three
controls that keep a dependency bump from running its own install scripts with
a token that can write to this repo.

**It runs the allowlist gate first and pushes nothing if that fails.** That
ordering is the point: unattended regeneration is only safe because a bad
license now stops the job instead of being quietly committed by a bot.

### The same job syncs the packaged Electron runtime

An Electron bump fails those two jobs a second way, and for the same reason:
`scripts/check-dependency-version-policy.mjs` requires
[electron-builder.yml](../../apps/desktop/electron-builder.yml)'s `electronVersion:`
to equal the version `pnpm-lock.yaml` resolves — electron-builder downloads the
runtime it is told to, so a stale pin packages a binary nothing was built or
tested against. That line is outside the set of files Dependabot edits, so it
was hand-fixed twice (`443e1507`, then `615475d3` on
[#565](https://github.com/pwrdrvr/PwrSnap/pull/565)) before the workflow took it
over.

- The fixer is
  [sync-packaged-electron-version.mjs](../../scripts/sync-packaged-electron-version.mjs)
  (`pnpm deps:sync`) — run it locally when `pnpm deps:check` reports the drift.
  It imports both the lockfile reader **and `normalizeLockVersion`** from the
  check rather than reimplementing them, so the two cannot disagree about what
  "resolved" means or about what already counts as a match — a fixer with
  stricter equality rewrites clean trees and pushes commits for nothing. It
  rewrites **one line in place**: the file's comments are load-bearing and three other regex
  parsers read it ([release.mjs](../../apps/desktop/scripts/release.mjs),
  [package-win.mjs](../../apps/desktop/scripts/package-win.mjs), the check itself).
  An ambiguous file — no `electronVersion:`, two of them, a lockfile version
  that is not plain semver — is a hard failure, never a silent no-op.
- **It runs after the allowlist gate**, so the "nothing is written to the branch
  until the license gate passes" ordering above still holds.
- **The check itself no longer fails open.** `electron-builder.yml` pinning a
  runtime that `pnpm-lock.yaml` resolves nothing for is now a failure, not a
  silent pass: the old `return []` meant a lockfile shape the reader stopped
  understanding (a pnpm format change, a renamed importer) would switch the
  Electron check off entirely and let a stale runtime ship.
- **electron-builder.yml is now the one non-manifest file the changed-file guard
  admits**, because the workflow's own commit rides in the PR diff from then on.
  The allowance is narrowed to the line, not the file: the guard reads that
  file's patch from the API and refuses any added or removed line that is not an
  `electronVersion:` line (and refuses just as hard if GitHub returns no patch).
  Widening it back to the whole file would put an `afterPack` hook path and the
  asar layout of a signed release on the privileged path.

**Operational requirement:** a push made with the default `GITHUB_TOKEN` does
not trigger new workflow runs, so without a separate token the PR keeps showing
its stale red checks and nothing is gained. Provision repository variable
`LICENSES_BOT_APP_CLIENT_ID` and secret `LICENSES_BOT_APP_PRIVATE_KEY` for an
App installed here with `contents: write`; `RELEASES_PAT` is the fallback. The
existing `FFMPEG_BUILDS_*` App **cannot** be reused — it is scoped read-only to
`pwrsnap-ffmpeg-builds`. Until one of those exists the workflow still runs, and
warns in the job summary that CI will not re-run.
