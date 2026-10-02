# Package-manager release follow-up

Every desktop release checks these channels before release metadata changes and
again after GitHub publication. This runbook also applies when the operator
returns after manually promoting a release. It complements the
[release skill](../.agents/skills/release/SKILL.md),
[desktop release runbook](desktop-release-runbook.md), and
[Winget submission checklist](windows/winget/README.md).

## Authoritative packages and eligibility

| Channel | Package and authoritative source | Payload / support |
| --- | --- | --- |
| GitHub | [`pwrdrvr/PwrSnap` releases](https://github.com/pwrdrvr/PwrSnap/releases); REST `/releases/latest` is the operator's Latest pointer | Signed Windows x64 NSIS; signed/notarized universal and ARM64 macOS DMGs. Linux is a build gate, not a distributed package. |
| Winget community source `winget` | `PwrDrvr.PwrSnap`; [`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs), `master`, `manifests/p/PwrDrvr/PwrSnap/<version>/` | `PwrSnap-<version>-windows-x64-setup.exe`; per-user `nullsoft`, Windows 10/11 x64. No Windows ARM64 payload. Local manifests do not prove catalog publication. |
| Homebrew | Cask `pwrdrvr/tap/pwrsnap`; [`pwrdrvr/homebrew-tap`](https://github.com/pwrdrvr/homebrew-tap), `main`, [`Casks/pwrsnap.rb`](https://github.com/pwrdrvr/homebrew-tap/blob/main/Casks/pwrsnap.rb) | `PwrSnap-<version>-universal.dmg` for Intel **and** Apple Silicon; macOS Sonoma or newer. `auto_updates true`, `livecheck :github_latest`. No formula, official `Homebrew/homebrew-cask` entry, or beta cask found in the inspection below. |

Eligible targets have bare `X.Y.Z` SemVer, are public/non-draft, have
`prerelease=false`, and have passed operator smoke checks. CI creates **every**
release as a GitHub Pre-release, even bare SemVer. Leave the new release in that
state; the operator alone promotes it manually. Meanwhile, catch up the channels
to an already eligible stable release within the authorized scope.

Inspect both GitHub Latest and all promoted stable releases: a maintenance patch
may move Latest behind a newer train. Compare numeric SemVer components, not
lexicographic strings or release creation order. Preserve a newer channel
version; never automatically downgrade it to an older Latest pointer. The tap's
scheduled workflow already holds rather than downgrades in that case. An explicit
version input can override that protection, so verify the target before dispatch.
Do not feed alpha, beta, `-prerelease.N`, or RC versions to these stable packages.

## Before every release: inspect remote sources

From the assigned PwrSnap workspace, with authenticated `gh` and `jq`:

```bash
mkdir -p .local/package-channels
date -u '+%Y-%m-%dT%H:%M:%SZ'
gh api repos/pwrdrvr/PwrSnap/releases/latest \
  --jq '{tag_name, prerelease, draft, html_url}'
gh api --paginate --slurp repos/pwrdrvr/PwrSnap/releases \
  > .local/package-channels/releases.json
jq '[.[][] | select(.draft == false and .prerelease == false)
  | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))]
  | sort_by(.tag_name | ltrimstr("v") | split(".") | map(tonumber))
  | reverse | .[] | {tag_name, html_url}' \
  .local/package-channels/releases.json

gh api repos/microsoft/winget-pkgs --jq '{full_name, default_branch}'
gh api 'repos/microsoft/winget-pkgs/contents/manifests/p/PwrDrvr/PwrSnap?ref=master' \
  --jq '.[] | {name, path, html_url}'
gh search prs PwrSnap --repo microsoft/winget-pkgs --state open \
  --json number,title,url,author

gh api repos/pwrdrvr/homebrew-tap/commits/main --jq .sha
gh api 'repos/pwrdrvr/homebrew-tap/contents/Casks/pwrsnap.rb?ref=main' \
  --jq .content | base64 --decode \
  > .local/package-channels/pwrsnap.rb
