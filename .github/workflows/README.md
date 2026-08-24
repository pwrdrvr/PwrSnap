# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep new labels namespaced
with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `build-preview` | `preview-build.yml` | Builds unsigned macOS DMG and Windows NSIS preview artifacts. Before upload, the Windows lane installs and launches its exact NSIS artifact with isolated app data and proves main/renderer/SQLite/Sharp readiness plus clean exit/uninstall. |
| `ci:windows-signing` | `release.yml` | Runs the release workflow's Windows prepare/sign jobs for a same-repository PR, verifies Authenticode, then installs and launches the signed NSIS with the same isolated runtime/native readiness gate before uploading `windows-signed-installer-pr`. The protected job receives the staged archive without checking out source or installing project dependencies, and the smoke receives no Azure credentials. PR events cannot run `publish-release-assets`. Add the label only for a reviewed signing change, temporarily allow `refs/pull/<number>/merge` in the environment, and remove that rule after validation. |

If another label changes workflow behavior, document it here in the same change.
