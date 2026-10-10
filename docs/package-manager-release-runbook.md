# Package-manager release follow-up

## Automatic Homebrew publication and CI byte acquisition

PwrSnap's Homebrew publisher runs in `pwrdrvr/homebrew-tap` through
`bump.yml` and the shared `sync.yml`. It validates both native Mac profiles and
commits the cask directly to `main`; routine updates do not open bump PRs or
require a merge. The tap polls every 15 minutes. Product synchronization can
dispatch immediately with `HOMEBREW_TAP_DISPATCH_TOKEN` (tap-only Actions write),
or await the schedule when that optional credential is absent. Homebrew does
not depend on Winget submission credentials or upstream review.

CI acquires installers/checksums from retained successful release-build Actions
artifacts for the exact stable tag commit, verifies SHA-256 and size against
release metadata, and never falls back to published release downloads. Signed
platform artifacts retain for 90 days. Missing/expired artifacts, corrupt bytes
or moved tags are explicit blockers; restore the original build artifacts.
Already published tap versions skip native validation and byte acquisition.
PwrDrvr release-asset URLs remain end-user URLs, not CI acquisition sources.

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

Prefer the dependency-free, read-only audit helper. It compares promoted stable
release metadata with the authoritative Winget directory and vendor cask, and
searches Winget identities/submissions plus official Homebrew casks/formulae.
It reports source versions and pending PRs; it does not submit, merge, install,
promote, or prove refreshed-client availability:

```bash
node scripts/release/audit-package-channels.mjs .local/package-channels/audit.json
```

The [distribution audit workflow](../.github/workflows/distribution-audit.yml)
runs this helper on relevant PRs, on manual dispatch, and from `release.yml`
before preparation and after publication. Failed/incomplete audits block the
preflight; after publication, an audit failure means GitHub may already be
published and the channel inspection needs an owned retry. It preserves a JSON
artifact with either a complete snapshot or an actionable blocker. Use
`gh workflow run distribution-audit.yml --repo pwrdrvr/PwrSnap --ref <branch>`
for a non-publishing verification, then inspect the run and its artifact.

### Organization-provided public read credential

Harold provides `DISTRIBUTION_READ_TOKEN` as a PwrDrvr **organization Actions
secret**, explicitly shared with PwrSnap, PwrGit and PwrAgent. It is a dedicated
fine-grained PAT restricted to public repositories with no additional
permissions. Public package-source audit/search/metadata steps use:

```yaml
env:
  GH_TOKEN: ${{ secrets.DISTRIBUTION_READ_TOKEN || github.token }}
```

Scope that environment to public cross-repository read steps. Checkout, artifact
upload, same-repository operations, release publication, pushes and submissions
keep their existing workflow/App/operator credentials. This secret is **not** a
write credential; do not pass it to `wingetcreate --token` for submission or use
it to create/merge a tap PR. Local runs use the operator's existing `gh` login;
never retrieve, print, copy, or persist the organization secret locally. Fork PRs
without organization secrets use the default workflow token. If an available PAT
returns 401, report an expired/revoked-token blocker instead of silently masking
it with a second credential.

The prior PwrGit failures were HTTP 429 throttling, not missing public-repository
access. User authentication changes the rate-limit context; it does not remove
code-search/secondary limits. The helper makes at most three attempts per read,
honors `Retry-After`/primary reset times within a 120-second per-wait budget, and
stops if the server requires a longer delay. Searches run sequentially and must
have `incomplete_results=false`, complete pagination, and no 1,000-result
truncation before any absence conclusion. Persistent 403/429, authentication
failure, timeout, or incomplete search means **audit blocked**, never “package
not found.” Retain the blocker, owner and next retry time; do not broaden token
permissions to address throttling.

