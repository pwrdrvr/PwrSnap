# Windows Code Signing (Azure Artifact Signing)

PwrSnap signs its Windows application executables, generated uninstaller, and
NSIS installer with Azure Artifact Signing (formerly Trusted Signing). The
portal uses the new name; electron-builder still calls the configuration
`win.azureSignOptions`, and the PowerShell module is still `TrustedSigning`.

Release signing fails closed. Tagged release CI passes `--require-signing`, so
missing or partial configuration cannot produce an unsigned release. The
`ci:windows-package` PR label intentionally builds unsigned: it exercises the
same hoisted prepare/archive/package path without exposing credentials or using
the signing quota. There is no PR label that grants signing credentials.

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
   `package-win.mjs --sign-stage-only --release --require-signing`. It does not
   check out source or run pnpm/npm lifecycle scripts.

Windows packaging cannot sign only the final installer after the fact:
electron-builder signs multiple application and NSIS payloads while it builds
the installer. Packaging is therefore the irreducible operation inside the
protected job.

The job uploads a signed Windows artifact to the workflow. A separate
`publish-release-assets` job creates the GitHub Release only after the Linux
build gate, signed/notarized macOS package, and signed Windows package all
succeed.

## Failure modes

| Configuration | Result |
|---|---|
| No Azure values, local or `ci:windows-package` build | Unsigned package |
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
