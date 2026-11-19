# Windows Code Signing (Azure Artifact Signing)

PwrSnap signs its Windows application executables, generated uninstaller, and
NSIS installer with Azure Artifact Signing (formerly Trusted Signing). The
portal uses the new name; electron-builder still calls the configuration
`win.azureSignOptions`, and the PowerShell module is still `TrustedSigning`.

Release signing fails closed. Tagged release CI passes `--require-signing`, so
missing or partial configuration cannot produce an unsigned release. Unsigned
local and preview builds remain available through `package:win` and the
`build-preview` workflow.

For deliberate end-to-end validation, `ci:windows-signing` runs the existing
release workflow's Windows prepare/sign jobs for a same-repository PR. Its
preparation job has no credentials. Its protected job verifies the prepared
archive, downloads the pinned Windows FFmpeg artifact, installs TrustedSigning,
packages with `--require-signing`, verifies the installer and application
Authenticode signatures, and uploads `windows-signed-installer-pr`. The release
publication job is explicitly disabled for PR events.

`ci:windows-updater-smoke` uses the same reviewed prepare/protected-sign
boundary, but produces two marker-gated synthetic prereleases instead of a
publishable installer. A separate hosted Windows job—with no environment,
checkout, credentials, or dependency install—serves the newer package from
`127.0.0.1`, installs the baseline, and exercises the real
download/install/relaunch path. See
[Packaged Windows updater smoke](windows/packaged-updater-smoke.md).

The environment's normal deployment policy should remain limited to `v*` tags.
To run either signed PR smoke check, temporarily allow the exact synthetic
merge ref (`refs/pull/<number>/merge`), approve the protected job, then remove
the branch rule after validation. GitHub evaluates environment deployment
rules against that merge ref rather than the PR's head branch. Never approve a
fork PR or an unreviewed head SHA: the staged packaging code runs with the
service-principal credentials during the irreducible signing step.

## GitHub environment

Create the protected `windows-signing` environment in `pwrdrvr/PwrSnap`, with
the same protection rules and Azure values used by PwrAgent. Only the
`windows-sign` job declares this environment, and that job does not check out
source or install dependencies.

Configure these environment **variables**:

| Variable | PwrDrvr value |
|---|---|
| `WIN_AZURE_SIGN_ACCOUNT` | `pwrdrvrsigning` |
| `WIN_AZURE_SIGN_ENDPOINT` | `https://eus.codesigning.azure.net/` |
| `WIN_AZURE_SIGN_PUBLISHER_NAME` | `PwrDrvr LLC` |
| `WIN_AZURE_SIGN_PROFILE` | `pwrdrvr-public-trust` |
| `FFMPEG_BUILDS_APP_CLIENT_ID` | Client ID for the read-only FFmpeg artifact GitHub App |

Configure these environment **secrets**:

| Secret | Purpose |
|---|---|
| `AZURE_TENANT_ID` | Entra directory/tenant ID |
| `AZURE_CLIENT_ID` | Entra application/client ID |
| `AZURE_CLIENT_SECRET` | Entra client-secret value |
| `FFMPEG_BUILDS_APP_PRIVATE_KEY` | Read-only access to the pinned Windows FFmpeg artifact |

The Azure service principal needs the `Artifact Signing Certificate Profile
Signer` role on the signing account. The profile must be **Public Trust**, not
`Public Trust Test`; the test profile signs successfully but still produces an
untrusted SmartScreen chain. `WIN_AZURE_SIGN_PUBLISHER_NAME` must match the
validated certificate Common Name exactly.

## Trust boundary

The release workflow has two Windows jobs:

1. `windows-prepare` checks out the tag, installs dependencies, builds PwrSnap,
   creates a hoisted `release-stage`, archives it, and records its SHA-256. It
   has no signing environment or Azure credentials.
2. `windows-sign` downloads and verifies that exact archive, downloads and
   verifies the pinned FFmpeg artifact, installs `TrustedSigning`, then runs
   `package-win.mjs --sign-stage-only --release --require-signing` for a real
   release. For the updater gate it instead packages the isolated pair with
   `package-win-update-smoke.mjs --sign-stage-only --require-signing`. It does
   not check out source or run pnpm/npm lifecycle scripts.
3. `windows-updater-smoke` downloads only the isolated signed-pair artifact on
   a fresh Windows runner and launches PwrSnap there. Azure values are scoped
   to the packaging step in `windows-sign`; this job declares no protected
   environment and receives none of them.

Windows packaging cannot sign only the final installer after the fact:
electron-builder signs multiple application and NSIS payloads while it builds
the installer. Packaging is therefore the irreducible operation inside the
protected job.

The protected job uploads signed Windows artifacts to the workflow. A separate
`publish-release-assets` job creates the GitHub Release only after the Linux
build gate, signed/notarized macOS package, signed Windows package, and
credential-free packaged updater smoke all succeed.

For PR events, the release workflow runs only the requested Windows validation
path and never the publication job. `ci:windows-signing` stops at the uploaded
installer; `ci:windows-updater-smoke` continues only into the credential-free
hosted updater job. The protected signing job performs no checkout and no
package installation.

## Failure modes

| Configuration | Result |
|---|---|
| No Azure values, local or preview build | Unsigned package |
| Some `WIN_AZURE_SIGN_*` values | Fail before packaging |
| All signing variables but missing `AZURE_*` credentials | Fail before packaging |
| Tagged release without the environment/configuration | Fail because `--require-signing` is set |
| Invalid/expired credentials or missing RBAC role | Fail at the signing call |

Verify a release on Windows with:

```powershell
signtool verify /pa /v PwrSnap-<version>-windows-x64-setup.exe
```

The signature should chain to a Microsoft public CA and have subject
`CN=PwrDrvr LLC`. Azure's short-lived signing certificates are expected; the
timestamp keeps existing signatures valid. Track the Entra client-secret
expiry and Azure identity-validation renewal instead.
