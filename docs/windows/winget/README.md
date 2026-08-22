# winget submission — `PwrDrvr.PwrSnap`

Everything needed to publish PwrSnap to the Windows Package Manager community
repository so that this works:

```powershell
winget install PwrDrvr.PwrSnap
```

The three manifests in this directory are the submission payload. They are kept
here, in our repo, as the source of truth; the copies that live in
`microsoft/winget-pkgs` are a downstream mirror.

**Submitting the pull request to `microsoft/winget-pkgs` is the operator's
call.** Nothing in this directory submits anything on its own.

## What is here

| File | Role |
| --- | --- |
| [`PwrDrvr.PwrSnap.yaml`](PwrDrvr.PwrSnap.yaml) | Version manifest — ties the package id, version, and default locale together. |
| [`PwrDrvr.PwrSnap.installer.yaml`](PwrDrvr.PwrSnap.installer.yaml) | Installer manifest — URL, hash, installer type, silent switches, scope. |
| [`PwrDrvr.PwrSnap.locale.en-US.yaml`](PwrDrvr.PwrSnap.locale.en-US.yaml) | Default-locale manifest — the human-facing metadata `winget show` prints. |
| [`validate-manifests.mjs`](validate-manifests.mjs) | Cross-platform schema pre-check for the three manifests above. |

Current contents describe **v1.0.3**, the newest stable release. Alpha, beta,
and prerelease tags are not submitted — winget's community repo is for shipping
versions.

## Schema version

`ManifestVersion: 1.12.0`, with the matching
`# yaml-language-server: $schema=https://aka.ms/winget-manifest.*.1.12.0.schema.json`
header on each file.

That is the version actually merging into `microsoft/winget-pkgs` today —
verified against manifests merged on 2026-08-22, and the version
`wingetcreate 1.12.x` emits. The `microsoft/winget-cli` repo carries frozen
schema snapshots numbered higher than this (a `latest/` in-development schema
plus `v1.28.0`), but nothing in the community repo uses them yet, and a
`winget validate` run only understands the schema versions its own client build
ships. Do not jump ahead of what the repo is merging.

All three files have been checked against the published draft-07 JSON schemas
for 1.12.0. Re-check after any edit — from the repo root, on any platform:

```bash
node docs/windows/winget/validate-manifests.mjs
```

That is a schema check only. It is not a substitute for `winget validate` and
`SandboxTest.ps1`, both of which need Windows.

## Facts the manifests encode, and where each came from

| Manifest field | Value | Source of truth |
| --- | --- | --- |
| `InstallerType` | `nullsoft` | `nsis` target in [`apps/desktop/electron-builder.yml`](../../../apps/desktop/electron-builder.yml) |
| `Architecture` | `x64` | `win.target[].arch: [x64]` — no arm64 Windows target yet |
| `Scope` | `user` | `nsis.perMachine: false`; a silent NSIS run resolves to `CurrentUser` |
| `InstallerSwitches.Silent` | `/S` | NSIS honors `/S`; `nsis.oneClick: false` still accepts it |
| `InstallModes` | `interactive`, `silent`, `silentWithProgress` | `oneClick: false` gives a real interactive installer as well as `/S` |
| `UpgradeBehavior` | `install` | The electron-builder NSIS installer replaces a prior install in place |
| `FileExtensions` | `pwrsnap` | `win.fileAssociations` |
| `InstallationMetadata.DefaultInstallLocation` | `%LOCALAPPDATA%\Programs\PwrSnap` | Per-user electron-builder NSIS default |
| `AppsAndFeaturesEntries.DisplayName` | `PwrSnap 1.0.3` | electron-builder's `uninstallDisplayName` default is `${productName} ${version}`; confirmed on a real install |
| `AppsAndFeaturesEntries.ProductCode` | `c8b3bdba-25e5-5dbd-b016-8e6ce14b4982` | UUIDv5 of `appId`; confirmed against the real signed v1.0.3 install |
| `MinimumOSVersion` | `10.0.0.0` | Windows 10 floor |
| `InstallerSha256` | matches `PwrSnap-windows-SHA256SUMS` on the release | Verified against the published asset |
| `License` / `LicenseUrl` | MIT / repo `LICENSE` | [`LICENSE`](../../../LICENSE) |

### The `ProductCode`, and how it was confirmed

electron-builder names the NSIS uninstall registry key after a UUIDv5 of the
`appId` (`com.pwrdrvr.pwrsnap`) under electron-builder's own namespace. Computed
against the pinned electron-builder `26.15.7`, that is
`c8b3bdba-25e5-5dbd-b016-8e6ce14b4982`, which is what winget wants as
`ProductCode` for an NSIS package.

