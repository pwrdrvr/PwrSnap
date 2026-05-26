# PwrSnap

**Capture stays on your laptop until you opt in. Enable AI and your captures
ride your existing OpenAI Codex install — no new cloud provider, no new
account.**

A macOS-first capture + library app with global hotkeys for region, window,
and full-screen snaps. A float-over toast that copies a Low / Med / High
render to the clipboard in one click. A menu-bar tray that surfaces the last
capture for instant re-copy or edit. And — because the AI brain is the
Codex CLI / Codex Desktop you already have installed — annotation, smart
filenames, descriptions, and sensitive-data review go through your existing
OpenAI Codex plan, billed to the AI cloud provider you've already set Codex
up with. No new cloud provider for PwrSnap to talk to, no new account to
manage, no telemetry.

<p>
  <a href="https://github.com/pwrdrvr/PwrSnap/releases/latest/download/PwrSnap.dmg">
    <img src="docs/assets/buttons/download-macos.png" alt="Download for macOS" width="440">
  </a>
  &nbsp;
  <a href="https://docs.pwrsnap.com">
    <img src="docs/assets/buttons/read-the-docs.png" alt="Read the docs" width="440">
  </a>
</p>

## Why you might want it

- **Capture is instant, and it's where your fingers already are.** `⌘⇧C`
  for quick capture (snap to a window, drag a region, or hit `⇧` at
  commit time for occlusion-free full-window). Dedicated chords for
  region-only and window-only modes. Every binding is editable from
  **Settings → Hotkeys** and rebinds without a restart.
- **The library knows where the snap came from.** Captures auto-group by
  source app (Chrome, Slack, Xcode, Figma…) with first-class buckets in
  the sidebar. Filter by app. Virtualized grid stays smooth at thousands
  of rows. Drag a capture straight out to Finder, Messages, or any drop
  target.
- **One-click copy at the resolution you actually want.** Right after
  every capture, the float-over toast pops up with **Low**, **Med**, and
  **High** preset copies. The renderer caches the bytes per preset, so
  the second paste — including from a global copy hotkey while the toast
  is up — is instant.
- **Menu-bar surface for the last snap.** The tray popover always shows
  the most recent capture with an Edit button and quick re-copy. One
  click away from anywhere on the OS, no Library window needed.
- **AI rides the Codex you already have, on your existing plan.** PwrSnap
  is a Codex App Server *client* — it talks stdio JSON-RPC to your local
  Codex CLI / Codex Desktop install for annotation, description
  generation, smart filenames, sensitive-data scan, and (Phase 5+) voice
  describe. The image-bearing turns then hit whichever AI cloud provider
  Codex is set to talk to (OpenAI by default — Codex itself is an OpenAI
  product — but Codex can be configured to route elsewhere), billed to
  the plan you already have with that provider through Codex. PwrSnap
  itself opens no new account, holds no API key of its own, and never
  calls a model provider directly. Settings → AI Providers auto-discovers
  every Codex binary on the system and lets you pin a specific path.
- **Local-first and quiet.** Captures land under
  `~/Library/Application Support/PwrSnap/` as SQLite (WAL) plus a
  content-addressed source store. Secrets are encrypted at rest via
  Electron `safeStorage` (macOS Keychain backend); the renderer only
  ever sees a `{ configured, lastSetAt }` shape — plaintext never crosses
  the IPC boundary. No telemetry. No PwrSnap-owned account, no
  PwrSnap-owned cloud sync. (AI features, when enabled, do ride your
  existing OpenAI Codex plan — see the AI bullet above.)

