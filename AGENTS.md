# PwrSnap Repository Guidance

## Source of Truth

- **[docs/architecture.md](docs/architecture.md) is the canonical description
  of what PwrSnap is and why it is shaped this way** — read it before changing
  scope, schema, or IPC contracts. It is deliberately short and carries no
  phase order or task lists.
- This file (AGENTS.md) holds the enforcement rules — the invariants a change
  can violate. `docs/architecture.md` explains *why*; the sections below say
  *what you must not break*. Rules for one area live in
  [docs/agents/](docs/agents/), and this file says when to read each one
  (see "Topic rules" below).
- Solution learnings (post-incident notes, gotchas) live in `docs/solutions/`.
- Shipped-behavior references live at the top level of `docs/` — the release
  runbook, the Windows guide and signing doc, the ffmpeg build reference, the
  third-party license notices doc, the
  [third-party agent connection guide](docs/mcp-third-party-agents.md), the
  [Linux tray support statement](docs/linux-tray-support.md), and the
  [on-device Apple captions reference](docs/apple-intelligence-captions.md).
- Two documents that began as plans survive as living references, because
  each is the only written statement of something still true: the
  [bundle format spec](docs/architecture-bundle-format.md) and the
  [Windows port status](docs/windows/port-status.md) (an open backlog).
- `docs/plans/` and `docs/brainstorms/` are **gone and are not coming back.**
  Do not recreate them. A change that needs written scope belongs in an
  issue or a PR description; a change that is architectural belongs in
  `docs/architecture.md`.
- The original Claude Design handoff bundle (HTML/JSX/CSS reference for the
  Library + Float-Over + Tray surfaces) is preserved verbatim under `design/`.
  Treat it as a visual reference, not as code to import.

## Workflow

- **Docs retention.** `docs/solutions/` and the top-level shipped-behavior
  docs are never deleted; `docs/architecture.md` is amended, not archived;
  plan-shaped documents are deleted once the work lands. Read
  [docs/agents/docs-retention.md](docs/agents/docs-retention.md) before
  deleting or keeping any document.
- Treat any surviving plan document as a decision artifact, not an
  implementation script, and verify its claims against the code before acting
  on them.
- **Never suggest wiping the user's database** (even on a dev machine). The
  pwrsnap.db at `~/Library/Application Support/PwrSnap/pwrsnap.db` contains
  real captures the user cares about. If a migration / schema bug bricks
  startup, the fix is in code — make the migration self-heal, detect drift,
  add a repair pass — NOT to tell the user `rm pwrsnap.db*`. Same rule for
  any other persisted state: captures dir, cache dir, settings.json, secrets.
  Suggesting "blow it away" is a non-starter.
- **CI and E2E environments.** Reproduce the Linux GHA Desktop E2E job with
  `pnpm test:desktop-e2e:docker`; the macOS GHA job runs with
  `PWRSNAP_E2E_DISABLE_GPU=1`, which a plain local run does not set; macOS
  CI/release jobs use standard GitHub-hosted `macos-26` runners only. Read
  [docs/agents/ci-and-e2e.md](docs/agents/ci-and-e2e.md) before debugging an
  E2E or golden failure, or changing CI runners.
- **Local headed desktop E2E belongs in the lab VM, not on the operator's
  machine.** Never run headed E2E on the operator's desktop without their
  explicit approval, provision a product-local Tart lab, or improvise direct
  Tart or SSH access. Read the same file, then follow
  [`.agents/skills/macos-vm-e2e-lab/SKILL.md`](.agents/skills/macos-vm-e2e-lab/SKILL.md)
  (macOS) or the Windows VM skill in the PwrSuiteLab checkout, before any
  Tart, self-hosted runner, or headed E2E work.
- **Keep private lab details out of this repository.** Host and guest names,
  addresses, usernames, fingerprints, keys, config contents, and fleet
  inventory live only in PwrSuiteLab — including in commit messages, PR
  bodies, issues, and fixtures. What may live here is the product/CI contract,
  the fact that the lab exists and is named PwrSuiteLab, and the controller
  entry points and public MCP job/ownership contract it exposes — enough to
  invoke it, never enough to map it.

