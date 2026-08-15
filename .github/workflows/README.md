# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep new labels namespaced
with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `build-preview` | `preview-build.yml` | Builds unsigned macOS DMG and Windows NSIS preview artifacts. This is the existing combined preview path. |
| `ci:windows-package` | `ci.yml` | Exercises the release workflow's hoisted Windows prepare/archive/package boundary and uploads an unsigned NSIS installer. It never receives Azure signing credentials. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. Tagged releases build and sign Windows automatically. |

If another label changes workflow behavior, document it here in the same change.
