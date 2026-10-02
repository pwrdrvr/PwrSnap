# winget submission — `PwrDrvr.PwrSnap`

This directory contains a historical starter for PwrSnap's first Windows Package
Manager community submission. On 2026-10-02, the remote
`microsoft/winget-pkgs:master` path `manifests/p/PwrDrvr/PwrSnap` was absent
and submission searches found no PR, so this command was not yet supported:

```powershell
winget install PwrDrvr.PwrSnap
```

The three manifests describe **1.0.3**, not a published Winget catalog entry.
Read the [package-manager release runbook](../../package-manager-release-runbook.md)
before every release to compare GitHub's eligible stable versions against remote
Winget manifests and pending submissions. That runbook defines update and
post-merge source/install/upgrade verification for this checklist. Reinspect
the remote repository before deciding whether to create or update the package.

**Submitting the pull request to `microsoft/winget-pkgs` is the operator's
call.** Nothing in this directory submits anything on its own.

## What is here

| File | Role |
| --- | --- |
| [`PwrDrvr.PwrSnap.yaml`](PwrDrvr.PwrSnap.yaml) | Version manifest — ties the package id, version, and default locale together. |
| [`PwrDrvr.PwrSnap.installer.yaml`](PwrDrvr.PwrSnap.installer.yaml) | Installer manifest — URL, hash, installer type, silent switches, scope. |
| [`PwrDrvr.PwrSnap.locale.en-US.yaml`](PwrDrvr.PwrSnap.locale.en-US.yaml) | Default-locale manifest — the human-facing metadata `winget show` prints. |
| [`validate-manifests.mjs`](validate-manifests.mjs) | Cross-platform schema pre-check for the three manifests above. |

Current contents describe **v1.0.3**, a historical signed release. Prepare a
reviewable payload for the newest appropriate promoted stable version; replace
the `1.0.3` examples below with that target and its actual metadata. Alpha, beta,
and RC tags are excluded by PwrSnap's stable-package policy. A bare SemVer tag
still marked GitHub Pre-release must wait for operator smoke checks and manual
promotion before submission.

## Schema version

`ManifestVersion: 1.12.0`, with the matching
`# yaml-language-server: $schema=https://aka.ms/winget-manifest.*.1.12.0.schema.json`
header on each file.

The original schema check used manifests merged on 2026-08-22 and
`wingetcreate 1.12.x` output. Upstream also carried newer schema snapshots at
that time. `winget validate` understands only schemas supported by its client
build. Recheck current upstream requirements and the validator's supported
schema before an update; the 2026-08-22 observation does not establish today's
accepted schema version.

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

The `-like "PwrSnap*"` filter is deliberate, and which name it matches depends on
when the installer was built:

| Installer | ARP `DisplayName` | Manifest `AppsAndFeaturesEntries.DisplayName` |
| --- | --- | --- |
| v1.0.3 and earlier | `PwrSnap <that build's version>` | `PwrSnap 1.0.3` in the v1.0.3 manifest |
| built after `nsis.uninstallDisplayName` was pinned | `PwrSnap` | `PwrSnap` |

v1.0.3 shipped before [`apps/desktop/electron-builder.yml`](../../../apps/desktop/electron-builder.yml)
set `nsis.uninstallDisplayName`, so it inherited electron-builder's
`${productName} ${version}` default. That installer is published and immutable,
so **its manifest keeps `PwrSnap 1.0.3`** — the field's job is to state the true
ARP name, whatever it is. Releases built after the pin write a stable `PwrSnap`,
and their manifests should say `PwrSnap`.

The name is a display string only. Both registry keys that drive upgrade and
uninstall (`Software\<APP_GUID>` and the `Uninstall\<APP_GUID>` key) are derived
from `appId` and do not vary by version, so the change self-heals on upgrade
rather than stranding v1.0.3 installs. winget's correlation rides the
`ProductCode`, which is likewise unaffected.

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
- [ ] The release is public/non-draft and `prerelease=false` after operator
      promotion; compare all promoted stable versions and GitHub Latest.
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
      across releases; current installers use stable `DisplayName: PwrSnap`.
- [ ] PwrSnap launches, and Control+Shift+C takes a capture.
- [ ] A `.pwrsnap` file shows the PwrSnap icon in File Explorer.
- [ ] `winget uninstall PwrDrvr.PwrSnap` removes it cleanly.
- [ ] Upgrade from the previous stable install preserves settings/captures and
      remains correlated with the exact package ID. Use an isolated test host;
      do not uninstall or reset the operator's real installation.

### 8. Commit, push, open the pull request

One package, one version, one pull request. Nothing outside the `manifests`
folder may be touched, or the submission earns a `PullRequest-Error` label.

```powershell
git add manifests\p\PwrDrvr\PwrSnap\1.0.3
git commit -m "New package: PwrDrvr.PwrSnap version 1.0.3"
git push --set-upstream origin pwrsnap-1.0.3
```

Then open the pull request against `microsoft/winget-pkgs` `master`.
Record the submission URL and named owner. After merge, re-read the remote
manifest, refresh `winget` source, and verify exact-ID show/install/upgrade as
specified in the package-manager runbook. A merged PR still awaiting index
availability is pending distribution, not a completed client check.

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

Use the [package-manager release runbook](../../package-manager-release-runbook.md)
on every release. There is no PwrSnap CI submission wiring. Check the remote
package and existing PRs first: `wingetcreate update` requires an existing
accepted package and cannot create the first submission. Once published,
prefer generating a payload without submitting, then validate on Windows:

```powershell
wingetcreate update PwrDrvr.PwrSnap --urls "https://github.com/pwrdrvr/PwrSnap/releases/download/v<version>/PwrSnap-<version>-windows-x64-setup.exe" --version <version> --out .local\winget
```

**For a first submission or manual bump**, copy the previous
version's three files, then change:

- `PackageVersion` — all three files.
- `InstallerUrl`, `InstallerSha256`, `ReleaseDate` — installer manifest.
- `AppsAndFeaturesEntries.DisplayName` — installer manifest. **Stable at
  `PwrSnap` for anything built after `nsis.uninstallDisplayName` was pinned.**
  Only the v1.0.3 manifest carries `PwrSnap 1.0.3`, because that installer
  predates the pin. Set it once when bumping off v1.0.3, then leave it alone.
- `ReleaseNotesUrl` — locale manifest.

Then walk the checklist above. Submit the validated directory with
`wingetcreate submit <manifest-directory>` using interactive GitHub login, or
the fork PR procedure. Track review, manifest acceptance, source indexing and
installation/upgrade separately; record blockers and an owner through completion.

**Done: `nsis.uninstallDisplayName` is pinned.**
[`apps/desktop/electron-builder.yml`](../../../apps/desktop/electron-builder.yml)
now sets it to `PwrSnap`, so the ARP name no longer carries the version and
`DisplayName` stops being a per-release value. Pinned by
[`windows-release-config.test.mjs`](../../../apps/desktop/scripts/windows-release-config.test.mjs).
v1.0.3 shipped before the change and keeps `PwrSnap 1.0.3` in its manifest.

**No CI wiring here.** Automating submission would need a separate approved
design that gates on operator promotion, not merely a stable-looking tag.
