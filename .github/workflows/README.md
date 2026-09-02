# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep new labels namespaced
with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `build-preview` | `preview-build.yml` | Builds unsigned macOS DMG and Windows NSIS preview artifacts. This is the existing combined preview path. |
| `ci:windows-signing` | `release.yml` | Runs the release workflow's Windows prepare/sign jobs for a same-repository PR, verifies Authenticode, and uploads `windows-signed-installer-pr`. The protected job receives the staged archive without checking out source or installing project dependencies. PR events cannot run `publish-release-assets`. Add the label only for a reviewed signing change, temporarily allow `refs/pull/<number>/merge` in the environment, and remove that rule after validation. |
| `ci:windows-updater-smoke` | `release.yml` | Builds two marker-gated, Azure-signed synthetic prereleases in the protected job, then installs and updates them against a loopback-only feed on a fresh credential-free Windows runner. Inputs never enter publication globs and PR events cannot publish. Use only on a reviewed same-repository PR with the same temporary exact merge-ref environment rule described for `ci:windows-signing`. |

If another label changes workflow behavior, document it here in the same change.