Harold/the organization secret maintainer owns expiration and rotation. Record
the PAT expiry in the organization's credential inventory and arrange renewal
before it expires; the secret metadata API does not reveal that date. Replace
the value under the same secret name, preserve public-read-only restrictions
and the selected repository access list, and rerun the read-only audit in each
recipient repository. Do not duplicate it as a repository secret. Diagnose
availability with secret **metadata** and the workflow's boolean credential
source message, never an environment dump or token output:

```bash
gh api orgs/pwrdrvr/actions/secrets/DISTRIBUTION_READ_TOKEN \
  --jq '{name,visibility,updated_at}'
gh api orgs/pwrdrvr/actions/secrets/DISTRIBUTION_READ_TOKEN/repositories \
  --jq '{repositories:[.repositories[].full_name]}'
```

On 2026-10-02 the organization API confirmed `visibility=selected`, including
`pwrdrvr/PwrSnap`, `pwrdrvr/PwrGit` and `pwrdrvr/PwrAgent`. A repository-level
secret lookup can return 404 for this organization secret; that is not evidence
that the workflow lacks access. Metadata confirms sharing; a successful workflow
using the organization credential confirms runtime public reads.

### Manual inspection and troubleshooting

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
$assetDir = ".local\package-channels\v$version"
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
$installer = Join-Path $assetDir "PwrSnap-$version-windows-x64-setup.exe"
Invoke-WebRequest -Uri $url -OutFile $installer -ErrorAction Stop
# Existing remote package only; not usable before the first submission merges.
wingetcreate update PwrDrvr.PwrSnap --version $version --urls $url --out .local\winget
$manifestDir = ".local\winget\manifests\p\PwrDrvr\PwrSnap\$version"
# For a first submission, point this at the prepared three-file payload instead.
winget validate --manifest $manifestDir
Get-AuthenticodeSignature $installer |
  Format-List Status,SignerCertificate
Get-FileHash $installer -Algorithm SHA256
```

Require `Valid` Authenticode and PwrDrvr LLC identity on the downloaded installer.
Both checks use the explicitly downloaded `$installer`; WingetCreate's temporary
download cache and manifest `--out` directory are not installer locations.
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

### Homebrew: automatic tap publication

The tap's [`bump.yml`](https://github.com/pwrdrvr/homebrew-tap/blob/main/.github/workflows/bump.yml)
checks Stable Latest every 15 minutes, verifies the universal DMG from its
original successful release-build Actions artifact, validates on both native
Mac profiles, and commits directly to tap `main`. No per-release bump PR or
merge is required. PwrSnap's `homebrew.yml` synchronizes on stable promotion
and can be dispatched explicitly when promotion used `GITHUB_TOKEN`.

```bash
gh workflow run homebrew.yml --repo pwrdrvr/PwrSnap --ref main
gh workflow run bump.yml --repo pwrdrvr/homebrew-tap --ref main
gh run list --repo pwrdrvr/homebrew-tap --workflow bump.yml --limit 5
gh run watch <bump-run-id> --repo pwrdrvr/homebrew-tap --exit-status
```

An explicit version must equal Stable Latest; stale targets and downgrades fail.
Missing original build artifacts, corrupt bytes or changed release metadata stop
publication and file a tracking issue with the failed run. Repair that blocker
and dispatch again; never substitute release downloads or rebuild published
installers. Do not edit an operator's installed tap or another thread's checkout.

Require successful native install/upgrade/signature/notarization checks and
verified publication on tap main. Then use `brew update` and
`brew info --cask pwrdrvr/tap/pwrsnap` on a refreshed client. End-user installer
URLs remain the immutable release URLs. CI uses verified build bytes, and its
curl guard blocks release-asset requests. Online audit excludes only the binary
URL reachability probe; metadata verifies the expected published URL instead.
Record repository publication separately from client discovery and isolated
installation verification. Do not replace the operator's running app.

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
- GitHub: [public code search and fine-grained tokens](https://docs.github.com/en/rest/search/search#search-code),
  [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
  [organization secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

Recheck official requirements and live workflow definitions when preparing an
update; this snapshot is not a substitute for a remote inspection.