## Agent Instruction Files

- Keep a sibling `CLAUDE.md` symlink next to every `AGENTS.md`, pointing at
  that `AGENTS.md`, so Codex and Claude read the same local guidance.
- Project root: `CLAUDE.md → AGENTS.md` (this file).
- `design/`: `CLAUDE.md → AGENTS.md` — the brand-mark, wordmark, token and
  Claude Design provenance rules for `design/**`. It was a bare `CLAUDE.md`
  until the README-chip work put a load-bearing path rule in it that Codex
  could not see.
- `apps/desktop/src/renderer/src/lib/`: `CLAUDE.md → AGENTS.md` — the focus
  hooks every dialog, popover and menu uses (Escape, Tab, focus return), the
  app's fast hover tooltip, and why each rule in them is there.
- `apps/desktop/src/renderer/src/features/update/`: `CLAUDE.md → AGENTS.md` —
  the app-update banner, row and check channels.
- `docs/agents/*.md` are not instruction files that agents auto-load. They are
  topic documents this file links to, so they need no `CLAUDE.md` sibling.

## Brand and Identity

- Product name is **PwrSnap** — one word, two capitals (`Pwr` + `Snap`),
  rendered as `Pwr` in primary text + `Snap` in the brand accent. Never insert
  whitespace between the halves; never lowercase the second capital.
- Company is **PwrDrvr LLC**. License is **MIT** (see [LICENSE](LICENSE)) —
  every `package.json` in the workspace declares `"license": "MIT"`; the
  policy gate [scripts/check-package-license-policy.mjs](scripts/check-package-license-policy.mjs)
  fails the build if any package drifts.
- Visual language follows the design system in `design/` — pure-black
  surfaces (`#000000`), tangerine accent (`#ff8a1f`), Geist + Geist Mono.
  PwrAgent is the system of record for PwrDrvr brand tokens; PwrSnap mirrors
  its `:root` palette in [design/ds/colors_and_type.css](design/ds/colors_and_type.css)
  and [apps/desktop/src/renderer/src/styles/tokens.css](apps/desktop/src/renderer/src/styles/tokens.css).

## Topic rules — read the linked file before touching the area

**This file must stay under 32 KiB**: Codex's default `project_doc_max_bytes`
silently truncates past it, and `pnpm agents-md:check` (in `pnpm lint`) fails
first. Each section below lists the rules one file in
[docs/agents/](docs/agents/) holds, and when to read it. A summary is not the
rule: when your change is in the area, read the file. A new topic rule goes in
the matching file, with a one-line summary here.

### Dependency licensing

Read [docs/agents/licensing.md](docs/agents/licensing.md) **before adding,
bumping or even looking at a third-party dependency's source**, or touching
any license script, `THIRD_PARTY_LICENSES`, or `dependabot-licenses.yml`.

- **Dependency licensing — what we ship and what we even look at.** Never read
  source of, depend on, or copy patterns from a source-available /
  restrictively licensed project. **Remotion is banned.** Only MIT, BSD,
  Apache-2.0, MPL-2.0, ISC, 0BSD, Unlicense, CC0 are always allowed; anything
  else, pause and ask. Adding an id to `ALLOWED_LICENSE_IDS` is a legal
  decision, never a way to make CI green.

### AI backends and capture enrichment

Read [docs/agents/ai-backends.md](docs/agents/ai-backends.md) **before
changing any AI provider, direct-API connection, fallback, enrichment thread
config, ACP pooling, the Apple `fm` path, or the enrichment budget.**

- **AI backends: installed agents and custom direct APIs.** Never route a
  custom model through Codex/ACP as a silent fallback; `ai.enrichmentFallback`
  is opt-in, captions only, and only for an unreachable primary. Never infer
  capabilities from a model name or URL. The protocol package is
  `@pwrdrvr/codex-app-server-protocol`, pinned exactly; never vendor it.
- **Capture enrichment runs in a sandbox jail.** An agent-backed enrichment
  turn may not run a command, call a tool, read outside its scratch jail, or
  reach the network, enforced in the transport
  (`enrichment-sandbox.ts`). Never loosen it to make a feature work; ACP is
  materially weaker than Codex.
