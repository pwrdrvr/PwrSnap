# PwrSnap architecture and direction

The durable decisions — what PwrSnap is, and the shape choices that are
still true. It replaces the historical phase plans that used to live in
`docs/plans/` (pruned 2026-09-03); it deliberately carries **no** task
lists, phase order, or status tracking. Those belong in issues and PRs.

- **Enforcement rules** (the things a change can violate) live in
  [AGENTS.md](../AGENTS.md). This file explains *why*; AGENTS.md says
  *what you must not break*.
- **Post-incident notes** live in [docs/solutions/](solutions/).
- **Shipped-behavior docs** live beside this file — the
  [bundle format spec](architecture-bundle-format.md),
  [release runbook](desktop-release-runbook.md),
  [Windows guide](windows/README.md),
  [Windows port status](windows/port-status.md),
  [Windows signing](desktop-windows-signing.md),
  [ffmpeg builds](ffmpeg-build-reference.md),
  [third-party notices](third-party-license-notices.md).

## What PwrSnap is

A capture, annotate, and share tool that replaces SnagIt — ships on macOS
and Windows, MIT licensed, from PwrDrvr LLC.

The founding complaints it exists to answer: SnagIt's subscription pricing,
its sluggish region selector over remote desktop, its hand-tuned arrows that
look like needles on retina captures, a history browser that loses your place
when you edit, no AI, and a separate $300 product for video.

The shortest goal it is measured against is unchanged: **⌘⇧C → screenshot →
clipboard → paste into Slack.** Everything else is layered on top of that
path staying instant.

Two things it is **not**:

- **Not an image editor.** PwrSnap is an annotator. The layer model is
  plumbing that makes annotations composable and machine-writable — it is
  not an invitation to build Photoshop. New surface that only makes sense
  to someone editing images, rather than someone marking up a screenshot,
  is out of scope by default.
- **Not an AI product with a capture feature.** AI is a second user of the
  same primitives a human uses. An AI-placed arrow is an ordinary arrow that
  happens to carry `source: "ai"`.

## Storage: data, not pixels

The source raster is immutable. Every annotation is structured data, and the
composite is rendered on demand and cached, keyed by content.

This is the single decision the most code depends on. It is what makes
per-annotation undo a delete rather than a frame reconstruction, keeps one
raster on disk instead of two, lets AI propose an annotation as data the
user can accept or reject, and keeps OCR and search running against
unredacted pixels while the user sees the redacted composite.

The *shape* of that data has changed and will change again — the original
flat `overlays` SQLite table is gone, replaced by the v2 layer tree. The
principle is what carries forward, not the schema.

**Captures are files the user owns.** `.pwrsnap` bundles live in the user's
Documents folder (`~/Documents/PwrSnap` by default, relocatable), not buried
in application support. SQLite is an *index* over those bundles — fast
listing, search, and metadata — never the only copy of a user's work. A
wiped `userData` must cost the user their index, not their captures.

That choice is why `~/Documents` access is on the critical path, and why
main-thread synchronous reads under the captures roots are forbidden — see
AGENTS.md §"Never block the main thread on a TCC-gated path".

**Bundle format v2 (layer tree) is the only format.** See AGENTS.md
§"Bundle format v2" for the current rules, and
[docs/architecture-bundle-format.md](architecture-bundle-format.md) for the
format specification and its design rationale. Read that document's §Status
first; it marks which of its own sections are historical.

## AI runs on the user's machine, through their own agent

PwrSnap makes no direct calls to any model vendor. Every AI feature goes
through an agent the user already has installed — Codex CLI / Codex Desktop
over stdio JSON-RPC, or an ACP agent (Gemini / Qwen / Grok / Kimi). PwrSnap
is a *client* of those protocols and never an implementation of one.

Consequences that are easy to get wrong:

- There is no API key to manage for the core AI path, and no per-token cost
  PwrSnap controls. The user's agent subscription is the billing surface.
- Feature capability varies by whichever backend the user selected. The two
  backends are **not** equally sandboxable — see below.
- Model availability is discovered, not hardcoded.

**Capture enrichment is a jailed, unattended path.** A screenshot is
untrusted input that can carry text engineered to steer a model. Enrichment
runs with no tools, no network, no filesystem beyond a scratch jail, and no
UI to approve anything — enforced in the transport, not the prompt. This is
the most security-sensitive surface in the app; AGENTS.md §"Capture
enrichment runs in a sandbox jail" is the authority, including the measured
difference between the Codex and ACP postures.

**Tool-using AI belongs on the user-facing chat surfaces**, which have their
own approval policy and a human watching. Do not grow enrichment a tool to
make a feature work.

## Library: browsing must never lose your place

Grid and Reel are two **layouts** of one browse shell. Focus is an
orthogonal **takeover** you enter from either and exit back into.

The rule underneath: **viewing or editing a capture never reorders history.**
The incumbent's worst behavior was re-inserting an edited copy at the front
of recents, overwriting the spot you were looking at. Selecting is a
lightweight act that updates an inspector in place; entering the editor is
explicit.

The view-state union is the enforcement point — see
[library-view.ts](../apps/desktop/src/renderer/src/features/library/library-view.ts),
whose comment carries the transition rules. Inspector and overlay state
stays out of that union.

The Library is built to scale: keyset pagination, virtualized rows,
denormalized counts. It is not a fixture list, and changes there should be
measured against a seeded large library rather than a handful of captures.

## Process and transport shape

- **One command bus.** Every command routes through
  [command-bus.ts](../apps/desktop/src/main/command-bus.ts) — ipcMain, the
  local HTTP RPC surface, and MCP all dispatch through it, so there is
  exactly one place to register a command and one place to enforce auth and
  capability checks.
- **Renderers stay sandboxed.** `contextIsolation: true, sandbox: true,
  nodeIntegration: false`, without exception. Heavy work goes to the main
  process or a child process, never to a privileged renderer.
- **`Result` for anything crossing a process boundary.** Electron `invoke`
  strips `instanceof`, so handlers return
  `Result<Res, PwrSnapError>` rather than throwing across the gap.
- **Settings and secrets have exactly one substrate.** No sibling JSON
  files, no plaintext secrets, no second IPC channel. See AGENTS.md
  §"Settings substrate".

## Direction — open and deliberately unresolved

- **Sizzle composition engine.** The reel composer ships, but the original
  plan named Remotion as its engine and that was retracted on license
  grounds. Remotion is on the do-not-look list in AGENTS.md §"Dependency
  licensing" — do not read its source, docs, or examples. A replacement
  engine is an open research item.
- **Windows.** Ships signed, with a known backlog tracked in
  [docs/windows/port-status.md](windows/port-status.md) §Status. No Arm64
  package yet; no distributed Linux desktop build.
- **Cloud sync and alternate storage targets** (Drive / Dropbox / S3 / R2)
  are named goals with no shipped implementation. Nothing in the current
  storage model blocks them — bundles are already portable files.

## When this document is wrong

Fix it in the same PR as the change that made it wrong. It is short on
purpose: a living document that nobody trusts is worse than no document,
and the pruned phase plans are the cautionary example — they carried
`status: active` and unchecked task lists over features that had shipped
months earlier.