cat .local/package-channels/pwrsnap.rb
gh pr list --repo pwrdrvr/homebrew-tap --state open \
  --json number,title,url,author,headRefName
gh run list --repo pwrdrvr/homebrew-tap --workflow bump.yml --limit 5
gh issue list --repo pwrdrvr/homebrew-tap --state open --label bump-failure
```

Keep command output and the UTC timestamp in the release handoff. When the
Winget directory exists, read its highest appropriate version's installer and
locale manifests with the Contents API (`--jq .content | base64 --decode`),
including URL, hash, architectures, scope, and release-notes URL. Older version
directories remain; select numerically. Read Homebrew's version, SHA-256, URL,
architecture/OS constraints, and livecheck from the **remote** Ruby file.

A 404 for the package directory means **not published at that path** only after
the public repository query succeeds. Check open and closed submission PRs and
search for a renamed identifier before preparing a first submission. A 401/403,
rate limit, timeout, or unavailable repository means **inspection blocked**,
not absence or success. If the tap layout/ownership changes, inspect its remote
tree and README to rediscover the package; do not assume an official cask/formula.
Record any mismatch between observed sources and this table.

For each channel, record the observed version/absence, chosen eligible target,
lag, existing PR and its checks, update owner and next action. The release
operator owns this work until a named person accepts the follow-up. GitHub bot
authorship does not assign human ownership. Preserve unrelated work and use only
assigned workspaces for edits/Git; API inspection and workflow dispatch do not
require editing the tap's local Homebrew checkout.

## After publication or manual promotion: verify payloads

Repeat the remote baseline even for a prerelease. For an eligible channel target,
set `version` to the selected bare SemVer; do not infer it from the local desktop
package (which may already be on a newer train). Inspect release state first:

```bash
version=<eligible-version>
tag="v${version}"
gh api "repos/pwrdrvr/PwrSnap/releases/tags/${tag}" \
  --jq '{tag_name, draft, prerelease, html_url,
    assets: [.assets[] | {name, size, digest, browser_download_url}]}'
asset_dir=".local/package-channels/${tag}"
mkdir -p "$asset_dir"
base_url="https://github.com/pwrdrvr/PwrSnap/releases/download/${tag}"
curl --fail --location --retry 3 \
  "$base_url/PwrSnap-${version}-windows-x64-setup.exe" \
  --output "$asset_dir/PwrSnap-${version}-windows-x64-setup.exe"
curl --fail --location --retry 3 "$base_url/PwrSnap-windows-SHA256SUMS" \
  --output "$asset_dir/PwrSnap-windows-SHA256SUMS"
curl --fail --location --retry 3 "$base_url/PwrSnap-${version}-universal.dmg" \
  --output "$asset_dir/PwrSnap-${version}-universal.dmg"