- **Apple's on-device model runs through a fixed fm command line.** Only
  `/usr/bin/fm` with an argv that passes `assertAppleFmArgs`, `--model system`,
  no tools; never agree to Apple's terms or change fm's config; `AppleFmError`
  is never a fallback trigger.
- **Only the operator's re-run is exempt from the enrichment budget.**
  `codex:enrich` always spends a token; only the Library re-run job, via the
  `EnrichmentRepairDispatcher`, skips it. Never key an exemption on a request
  field.

### Bundle format

Read [docs/agents/bundle-format.md](docs/agents/bundle-format.md) **before
touching capture persistence, the compositor read path or `.pwrsnap` parsing.**

- **Bundle format v2 — the only bundle format (v1 fully removed).**
  `persistCaptureFromTempV2` is the one write entrypoint and the coordinator
  throws on non-v2. Videos carry a vestigial `bundle_format_version = 1`.

### Capture, TCC and clipboard

Read [docs/agents/capture-and-clipboard.md](docs/agents/capture-and-clipboard.md)
**before adding filesystem reads in main, touching clipboard reads or menu
enablement, or changing screen grabs, the region selector, or Linux/Wayland
capture.**

- **Never block the main thread on a TCC-gated path.** No sync fs read under
  the captures/chats roots in main; use bounded, shared async reads, and
  budget the 4-thread libuv pool.
- **Clipboard bytes are read only for a paste or copy the user started.**
  Everything else lists types only (`pasteboard-types.ts`); Electron's
  `clipboard.read()` / `has()` are not types-only.
- **A screen grab must prove it is the display it claims to be.**
  `desktopCapturer` pixels are shape-checked against the display
  (`grab-geometry.ts`); region capture is refused on Wayland with more than
  one display, in the handler only, with a visible notice; the Linux selector
  must be fullscreen and resizable.

### Renderer focus, tooltips, layout measures and chrome

Read [docs/agents/renderer-ui.md](docs/agents/renderer-ui.md) **before adding
an overlay, tooltip or focus style, measuring DOM geometry, or changing any
title strip.** Also read
[apps/desktop/src/renderer/src/lib/AGENTS.md](apps/desktop/src/renderer/src/lib/AGENTS.md)
for overlays and tooltips.

- **Overlays get Escape, Tab and focus from the renderer's focus hooks.** Use
  `useModal` / `useDismissable` / `useFocusTrap` / `useMenuNavigation` /
  `useFocusReturn`; never add an overlay keydown listener for Escape or Tab.
- **Icon-only controls name themselves with `data-tip`, not `title`.** Plus an
  `aria-label`; never `data-tip` and `title` together.
- **Never mix a post-transform rect with a layout measure.**
  `getBoundingClientRect()` is post-transform; `offsetWidth`/`clientWidth`/
  `borderBoxSize` are layout. A `ResizeObserver` never corrects a value read
  mid-transform.
- **Focus rings.** Every ring uses `--focus-ring`, reaches 3:1, and must be
  measured on screen in a browser; `outline: none` in a focus rule must be
  followed by a ring.
- **The Pwr-family title strip.** 40px band, stoplights at `{ x: 16, y: 13 }`,
  brand at x=96, shared with PwrGit and PwrAgent: change all three together.

### Annotation sizing and draw strokes

Read [docs/agents/annotations.md](docs/agents/annotations.md) **before
changing how any annotation, arrow, shape, text or Draw stroke is sized,
stored, erased or baked.**

- **Annotation sizing — one basis, one ladder.** Every size divides
  `annotationBasisPx(sourceW, sourceH)` from SOURCE raster dims, never canvas
  dims or `device_pixel_ratio`.
- **Draw strokes — one geometry, canvas-normalized points.** Everything that
  paints a stroke goes through `strokeGeometry`; a cut stroke stays one layer;
  no per-pointer-event work may scale with what was drawn before.

### Render cache, cache deletion and video export

