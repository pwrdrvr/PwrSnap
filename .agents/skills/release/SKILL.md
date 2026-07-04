---
name: release
description: Prepare, validate, tag, publish, and monitor guarded PwrSnap desktop releases. Use when the user asks to release PwrSnap, prepare a vX.Y.Z or vX.Y.Z-prerelease tag, update release notes or CHANGELOG.md for a desktop release, verify package.json/tag/changelog alignment, trigger the macOS signed/notarized release workflow, or inspect release workflow status.
---

# Release

Use this skill for PwrSnap desktop releases published by
`.github/workflows/release.yml`.

## Read First

Read these files before changing release metadata:

1. [../../../docs/desktop-release-runbook.md](../../../docs/desktop-release-runbook.md)
2. [../../../.github/workflows/release.yml](../../../.github/workflows/release.yml)
3. [../../../scripts/check-desktop-release-metadata.mjs](../../../scripts/check-desktop-release-metadata.mjs)

## Guardrails

- Release from the repository default branch unless the user explicitly approves
  another ref.
- Start from a clean working tree. If tracked files are dirty, stop and ask
  before changing release metadata.
- Fetch tags before planning:

  ```bash
  git fetch origin --tags
  ```

- Treat `apps/desktop/package.json` as the desktop release version source.
  The root `package.json` version is not the desktop app release version.
- Always use a leading-`v` tag such as `v0.0.1-alpha.5`.
- The tag version, `apps/desktop/package.json` version, and
  `CHANGELOG.md` release heading must match.
- Every GitHub Release must be born as a GitHub **Pre-release**. Do not let
  electron-builder create a normal `Latest` release and rely on a later
  `gh release edit --prerelease` as the normal path. Promotion to Latest is a
  separate operator action after the build is validated.
- Do not create or push the tag until the version and changelog are committed
  and present on the repository default branch.
- Before pushing a release tag, verify the `apple-signing` GitHub Environment
  exists on `pwrdrvr/PwrSnap`, requires reviewer approval, is scoped to `v*`
  release tags, and has the Apple signing/notarization secrets required by
  the workflow. Apple signing/notarization secrets must NOT exist as
  repository-level secrets.
- Do not use GitHub generated release notes as the final notes.
- Do not create the GitHub Release by hand before the build succeeds. Let
  electron-builder create or update the release from the signed/notarized CI
  build, then replace the generated/empty release notes with the changelog
  entry.
- Do not force-push the default branch or rewrite an existing release tag
  without explicit user approval.
- Keep the MIT license intact: do not swap LICENSE for a different SPDX or
  drift any workspace `package.json` away from `"license": "MIT"`.

## Prepare Release Metadata

1. Determine the next version from the previous tag and user intent:

   ```bash
   git tag --sort=-version:refname | head -n 10
   gh release list --limit 10
   ```

2. Update `apps/desktop/package.json` without creating a tag yet:

   ```bash
   pnpm --filter @pwrsnap/desktop version <version> --no-git-tag-version
   ```

   If that command is not available in the current pnpm version, edit only
   `apps/desktop/package.json` and preserve JSON formatting.

3. Add a top `CHANGELOG.md` entry:

   ```md
   ## v0.0.1-alpha.5 - YYYY-MM-DD
   ```

   Write release notes for users/operators, not as commit summaries. Preserve
   the same substance in GitHub release notes.

   Each bullet must use this shape:

   ```md
   - <Feature Area> - <Added|Improved|Fixed> <user-visible behavior and why it matters>.
   ```

   Good examples:

   ```md
   - Composer - Improved complex Markdown pastes with lists, inline code, and nested code blocks.
   - Thread Search - Escape now dismisses search, pairing naturally with Cmd/Ctrl+Shift+F to open it.
   - Thread List Pull Request Info - Merged PR commits no longer show as unpushed work.
   - Minor - Dependency updates and small UI polish.
   ```

   Avoid vague bullets that only summarize the commit mechanic, such as
   "Improved paste handling", "Added Escape-key handling", "Fixed progress
   chips", or "Updated dependencies". A good note answers: what
   feature/surface changed, whether it was Added/Improved/Fixed, and what
   user-visible behavior changed. Roll low-value maintenance-only items into
   `Minor - ...` unless they affect installs, updates, data safety, or a major
   workflow.

4. Run the metadata gate locally before committing:

   ```bash
   RELEASE_TAG=v<version> pnpm release:check
   ```

5. Run normal repo gates unless the user explicitly narrows verification:

   ```bash
   pnpm typecheck
   pnpm test
   ```

## Commit, Land, And Tag

Commit the version and changelog together. Use a signed commit; this repo's git
config should already sign commits with SSH.

```bash
git add apps/desktop/package.json CHANGELOG.md
git commit -m "chore(release): prepare v<version>"
```

Preferred fast path: `main` is protected by a ruleset (`non_fast_forward`,
`deletion`, required `Lint`/`Build`/`Test`/`Desktop E2E` checks) with
Repository admin bypass. If the user has Repository admin on `pwrdrvr/PwrSnap`,
push the signed release metadata commit directly. This avoids running PR CI
and then running the same gates again from the release tag.