(cd "$asset_dir" && shasum -a 256 --check PwrSnap-windows-SHA256SUMS)
shasum -a 256 "$asset_dir/PwrSnap-${version}-universal.dmg"
```

Require successful downloads through the exact versioned HTTPS URLs. Compare the
Windows digest with both the signed-release checksum file and manifest
`InstallerSha256`; compare the universal DMG digest with the cask `sha256`.
Also compare downloaded hashes to the GitHub asset `sha256:` digests when
present. macOS does not currently ship a DMG SHA256SUMS file; do not invent one
or substitute the ZIP's updater SHA-512. Record hash and byte count. Missing
assets, differing hashes, invalid signatures, or failed smoke checks block the
channel update. Never bypass hash verification, use `sha256 :no_check`, or pin a
moving `releases/latest/download/` alias. The ARM64-only DMG is not this cask's
payload; changing that requires separate architecture-specific URL/hash work.

### Winget: prepare, validate, submit

PwrSnap's release workflow currently performs **no Winget submission**. Follow
the [full Windows checklist](windows/winget/README.md) and reuse its
`validate-manifests.mjs` cross-platform schema check.

- **First submission:** copy/update all three local starter manifests into a
  reviewable payload for the chosen target. Local `1.0.3` is historical; update
  all `PackageVersion` values, installer URL/hash/date, and release-notes URL.
  For current releases, ARP `DisplayName` is `PwrSnap`, not `PwrSnap 1.0.3`.
  Preserve confirmed ProductCode `c8b3bdba-25e5-5dbd-b016-8e6ce14b4982`, x64,
  user scope and silent `/S`; verify against the actual install.
- **Existing package:** prefer Microsoft's `wingetcreate update` to download,
  parse and generate the next version, then inspect its output. Do not use
  `--submit` until validation is complete; do not replace old version manifests.

On Windows, substitute the chosen version and actual generated directory:

```powershell
$version = '<eligible-version>'
$url = "https://github.com/pwrdrvr/PwrSnap/releases/download/v$version/PwrSnap-$version-windows-x64-setup.exe"
# Existing remote package only; not usable before the first submission merges.
wingetcreate update PwrDrvr.PwrSnap --version $version --urls $url --out .local\winget
$manifestDir = ".local\winget\manifests\p\PwrDrvr\PwrSnap\$version"
# For a first submission, point this at the prepared three-file payload instead.
winget validate --manifest $manifestDir
Get-AuthenticodeSignature ".\PwrSnap-$version-windows-x64-setup.exe" |
  Format-List Status,SignerCertificate