Read [docs/agents/cache-and-video-export.md](docs/agents/cache-and-video-export.md)
**before deleting anything under `<cacheRoot>`, adding a cache writer, bumping
`BAKE_PIPELINE_VERSION`, or adding an MP4 export path.**

- **Bake render cache — orphans are tolerated, not swept.** A
  `BAKE_PIPELINE_VERSION` bump orphans files; nothing auto-sweeps them.
- **Every deleter of `<cacheRoot>` goes through the admission gate.** Take
  `withDerivedCacheCleanup`; the five derived-video lanes publish inside
  `runGatedCacheWrite`, registered synchronously.
- **An MP4 with no audio choice gets the user's, never "every track".** Every
  MP4 export resolves audio through `resolveExportAudio`; unreadable means
  silent.

### Profiling, tracing and React DevTools

Read [docs/agents/profiling.md](docs/agents/profiling.md) **before profiling
startup, the GPU process or renderers, or changing those harnesses.**

- **Startup profiling harness — `PWRSNAP_STARTUP_PROFILE=1`.** Profiling
  runs are passive observers: no global hotkeys, boot GC or filename
  maintenance.
- **Multi-process trace harness — `PWRSNAP_TRACE=1`.** Close DevTools first;
  use `ps -o time=` deltas, not `%CPU`.
- **React DevTools renderer profiling — `PWRSNAP_REACT_DEVTOOLS=1`.** Always
  on a scratch userData with `PWRSNAP_E2E=1` + `PWRSNAP_USER_DATA`; never add
  `react-devtools` to `package.json`; packaging refuses a remote `<script>`.

### Local agent access (MCP)

Read [docs/agents/local-mcp.md](docs/agents/local-mcp.md) and
[docs/mcp-third-party-agents.md](docs/mcp-third-party-agents.md) **before
touching `pwrsnap-mcp`, the native MCP bridge, roles, or MCP skills.**

- **Local agent access — desktop-owned MCP, native approval.** The Rust relay
  is a byte relay only; Electron main owns the MCP interface. No TCP or
  WebSocket listener; a relay gets exactly its named role; every read keeps
  its capability and owner checks.

### Main-process navigation, quit and renderer intents

Read [docs/agents/main-process.md](docs/agents/main-process.md) **before
creating a webContents, opening a URL, adding a quit listener, or sending a
one-shot event to a renderer.**

- **No webContents opens a window, and none navigates away.** Every
  webContents is covered by `navigation-guard.ts`; URLs leave only through
  `isAllowedExternalUrl`, into the user's browser.
- **A deferred quit is retried from a macrotask, never from its own promise
  chain.** Use `retryQuitAfterDispatch`; nothing defers a quit with nothing to
  wait for.
- **A one-shot intent sent to a renderer must not be droppable.** Send once,
  after `did-stop-loading`, on a preload-latched channel; no grace timer.

### BrowserWindow sizing and placement

Read [docs/agents/window-placement.md](docs/agents/window-placement.md)
**before creating a window that resizes to content or is positioned to line
up with something on screen.**

- **BrowserWindow sizing — `setMinimumSize(0, 0)` after construction.**
  Required for any window later sized with `setContentSize`.
- **macOS MOVES a window placed outside the work area.** Plan against
  `display.workArea`; negative recording-frame insets are intentional.

### Tray and popover sizing

Read [docs/agents/tray-and-popover-sizing.md](docs/agents/tray-and-popover-sizing.md)
and [docs/linux-tray-support.md](docs/linux-tray-support.md) **before changing
the tray, its menu, the popover's show/hide, or how the tray or float-over
sizes itself.**

- **The Linux tray is a native menu, not the popover.** Never call
  `setContextMenu` on macOS/Windows; nothing time-varying in the Linux menu.
- **Tray popover hide — `setOpacity(0)` before `hide()` on macOS.** Always
  `hideTrayWindowNow` / `showTrayWindowNow`; never on Windows.
- **Tray + float-over popover sizing — outer `inline-block` measurer.**
  Measure an `inline-block` wrapper outside the styled container, never
  hardcoded heights; past the ceiling the float-over scrolls, and its cap is
  never derived from the window's current size.