The longer-form pitch is at **[pwrsnap.com](https://pwrsnap.com)**;
operator setup + feature reference at
**[docs.pwrsnap.com](https://docs.pwrsnap.com)**.

## Get it

### Just want to use it

1. **Download** [PwrSnap.dmg](https://github.com/pwrdrvr/PwrSnap/releases/latest/download/PwrSnap.dmg).
   Universal binary — runs natively on Apple Silicon (M1+) and Intel
   Macs. Once release infrastructure goes live the binary will be
   Developer ID-signed and Apple-notarized, so first launch is a single
   Gatekeeper prompt (no right-click-open dance).
2. **Install** by opening the DMG and dragging PwrSnap into Applications.
3. **(Optional) Wire up Codex** from **Settings → AI Providers** to light
   up annotation, smart filenames, and descriptions. If you don't have a
   Codex install, capture and library still work; the AI surfaces are
   just hidden.

Updates flow through `electron-updater` against the GitHub release feed.
Switch between stable and prerelease channels in **Settings →
Experimental → Update channel**. The Help menu's **Check for Updates**
runs an on-demand check; when a new version finishes downloading, an
inline banner in the Library window offers a one-click restart.

### Want to hack on it

```bash
git clone https://github.com/pwrdrvr/PwrSnap.git
cd PwrSnap
pnpm install
pnpm dev
```

PwrSnap is a pnpm workspace (`apps/desktop` + `packages/*`). The Codex
App Server protocol types are generated from a locally installed Codex
binary — run `pnpm codex:generate-protocol` after Codex Desktop
auto-updates or a new protocol surface lands. Full dev workflow,
conventions, and the active buildout plan live in
**[AGENTS.md](AGENTS.md)** and **[docs/plans/](docs/plans/)**.

## How it's built

| Layer                | Stack                                                    | Where it lives                                  |
| -------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Desktop shell        | Electron + TypeScript + React 19 + electron-vite         | `apps/desktop/`                                 |
| Capture pipeline     | `screencapture(1)` + native Swift `window-list` helper   | `apps/desktop/src/main/capture/`                |
| Render pipeline      | `sharp` for resize + crop + thumbnail caching            | `apps/desktop/src/main/render/`                 |
| Persistence          | `better-sqlite3` (WAL) + content-addressed source store  | `apps/desktop/src/main/persistence/`            |
| Codex App Server     | TypeScript protocol contracts, stdio JSON-RPC client     | `packages/codex-app-server-protocol/`           |
| Shared types         | Cross-process commands + IPC channels + result envelopes | `packages/shared/`                              |
| Settings + secrets   | Single substrate (JSON + Electron `safeStorage`)         | `apps/desktop/src/main/settings/`               |

A few load-bearing design rules:

- **Single command bus.** Every IPC verb routes through
  [`apps/desktop/src/main/command-bus.ts`](apps/desktop/src/main/command-bus.ts) —
  ipcMain today, HTTP RPC and MCP later. Exactly one place to register
  a command; exactly one place to enforce auth + capability checks.
- **Renderers stay sandboxed.** Every `BrowserWindow` is
  `contextIsolation: true, sandbox: true, nodeIntegration: false`.
- **Result-pattern for cross-process errors.** Electron `invoke` strips
  `instanceof`. All handlers return `Result<Res, PwrSnapError>` —
  `{ ok: false, error: { kind, code, message, cause? } }`.

## Roadmap

macOS-first today. Linux and Windows are deferred to Phase 8 of the
[buildout plan](docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md).

What's shipped vs. what's still in flight — including video capture, the
sizzle-reel composer, and presenter video — will land at
**[docs.pwrsnap.com](https://docs.pwrsnap.com)** once the docs site goes
live.

The desktop release pipeline (universal DMG, signing, notarization,
auto-update, stable `PwrSnap.dmg` URL) is documented in
[docs/desktop-release-runbook.md](docs/desktop-release-runbook.md).

## Going deeper

| Doc                                                                                                | What it covers                                                                            |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **[pwrsnap.com](https://pwrsnap.com)**                                                             | Marketing landing — the WHY in 60 seconds.                                                |
| **[docs.pwrsnap.com](https://docs.pwrsnap.com)**                                                   | Operator reference — capture modes, hotkeys, settings, AI configuration.                  |
| [AGENTS.md](AGENTS.md)                                                                             | Project conventions, brand rules, "how the load-bearing pieces fit together." Read first. |
| [docs/desktop-release-runbook.md](docs/desktop-release-runbook.md)                                 | One-time setup, CI release path, local fallback, universal DMG verification.              |
| [docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md](docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md) | Active feature buildout plan — phase order, scope, decisions.                             |
| [docs/solutions/](docs/solutions/)                                                                 | Post-incident notes + gotchas — read before re-solving an old problem.                    |
| [packages/codex-app-server-protocol/](packages/codex-app-server-protocol/)                         | Generated Codex App Server protocol types + regeneration recipe.                          |

## License

PwrSnap is licensed under the [MIT License](LICENSE). Third-party
dependency notices are aggregated in
[THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES) and shipped with desktop
distributions.

Created by [PwrDrvr LLC](https://pwrdrvr.com). Copyright © 2026 PwrDrvr LLC.