Get-FileHash ".\PwrSnap-$version-windows-x64-setup.exe" -Algorithm SHA256
```

Require `Valid` Authenticode and PwrDrvr LLC identity on the downloaded installer.
Run `Tools\SandboxTest.ps1` from a scoped `microsoft/winget-pkgs` checkout where
Windows Sandbox is supported. Otherwise record the unsupported environment and
use an isolated Windows test machine plus the upstream validation pipeline.
Local manifest installation needs administrator-enabled `LocalManifestFiles`
on the test machine; then `winget install --manifest $manifestDir`. Test a fresh
install and an upgrade from the prior supported stable install; verify ARP
matching, launch/capture and preserved settings/captures. Headed checks belong
in the lab under its Windows runbook. Do not uninstall or reset real user data
to set up a test.

Submit the validated directory with `wingetcreate submit $manifestDir` (its
interactive GitHub login avoids putting a token on the command line), or use the
fork/sparse-checkout PR path in the Windows checklist. Target
`microsoft/winget-pkgs:master`, only
`manifests/p/PwrDrvr/PwrSnap/<version>/`, one package/version per PR. The
operator authorizes first catalog submission; if that authorization is absent,
finish the payload and validation, then report the concrete approval blocker.
Record the resulting PR URL and owner. Address `Needs-Author-Feedback` promptly;
Microsoft may close it after ten days. A validation-pass label is still pending
review/merge, not publication.

After merge, re-read the remote version directory and installer manifest, then
on Windows refresh **only** the community source and query the exact ID:

```powershell
winget source update --name winget
winget show --id PwrDrvr.PwrSnap --exact --source winget --versions
winget show --id PwrDrvr.PwrSnap --exact --source winget --version $version
# Isolated test machine: fresh install, or upgrade an existing prior install.
winget install --id PwrDrvr.PwrSnap --exact --source winget --version $version
winget upgrade --id PwrDrvr.PwrSnap --exact --source winget --version $version
winget list --id PwrDrvr.PwrSnap --exact
```

Record manifest acceptance separately from source/index availability and install/
upgrade success. If the refreshed source lacks the merged version, keep the PR
and merge links, observed version and next retry time; diagnose index delay
before creating a duplicate submission. An unavailable Windows environment is a
validation blocker, not a passed check.

### Homebrew: reuse the tap automation

The tap's [`bump.yml`](https://github.com/pwrdrvr/homebrew-tap/blob/main/.github/workflows/bump.yml)
checks every six hours, rehashes the universal DMG, runs style/online audit, and
opens `bump/pwrsnap-<version>`. Its
[`scripts/bump-cask.sh`](https://github.com/pwrdrvr/homebrew-tap/blob/main/scripts/bump-cask.sh)
is the existing manual helper; no new PwrSnap submission workflow is needed.
Inspect existing PRs first and reuse a matching one. With authorization to
advance the tap, request an immediate check after manual promotion:

```bash
gh workflow run bump.yml --repo pwrdrvr/homebrew-tap --ref main
gh run list --repo pwrdrvr/homebrew-tap --workflow bump.yml --limit 5
gh run watch <bump-run-id> --repo pwrdrvr/homebrew-tap
gh pr list --repo pwrdrvr/homebrew-tap --state open
gh pr view <bump-pr> --repo pwrdrvr/homebrew-tap
gh pr diff <bump-pr> --repo pwrdrvr/homebrew-tap
gh pr checks <bump-pr> --repo pwrdrvr/homebrew-tap
```

Default dispatch resolves GitHub Latest and holds against downgrades. If a
newer promoted stable train is the chosen target while Latest is an older
maintenance patch, use `-f version=<eligible-version>` only after verifying
eligibility and version ordering. If automation fails, inspect `bump-failure`
issues and `gh run view <run-id> --log-failed`, name the failure and owner, and
prepare a manual update using the helper in an **assigned tap workspace**.
Do not edit `$(brew --repository)/Library/Taps/...` or another thread's checkout.
The target is this tap, not `Homebrew/homebrew-cask`; do not open a duplicate
official-cask submission.

Check the PR diff's version and universal DMG hash against the payload above.
Require actual tap `CI` results for the exact PR head: style, online audit,
installation, Developer ID signature and Gatekeeper checks. **No checks
reported is not a pass.** The bump currently uses `GITHUB_TOKEN` with
`create-pull-request`. Current GitHub documentation says token-created
`opened`/`synchronize`/`reopened` PR events can create approval-required runs;
check the PR banner for **Approve workflows to run** and the Actions run state
first. A maintainer with write access owns approving a reviewed head. If there
is no approvable run, arrange a reviewed push/reopen with human/App credentials
or fix the tap automation credentials, then verify the run's head SHA. Do not
infer the cause of missing checks solely from bot authorship or token type, and
do not infer installation success
from the bump job's style/audit results. Once validated and authorized, the tap
maintainer merges the bump PR; the release operator owns tracking to publication.

Re-read `main`'s remote cask to prove the version and hash landed. This third-party
tap publishes through Git; there is no official Homebrew cask API index to wait
for. On a supported isolated macOS test host, refresh and verify the client:

```bash
brew tap pwrdrvr/tap
# On Homebrew versions that support tap trust, trust just this cask.
if brew trust --help >/dev/null 2>&1; then
  brew trust --cask pwrdrvr/tap/pwrsnap
