# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep new labels namespaced
with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `build-preview` | `preview-build.yml` | Builds unsigned macOS DMG and Windows NSIS preview artifacts. This is the existing combined preview path. |
| `ci:windows-package` | `ci.yml` | Exercises the release workflow's hoisted Windows prepare/archive/package boundary and uploads an unsigned NSIS installer. It never receives Azure signing credentials. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. Tagged releases build and sign Windows automatically. |
| `ci:windows-signing` | `windows-signing-smoke.yml` | Runs a credential-free TrustedSigning preflight, then, for same-repository PRs only, requests the protected `windows-signing` environment and produces a signed installer without publishing. The protected job verifies a staged archive, installs no project dependencies, verifies Authenticode, and uploads `windows-signed-installer-pr`. Add the label only for a reviewed signing change, temporarily allow the branch in the environment, and remove that branch rule after validation. |

If another label changes workflow behavior, document it here in the same change.