```bash
git push origin HEAD:main
git fetch origin main --tags
git pull --ff-only
```

Fallback path: if the user does not have admin bypass or the direct push is
rejected, push the release metadata commit to a short-lived release branch,
open a PR, wait for required checks, then **squash merge** the PR. Do not use
rebase merge for release metadata PRs: GitHub may rewrite the commit SHA,
which makes it too easy to tag the pre-merge commit instead of the actual
default-branch release commit.

Remember that a GitHub squash merge creates a GitHub-authored commit on
`main`, not the original locally signed commit. If the user requires the
release metadata commit on `main` itself to be locally signed, use the
direct-push path or ask before using the PR fallback.

```bash
git switch -c release/v<version>
git push -u origin release/v<version>
gh pr create --base main --head release/v<version> \
  --title "chore(release): prepare v<version>" \
  --body-file .local/PR-v<version>.md
gh pr checks <pr-number> --watch --interval 10
gh pr merge <pr-number> --squash --delete-branch
git fetch origin main --tags
git switch main
git pull --ff-only
```

After the direct push or squash merge, rerun the metadata gate on `main`,
then create exactly one tag on the actual default-branch commit.

```bash
RELEASE_TAG=v<version> pnpm release:check
```

If signing tags is configured and works locally, prefer a signed annotated tag:

```bash
git tag -s v<version> -m "v<version>"
```

If signed tags are not available and the user approves an unsigned release tag,
create a lightweight tag instead:

```bash
git tag v<version>
```

Do not silently fall back from a failed signed tag to an unsigned tag. Ask the
user which tag form to use. Before pushing, verify the tag points at
`origin/main` or the intended default-branch release commit:

```bash
git tag -v v<version>
git merge-base --is-ancestor v<version> origin/main
```

## Publish

Push the tag after the release metadata is already on `main`:

```bash
git push origin v<version>
```

The tag push triggers `Release Desktop (macOS universal)`. The workflow must
pass `Check release metadata` in the no-secret `Test and prepare signing input`
job before the environment-gated `Sign, notarize, publish` job can request
approval and access Apple signing secrets.

For a manual dispatch, verify the tag already exists on GitHub:

```bash
git ls-remote --tags origin v<version>
gh workflow run release.yml -f tag=v<version>
```

## Monitor And Verify

Find the run for the release tag and watch it. If it takes a while to appear,
sleep for 5-10 minutes before deciding it failed to start.

```bash
gh run list --workflow release.yml --limit 10
gh run watch <run-id>
```

The `Sign, notarize, publish` job pauses for `apple-signing` Environment
approval. Treat that pause as expected. Before approving, verify the workflow
run is for the intended tag, the tag points at the intended default-branch
commit, and the version/changelog metadata match the tag.

A delegated monitor that stops at the `apple-signing` approval gate has not
completed the release. Resume monitoring after approval and continue until the
workflow succeeds or fails. Release completion requires the post-publish
release-notes step to run after the assets are uploaded.

On failure, inspect logs yourself:

```bash
gh run view <run-id> --log-failed
```

After success, verify the release and generated assets:

```bash
gh release view v<version>
gh release download v<version> --dir .local/release/v<version>
ls .local/release/v<version>
```

Expect signed/notarized universal macOS assets, including DMG/ZIP files and
`latest-mac.yml`.

The workflow automatically replaces electron-builder's generated/empty GitHub
Release body with the matching `CHANGELOG.md` entry after publishing assets.
Verify that the body is present and the release is still marked as a GitHub
Pre-release before calling the release done:

```bash
body_length="$(gh release view v<version> --repo pwrdrvr/PwrSnap --json body --jq '.body | length')"
test "$body_length" -gt 0
is_prerelease="$(gh release view v<version> --repo pwrdrvr/PwrSnap --json isPrerelease --jq '.isPrerelease')"
test "$is_prerelease" = true
```

If the automated notes step did not run or must be repaired manually, extract
the notes with the metadata checker, edit the release, and read the body /
pre-release state back:

```bash
node scripts/check-desktop-release-metadata.mjs \
  --tag v<version> \
  --notes-file .local/release-v<version>-notes.md
gh release edit v<version> --repo pwrdrvr/PwrSnap --notes-file .local/release-v<version>-notes.md
gh release view v<version> --repo pwrdrvr/PwrSnap --json body --jq '.body | length'
gh release view v<version> --repo pwrdrvr/PwrSnap --json isPrerelease --jq '.isPrerelease'
```

## Local Fallback

Use the local path only when CI is unavailable or the user explicitly asks for
local signing/notarization. Follow
[../../../docs/desktop-release-runbook.md](../../../docs/desktop-release-runbook.md)
for required Apple and GitHub secrets.

```bash
pnpm --filter @pwrsnap/desktop package:dryrun
pnpm --filter @pwrsnap/desktop package
pnpm --filter @pwrsnap/desktop release
```