### Float-over state and dock

Read [docs/agents/float-over.md](docs/agents/float-over.md) **before changing
how the float-over gets its state or how the dock tucks, shows or hides.**

- **The float-over asks for its state; main never sends it on a timer.**
  Subscribe, then `requestFloatOverState()`.
- **The float-over dock is the toast's own window, and it never lands in a
  capture.** Inside the work area, content-protected, parked for every
  snapshot and recording; the sidebar setting hides, never dismisses.

### Recording frame, mid-take UI and activation

Read [docs/agents/recording.md](docs/agents/recording.md) **before changing
the recording frame, HUD, anything shown during a take, or activation and
Dock-reclaim behavior.**

- **The recording frame may never paint inside the recorded rect.** On
  platforms that cannot hide our window from the recorder, every lit pixel is
  outside the rect; `outset` is the safe base CSS.
- **Mid-take UI: only the HUD asks questions, and nothing takes focus.** No
  native dialog and no `setFocusable(true)` during a take.
- **The Dock reclaim is not an activation recovery.** It restores activation
  policy, not activation or z-order.

### Settings substrate

Read [docs/agents/settings.md](docs/agents/settings.md) **before adding or
reading a setting or secret, or touching settings persistence or agent
discovery.**

- **Settings substrate — every setting + secret goes through one place.**
  `DesktopSettingsService` + `DesktopSecretStore` over the command bus: no new
  IPC channel, sibling JSON file, or plaintext secret; atomic writes; only
  `getValue()` decrypts and it is never on the bus; `pnpm settings-store:check`
  is executable policy.

### Release and distribution

Read [docs/agents/release.md](docs/agents/release.md) **before touching
packaging, signing, the app icon, Electron fuses, `THIRD_PARTY_LICENSES`, or
`package.json` `description`.**

- **Release / Distribution.** macOS (signed/notarized DMGs) and Windows (NSIS)
  ship; Linux is E2E only. Never hand-edit `THIRD_PARTY_LICENSES`. Subsections:
  *macOS app icon* (ship the `.icon`, never a hand-built `.icns`),
  *Electron fuses are pinned* (`enableCookieEncryption` stays `false`), and
  *`package.json` `description` is shipped UI on Windows*.

### Native modules: better-sqlite3 and sharp

Read [docs/agents/native-modules.md](docs/agents/native-modules.md) **before
touching native-module install, packaging prunes, `allowBuilds`, or sharp
loading.**

- **better-sqlite3 loads its own N-API prebuild — nothing is rebuilt for
  Electron.** No `nativeBinding` override or Electron rebuild.
- **sharp in Electron on Linux runs its WebAssembly build.** Every entry that
  can load sharp imports `sharp-wasm-steer.ts` first.

## A bug fix ships a property, model or oracle test

