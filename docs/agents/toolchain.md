# Agent rules: Node, pnpm and Linux sandbox setup

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Dependencies and tooling

- Node version pinned in `.nvmrc` (currently `v24.22.0`, the Node inside
  Electron 44). Every GitHub Actions job asks for `^24.22.0`, the same range,
  so a runner uses the 24.x already in its tool cache. Move `.nvmrc` and the
  workflow pins together.
- Package manager: `pnpm@12.13.0` (set in root `package.json`'s
  `packageManager` field).
- Electron + electron-vite versions pinned in `apps/desktop/package.json`,
  matching PwrAgnt for tool consistency.

## Node / native module ABI hygiene

Always enter the repo with nvm before installing dependencies:

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm install
```

On Windows, nvm-windows requires an explicit version from `.nvmrc`. Select its
installed Node directory in the current PowerShell session; `nvm use` changes
a shared junction and can require elevation. Corepack and pnpm use `.cmd` shims:

```powershell
$nodeVersion = (Get-Content -LiteralPath .nvmrc -Raw).Trim().TrimStart('v')
nvm install $nodeVersion
$nodeDir = Join-Path $env:NVM_HOME "v$nodeVersion"
$env:Path = "$nodeDir;$env:Path"
corepack.cmd enable
pnpm.cmd install
```

The root `preinstall` script ([check-node-version.mjs](../../scripts/check-node-version.mjs))
checks that `node` satisfies `^<.nvmrc>`: the same major, and no older than
the pin. `pnpm dev` applies the same rule. On local POSIX machines with
`~/.nvm`, it also checks that the active Node binary comes from nvm. Do not
bypass this check. It required an exact match until every native addon was
N-API; do not tighten it back, or a runner's cached Node fails every install.

PwrSnap's native addons (better-sqlite3 and sharp) are N-API, so one prebuilt
binary loads in system Node and in Electron alike, and there is no
`NODE_MODULE_VERSION` to rebuild for. `pnpm rebuild:electron-native` now only
builds the platform helpers (`build-native.mjs`, the same as `build:native`).
The name is kept because tooling outside this repo, including the PwrSuiteLab
PwrSnap workload, runs it.

## Linux sandbox setup

Install and desktop dev/preview warn when Electron's setuid helper is not
root-owned with mode 4755. The warning is advisory: user namespaces may allow
launch without it. For the fatal SUID sandbox error, use
`pnpm fix:linux-sandbox`; it resolves this checkout's Electron helper and uses
sudo only for chown/chmod. Do not run the app as root or disable its sandbox.
Run `pnpm check:linux-sandbox` from the repository root for a read-only advisory
check. Both commands
safely no-op on non-Linux platforms. The helper may need repair after
reinstallation or Electron replacement. This fixes permissions,
not renderer/window visibility or host mount/security policy.

Keep a separate `pnpm install` per checkout/worktree. Root `node_modules` alone
cannot supply a fresh workspace's package-local dependency links. Sharing
package node_modules can resolve workspace imports into the donor checkout,
and installs/native staging then mutate shared dependencies. A symlink to the
same repaired helper inherits its permissions but is not a complete setup fix.
