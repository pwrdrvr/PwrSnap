# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep new labels namespaced
with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `build-preview` | `preview-build.yml` | Builds unsigned macOS DMG and Windows NSIS preview artifacts. This is the existing combined preview path. |
| `ci:windows-signing` | `release.yml` | Runs the release workflow's Windows prepare/sign jobs for a same-repository PR, verifies Authenticode, and uploads `windows-signed-installer-pr`. The protected job receives the staged archive without checking out source or installing project dependencies. PR events cannot run `publish-release-assets`. Add the label only for a reviewed signing change, temporarily allow `refs/pull/<number>/merge` in the environment, and remove that rule after validation. |

If another label changes workflow behavior, document it here in the same change.

## Public distribution-source audit

`distribution-audit.yml` audits authoritative Winget/Homebrew sources and existing
identities/submissions on relevant PRs, manual dispatch, and as a reusable release
preflight/follow-up. Its helper/tests need Node and `gh`, with no dependency install.
It has `contents: read`; the public-read step alone uses
`GH_TOKEN: ${{ secrets.DISTRIBUTION_READ_TOKEN || github.token }}`. Checkout and
artifact upload retain the default token. The organization-provided fine-grained
PAT is public-read-only with no additional permissions, explicitly shared with
PwrSnap/PwrGit/PwrAgent; it cannot submit/push/merge or publish a release.

Fork PRs without the secret fall back to `github.token`. User authentication
addresses the prior HTTP 429 context, not a missing public-access grant, and is
still subject to code-search/secondary limits. The helper retries at most three
times, honors server delays within its budget, and rejects incomplete/truncated
searches instead of declaring absence. Every run preserves a JSON snapshot or
blocker and logs only the credential source boolean, never the value.

Harold/the organization secret maintainer owns expiry tracking and rotation under
the same secret name without widening permissions or changing the selected-repo
list. After rotation, run the audit in each recipient repo. See the
[package-manager runbook](../../docs/package-manager-release-runbook.md#organization-provided-public-read-credential)
for metadata-only sharing checks and runtime verification. A post-publication
audit failure needs an owned retry; it does not mean GitHub publication failed.

## Windows installer name

The release publishes two Windows installer assets that are the same bytes:
`PwrSnap-<version>-windows-x64-setup.exe`, which `latest.yml` names and
electron-updater downloads, and `PwrSnap.Setup.exe`, a stable alias so
`releases/latest/download/PwrSnap.Setup.exe` keeps working across versions. The
versioned asset is never renamed away.

`windows-sign` cuts the alias with
`apps/desktop/scripts/windows-release-artifacts.mjs`, after the Authenticode
verification step and never before it: the alias is a byte-for-byte copy and
would otherwise inherit an unsigned intermediate. The script checks each
installer against its `SHA256SUMS` entry before copying and the copy against
the original after, and refuses an architecture it has no agreed alias for
rather than pointing a stable URL at the wrong installer. The alias stays out
of `PwrSnap-windows-SHA256SUMS`; the release runbook says why.

The name has no space on purpose. GitHub Releases replaces spaces in an
uploaded asset's filename with periods — on `gh`, the REST API and the web UI
alike — and a later rename cannot restore one, so `PwrSnap Setup.exe` would
publish as `PwrSnap.Setup.exe` regardless. Naming the build output that way
keeps it spelled the same as the published asset. A future Windows ARM build
takes `PwrSnap.Setup.Arm.exe`. This does not match the macOS aliases
(`PwrSnap.dmg`, `PwrSnap-arm64.dmg`), which are already published URLs that
must keep working; each platform keeps its own spelling deliberately.

It replaces `PwrSnap-windows-x64-setup.exe` (#463), which named an architecture
no download button mentions and never resolved at `releases/latest/download`:
it shipped from v1.1.0-alpha.6 onward while v1.0.3 held the Latest marker, and
neither pwrsnap.com nor docs.pwrsnap.com ever linked it.