**Confirmed 2026-08-22** against the real signed v1.0.3 installer on a Windows
machine: the registry value matches the derivation exactly. The same check is
what caught the `DisplayName` version suffix documented below.

That confirmation was worth doing rather than trusting the derivation, because a
wrong `ProductCode` does not fail validation — it just makes `winget upgrade`
quietly stop matching the installed app.

**This does not need repeating every release.** The uninstall key is derived from
the `appId`, not the version, so the `ProductCode` is stable across releases.
Re-verify only if `appId` changes, if `nsis.guid` is ever set explicitly, or
after an electron-builder major-version bump that could move the derivation.

To re-run the check on a machine with PwrSnap installed:

```powershell
Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "PwrSnap*" } | Select-Object PSChildName, @{n="DisplayName";e={(Get-ItemProperty $_.PSPath).DisplayName}}, @{n="Publisher";e={(Get-ItemProperty $_.PSPath).Publisher}}, @{n="DisplayVersion";e={(Get-ItemProperty $_.PSPath).DisplayVersion}}
```

`PSChildName` is the `ProductCode`. `DisplayName` and `Publisher` must match the
`AppsAndFeaturesEntries` block exactly. If any of the three differ, fix the
manifest before opening the pull request.

The `-like "PwrSnap*"` filter is deliberate: **the ARP `DisplayName` carries the
version**, so it reads `PwrSnap 1.0.3`, not `PwrSnap`. That is electron-builder's
default — `nsis.uninstallDisplayName` falls back to `${productName} ${version}`
and this repo does not override it. It is a display string only; both registry
keys that drive upgrade and uninstall (`Software\<APP_GUID>` and the
`Uninstall\<APP_GUID>` key) are keyed on the GUID and do not vary by version.

The practical consequence is that `AppsAndFeaturesEntries.DisplayName` is
version-varying and has to be bumped every release along with the other
per-release values. See "Keeping the manifest current" below.

### Two fields deliberately left out

- **`InstallerSwitches.InstallLocation`.** NSIS takes an install directory as
  `/D=<path>`, which must be unquoted and the final argument on the command
  line. That constraint does not survive winget's switch composition reliably,
  and a half-honored `/D=` installs to the wrong place silently. Leaving it out
  means `winget install --location` reports the option as unsupported, which is
  the honest failure. Users who want a custom directory run the installer
  interactively, where `allowToChangeInstallationDirectory: true` gives them the
  directory page.
- **`AppsAndFeaturesEntries.DisplayVersion`.** winget defaults it to
  `PackageVersion`, and electron-builder writes exactly that. Spelling it out
  would just be one more field to bump every release.

## Submission checklist

Steps 3 onward **must run on Windows.** `winget validate` is part of the winget
client, and `SandboxTest.ps1` drives Windows Sandbox. Neither exists on macOS or
Linux. For headed Windows testing, the environment notes in
[`docs/solutions/2026-08-04-windows-vm-headed-e2e-sizing-readiness.md`](../../solutions/2026-08-04-windows-vm-headed-e2e-sizing-readiness.md)
cover the display-scaling and window-sizing quirks that bite on a VM; the sizing
compensation described there is about our E2E fixture, not about winget, but the
same box is the right place to run this.

### 1. Confirm the release is the one to publish

- [ ] The tag is a stable release, not an alpha/beta/prerelease.
- [ ] `PwrSnap-<version>-windows-x64-setup.exe` is attached to the GitHub release.
- [ ] The installer is Authenticode-signed as `CN=PwrDrvr LLC`.
- [ ] `PwrSnap-windows-SHA256SUMS` is attached and its hash matches the manifest.

```bash
curl -sL https://github.com/pwrdrvr/PwrSnap/releases/download/v1.0.3/PwrSnap-windows-SHA256SUMS
```

### 2. Confirm every URL in the manifests answers 200

A 403 or 404 on any URL earns a `URL-Validation-Error` label.

```bash
for u in https://pwrsnap.com https://docs.pwrsnap.com https://github.com/pwrdrvr/PwrSnap/issues https://github.com/pwrdrvr/PwrSnap/blob/main/LICENSE https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.0.3; do printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -L "$u")" "$u"; done
```

### 3. Fork and sparse-checkout `microsoft/winget-pkgs`

