# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep new labels namespaced
with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `build-preview` | `preview-build.yml` | Builds unsigned macOS DMG and Windows NSIS preview artifacts. This is the existing combined preview path. |
| `ci:windows-signing` | `release.yml` | Runs the release workflow's Windows prepare/sign jobs for a same-repository PR, verifies Authenticode, and uploads `windows-signed-installer-pr`. The protected job receives the staged archive without checking out source or installing project dependencies. PR events cannot run `publish-release-assets`. Add the label only for a reviewed signing change, temporarily allow `refs/pull/<number>/merge` in the environment, and remove that rule after validation. |

If another label changes workflow behavior, document it here in the same change.

## Windows installer name

The release publishes two Windows installer assets that are the same bytes:
`PwrSnap-<version>-windows-x64-setup.exe`, which `latest.yml` names and
electron-updater downloads, and `PwrSnap.Setup.exe`, a stable alias so
`releases/latest/download/PwrSnap.Setup.exe` keeps working across versions —
the Windows counterpart to `PwrSnap.dmg`. The versioned asset is never renamed
away.

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
takes `PwrSnap.Setup.Arm.exe`.