**A bug fix states the rule it broke as a property, model or oracle test, and
confirms that test fails on the pre-fix code.** Do the same for new
rule-heavy logic, state machines, concurrency, and code that reads or writes
persisted state (settings, secrets, SQLite, `.pwrsnap` bundles). Example tests
alone check only what their author expected. Here they have asserted the bug
as correct (#604, #715).
[docs/property-model-oracle-testing.md](docs/property-model-oracle-testing.md)
says what each kind is and how to write one.

## React act warnings fail renderer tests

The renderer Vitest project uses `act-warning-runner.ts` and
`react-act-environment.ts` under `apps/desktop/src/test-setup/` to fail React
act warnings, including unwrapped updates, unawaited/overlapping scopes,
suspended work and a disabled act environment. The guard observes both
`console.error` and `console.warn`, survives silenced spies and mock restoration,
and attributes late asynchronous work to the test that created it. It checks
again after test and suite teardown.

Await the React work inside `await act(async () => { ... })`: mount effects,
IPC replies, timers, event callbacks and teardown are all part of the test.
Keep assertions after the relevant work settles. Do not silence the warning,
disable `IS_REACT_ACT_ENVIRONMENT`, or wrap the whole test in act to bypass
individual interaction boundaries. Mocks must preserve the real transport's
ordering and results; waiting can expose assertions against transient state.
The nested fixtures in `scripts/renderer-act-warning-guard.test.mjs` prove that
warnings fail the process and clean runs pass.

## Repository conventions

- **pnpm workspaces.** Apps in `apps/*`, packages in `packages/*`. Always run
  `pnpm install` from the repo root.
- **Channel naming.** IPC channels use bare `<domain>:<verb>` (`capture:region`,
  `library:list`, `overlays:upsert`). No `pwrsnap:` prefix; matches PwrAgnt.
- **Single command bus.** All commands route through
  `apps/desktop/src/main/command-bus.ts`. ipcMain (Phase 1), HTTP RPC
  (Phase 7), and a future MCP transport all dispatch through it. There is
  exactly one place to register a command and exactly one place to enforce
  auth + capability checks.
- **TypeScript strict.** `tsconfig.base.json` has `strict`,
  `verbatimModuleSyntax`, `isolatedModules`, (per the deepening plan)
  `exactOptionalPropertyTypes`, and `noUnusedLocals` + `noUnusedParameters`.
- **Dead imports and locals fail `pnpm typecheck`** (native TypeScript 7,
  `noUnusedLocals` + `noUnusedParameters`; a green `pnpm build` proves
  nothing). The `_` prefix exempts parameters only. **Oxlint**
  (`pnpm lint:syntax`, `pnpm lint:typed` with `unbound-method`) adds
  correctness coverage and never replaces TypeScript; never suppress
  `unbound-method` inline. Read
  [docs/agents/typecheck-and-lint.md](docs/agents/typecheck-and-lint.md)
  before changing tsconfig flags, lint config, or the typecheck scripts.
- **Renderers stay sandboxed.** Every `BrowserWindow` is created with
  `contextIsolation: true, sandbox: true, nodeIntegration: false`. The Phase 6
  sizzle-composer preview player runs in a sandboxed renderer; render
  orchestration runs in a Node child process. Lifecycle test enforces. Those
  three flags harden a renderer; they do not stop one from being pointed
  somewhere else — see "No webContents opens a window, and none navigates away"
  in [docs/agents/main-process.md](docs/agents/main-process.md).
- **Result-pattern for cross-process errors.** Electron `invoke` strips
  `instanceof`. All command handlers return `Result<Res, PwrSnapError>` —
  `{ ok: false, error: { kind, code, message, cause? } }`.

## Pull Requests

- Conventional Commit-style PR titles: `type(scope): short description`.
- Scopes that match the project area:
  - `desktop` — the Electron app itself (main, preload, renderer).
  - `protocol` — the Codex App Server protocol package dependency.
  - `design` — UI work tied to the design system.
  - `release` — packaging, signing, notarization, distribution.
  - `docs` — documentation only.
  - `tests` — test coverage / fixtures / infrastructure.
- Prefer before/after screenshots on PRs that change visible UI.
  - Use 100% contrived fixture data when possible.
  - If a screenshot is not 100% contrived, show it to the operator and wait for approval before attaching. Redact anything that must not ship (secrets, tokens, customer data, private thread text, account identifiers).
- Attach screenshots with `gh` 2.99+'s `--attach`, referencing the exact
  local path in the body. Read
  [docs/agents/pull-requests.md](docs/agents/pull-requests.md) before attaching
  images or editing a PR body that has them: re-sending the original draft
  kills the uploaded links, and `gh` exits 0 on every failure.

## Toolchain: Node, pnpm, Linux sandbox

**Always enter the repo with nvm before installing:** `source ~/.nvm/nvm.sh`,
`nvm use`, then `pnpm install` from the repo root, once per checkout/worktree.
Never bypass the `preinstall` Node check, never share `node_modules` between
checkouts, and never run the app as root or disable its sandbox
(`pnpm fix:linux-sandbox` repairs the helper). Read
[docs/agents/toolchain.md](docs/agents/toolchain.md) **before bumping Node,
pnpm or Electron, installing on Windows, or fixing a Linux SUID sandbox
error.** It holds *Dependencies and tooling*, *Node / native module ABI
hygiene*, and *Linux sandbox setup*.