Fork [github.com/microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
to the PwrDrvr account (or the operator's account), then clone with history and
working tree kept minimal — the full repo is enormous.

```powershell
git clone --filter=blob:none --no-checkout https://github.com/<your-account>/winget-pkgs.git
```

```powershell
cd winget-pkgs
git sparse-checkout set manifests\p\PwrDrvr
git checkout
git checkout -b pwrsnap-1.0.3
```

`git sparse-checkout set` needs Git 2.37.0 or newer. The `git checkout` is not
optional even though the folder does not exist upstream yet — it is what creates
the index.

### 4. Copy the manifests into place

The folder path must mirror the package identifier exactly:
`manifests` / first letter of publisher, lowercased / publisher / package /
version.

```powershell
$dest = "manifests\p\PwrDrvr\PwrSnap\1.0.3"
New-Item -ItemType Directory -Force -Path $dest
Copy-Item C:\path\to\PwrSnap\docs\windows\winget\PwrDrvr.PwrSnap*.yaml $dest
```

- [ ] `PackageIdentifier` is `PwrDrvr.PwrSnap` in all three files.
- [ ] `PackageVersion` matches the `1.0.3` folder name in all three files.
- [ ] Exactly three `.yaml` files landed, and no `README.md` or stray file did.

### 5. `winget validate`

```powershell
winget validate --manifest manifests\p\PwrDrvr\PwrSnap\1.0.3
```

Warnings are acceptable; errors are not. If it rejects `ManifestVersion:
1.12.0` as unknown, the winget client on that machine is older than the schema —
update the App Installer package from the Microsoft Store and re-run rather than
downgrading the manifest.

### 6. `SandboxTest.ps1`

This installs winget inside Windows Sandbox and runs the manifest end to end
against the real downloaded installer. It is the step that catches a bad hash,
a silent-install hang, or a broken install path before the pipeline does.

```powershell
powershell .\Tools\SandboxTest.ps1 manifests\p\PwrDrvr\PwrSnap\1.0.3
```

Windows Sandbox must be enabled: **Turn Windows features on or off** →
**Windows Sandbox**, then reboot. It needs Windows Pro, Enterprise, or
Education — Windows Home does not have it. On a Home box, do step 7's local
install check instead and rely on the repo pipeline for sandbox coverage.

- [ ] The install completes without a prompt (proves `/S` works unattended).
- [ ] `winget list PwrDrvr.PwrSnap` shows the package afterward.
- [ ] Uninstall leaves nothing behind.

### 7. Local install check on the test machine

Separate from the sandbox run, because this is where the ARP entry gets checked
and where the app actually gets launched.

- [ ] Silent install lands in `%LOCALAPPDATA%\Programs\PwrSnap`.
- [ ] The registry query from the `ProductCode` section above matches the
      `AppsAndFeaturesEntries` block. `ProductCode` and `Publisher` are stable
      across releases; `DisplayName` carries the version and is the one that
      moves.
- [ ] PwrSnap launches, and Control+Shift+C takes a capture.
- [ ] A `.pwrsnap` file shows the PwrSnap icon in File Explorer.
- [ ] `winget uninstall PwrDrvr.PwrSnap` removes it cleanly.

### 8. Commit, push, open the pull request

One package, one version, one pull request. Nothing outside the `manifests`
folder may be touched, or the submission earns a `PullRequest-Error` label.

```powershell
git add manifests\p\PwrDrvr\PwrSnap\1.0.3
git commit -m "New package: PwrDrvr.PwrSnap version 1.0.3"
git push --set-upstream origin pwrsnap-1.0.3
```

Then open the pull request against `microsoft/winget-pkgs` `master`.

## Labels to expect on the pull request

Microsoft's automation labels the pull request as it moves. The full catalog is
in the
[Learn docs](https://learn.microsoft.com/en-us/windows/package-manager/package/repository).
The ones that matter for a submission shaped like ours:

### Good path

| Label | Meaning |
| --- | --- |
| `Azure-Pipeline-Passed` | Test pass finished. Waiting on approval; auto-approves if nothing was flagged. |
| `Validation-Completed` | Test pass succeeded and the pull request will merge. |

### Wants something from us

| Label | Meaning |
| --- | --- |
| `Needs-Author-Feedback` | Reassigned back to us. The bot closes the pull request if it sits 10 days. |
| `Blocking-Issue` | Cannot be approved; an accompanying error label says why. |
| `Needs-Attention` | Kicked to the winget team for manual review. |

### Errors this package could plausibly hit

| Label | Meaning for us |
| --- | --- |
| `Error-Hash-Mismatch` | `InstallerSha256` does not match what the URL serves. Re-derive from `PwrSnap-windows-SHA256SUMS`. |
| `Validation-Hash-Verification-Failed` | Same mismatch, caught later during install testing. |
| `Error-Installer-Availability` | The validation service could not download the installer. Usually a transient GitHub fetch; comment on the pull request. |
| `Validation-Unattended-Failed` | The install timed out — it did not run silently. Re-check `/S` in a sandbox. |
| `Validation-Executable-Error` | The test could not find the installed app. Check the install path and `InstallationMetadata`. |
| `Validation-Uninstall-Error` | Uninstall left files or registry keys behind. |
| `Manifest-Validation-Error` | A schema or syntax problem. Re-run `winget validate` and the local schema check. |
| `Manifest-Path-Error` | The folder path does not match `manifests\p\PwrDrvr\PwrSnap\<version>`. |
| `PullRequest-Error` | Files outside `manifests`, or more than one package/version in the pull request. |
| `URL-Validation-Error` | Some URL returned 403/404 or failed a reputation check. Step 2 above is the pre-check. |
| `Validation-Domain` / `Validation-Unapproved-URL` | The installer URL is not recognized as coming from the publisher. Our GitHub release URL is the publisher's own release location; if it trips, comment on the pull request. |
| `Validation-Indirect-URL` | A redirector was detected. Always use the direct `releases/download/<tag>/<file>` URL, never a `latest/download` alias. |
| `Validation-HTTP-Error` | Installer URL is not HTTPS. |
| `Binary-Validation-Error` | An antivirus in the scan pool flagged the installer. Authenticode signing makes this unlikely; if it happens, [submit it to Microsoft Defender as a false positive](https://www.microsoft.com/wdsi/filesubmission). |
| `Validation-Defender-Error` | Defender flagged something during dynamic testing. |
| `Validation-Merge-Conflict` | Rebase on upstream `master` and push again. |
| `Policy-Test-2.x` | Metadata triggered a manual content review against the repo content policies. |

`Internal-Error-*` labels are the winget team's to chase, not ours.

## Keeping the manifest current

Two workable options; the second is the recommendation for now.

**Automate from the release workflow.** Microsoft's `wingetcreate` can fetch a
new installer, recompute the hash, clone the fork, and open the pull request in
one command:

```powershell
wingetcreate update PwrDrvr.PwrSnap --urls "https://github.com/pwrdrvr/PwrSnap/releases/download/v<version>/PwrSnap-<version>-windows-x64-setup.exe" --version <version> --submit --token $env:WINGET_PAT
```

Wiring that into the `publish-release-assets` job in
[`.github/workflows/release.yml`](../../../.github/workflows/release.yml) needs
three things that do not exist today: a Windows runner in that job (it currently
runs on `ubuntu-24.04`), a GitHub token with `public_repo` scope on the
`winget-pkgs` fork stored as a repository secret, and a guard so it only fires
for stable tags — every CI release is born a prerelease, and shipping an alpha
to the community repo would be wrong. It also submits unattended, which means a
bad release reaches a public catalog with no human in the loop.

**Bump manually, one pull request per stable release.** Copy the previous
version's three files, then change:

- `PackageVersion` — all three files.
- `InstallerUrl`, `InstallerSha256`, `ReleaseDate` — installer manifest.
- `AppsAndFeaturesEntries.DisplayName` — installer manifest. This one is easy to
  miss. It carries the version (`PwrSnap 1.0.3`), so it moves every release.
- `ReleaseNotesUrl` — locale manifest.

Then walk the checklist above. Stable releases are infrequent enough that the automation's setup cost
and its unattended-submission risk both outweigh the few minutes it saves, and a
human confirming that the app actually launches on Windows before it reaches a
public catalog is worth keeping. Revisit if the stable cadence tightens.

**Worth considering either way: pin `nsis.uninstallDisplayName`.** Setting it to
`PwrSnap` in [`apps/desktop/electron-builder.yml`](../../../apps/desktop/electron-builder.yml)
would stop the ARP `DisplayName` from carrying the version, which removes one
per-release value from the list above and drops the redundant version string
from Add or Remove Programs, where the adjacent Version column already shows it.
The installer rewrites `DisplayName` on every install and the upgrade path
uninstalls the prior version first, so the change self-heals on upgrade rather
than leaving stale entries. It does not affect upgrade or uninstall detection,
both of which key on the GUID. It is a change to shipped installer behavior
though, so it belongs in its own release rather than in a docs change — and
v1.0.3 is already published, so this manifest has to say `PwrSnap 1.0.3`
regardless.

**Not this task.** No CI wiring and no installer change are being made here —
this section is the proposal, and picking between the options is the operator's
call.