fi
brew update
brew info --cask --json=v2 pwrdrvr/tap/pwrsnap
brew livecheck --cask pwrdrvr/tap/pwrsnap
brew audit --cask --online pwrdrvr/tap/pwrsnap
# Fresh test host:
brew install --cask pwrdrvr/tap/pwrsnap
# Separate prior-version install; explicit greedy covers auto_updates true:
brew upgrade --cask --greedy pwrdrvr/tap/pwrsnap
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  /Applications/PwrSnap.app/Contents/Info.plist
codesign --verify --deep --strict /Applications/PwrSnap.app
codesign -dv --verbose=2 /Applications/PwrSnap.app
spctl -a -vv /Applications/PwrSnap.app
```

Inspect `brew info`'s available and installed versions separately. Test Intel
and native Apple Silicon where available; the cask installs universal on both.
CI's current hosted install proves only its runner architecture and is not an
upgrade/launch test. Use the macOS lab skill for headed launch/capture checks.
Record preserved settings/captures and actual installed version. Do not use
`--zap`, wipe application support, or install/upgrade the operator's live app to
validate documentation. A merged cask with an older local view is a refresh/cache
delay; an in-app updated binary alone does not prove Homebrew publication.

## Completion record and follow-up ownership

Leave this record in the release handoff or tracking issue, with UTC timestamp:

| Channel | Before → eligible target → accepted source version → refreshed client version | Evidence | State / owner / next action and check time |
| --- | --- | --- | --- |
| GitHub | Latest and highest promoted stable; new tag's separate prerelease state | Release/run links, asset URLs, bytes and hashes, smoke results | Published Pre-release / operator owns manual promotion |
| Winget `PwrDrvr.PwrSnap` | Version or confirmed absence; target; remote manifest; `winget show` | Payload path, PR/merge link, SHA-256, validation and install/upgrade logs | Current, awaiting promotion/authorization, prepared, submitted/review pending, accepted/index pending, or blocked; named owner |
| Homebrew `pwrdrvr/tap/pwrsnap` | Remote cask; target; merged cask; `brew info` and installed app | Bump/run/PR/merge links, universal DMG SHA-256, CI and upgrade results | Current, awaiting promotion/authorization, PR pending, merged/cache pending, or blocked; named owner |

When authorized, advance an eligible lagging channel in the same release task;
prepare reviewable payloads before asking for any missing submission approval.
If review/index/cache delays outlast the task, leave a concrete owned follow-up
with the submission link and next check time. Do not call successful GitHub
publication “all channels current.” Resume this checklist after the operator's
manual promotion or the submission's acceptance; do not schedule automation or
send third-party messages unless requested.

### Observed baseline (2026-10-02; refresh on every release)

GitHub Latest and the highest promoted stable SemVer were **v1.1.12**.
`PwrDrvr.PwrSnap` was absent at the authoritative Winget path (HTTP 404 with a
readable repository); code and open/closed PR searches found no submission.
Local **1.0.3** manifests remain a starter payload. The release operator must
prepare the newest eligible stable payload and own first-submission approval
and Windows validation; no Winget publication is claimed.

The tap's `main` cask was **1.1.2**, not the version named by its bump PRs.
[PR #7 for 1.1.12](https://github.com/pwrdrvr/homebrew-tap/pull/7) was open,
with **no checks reported** and its head's
[PR CI run](https://github.com/pwrdrvr/homebrew-tap/actions/runs/36975435325)
concluded **action_required** with zero jobs, despite a
[successful bump run](https://github.com/pwrdrvr/homebrew-tap/actions/runs/36975297677).
Older bump PRs #3–#6 were also open. The PwrDrvr tap maintainer/release operator
owns approving workflows for #7's reviewed head, obtaining successful CI,
reviewing/merging it, and verifying
the refreshed client; superseded PRs need disposition after the new bump lands.
This inspection did not submit Winget, merge the tap, or publish a new release.

## Official requirements consulted

- Microsoft: [manifest creation/validation](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest),
  [submission and review](https://learn.microsoft.com/en-us/windows/package-manager/package/repository),
  [WingetCreate update](https://github.com/microsoft/winget-create/blob/main/doc/update.md)
  and [submit](https://github.com/microsoft/winget-create/blob/main/doc/submit.md),
  [local manifest install](https://learn.microsoft.com/en-us/windows/package-manager/winget/install).
- Homebrew: [cask checksum/architecture DSL](https://docs.brew.sh/Cask-Cookbook),
  [commands, audit, and greedy upgrades](https://docs.brew.sh/Manpage),
  [item-scoped tap trust](https://docs.brew.sh/Tap-Trust).
- GitHub: [`GITHUB_TOKEN` workflow triggers and PR approval](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

Recheck official requirements and live workflow definitions when preparing an
update; this snapshot is not a substitute for a remote inspection.
