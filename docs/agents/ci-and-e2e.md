# Agent rules: CI, local E2E environments and the lab VM

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each rule below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Workflow — CI and E2E environments

- To reproduce the Linux GitHub Actions Desktop E2E job locally, prefer
  `pnpm test:desktop-e2e:docker` from the repo root (or pass
  `--test '<pattern>' --iterations 30` for flake hunting). This runs the
  Linux/xvfb subset on Docker's native Linux platform; macOS-only clipboard,
  tray, menu-bar, screen-capture, and AppKit windowing specs are expected to be
  skipped. Add `--platform linux/amd64` only when investigating
  architecture-specific GHA parity.
- **The macOS GHA Desktop E2E job runs the whole suite with
  `PWRSNAP_E2E_DISABLE_GPU=1`** (software rendering — see `.github/workflows/ci.yml`),
  and `pnpm test:desktop-e2e` does not set it. A plain local run is therefore a
  DIFFERENT environment than the one every screenshot golden was recorded in;
  check that before concluding a local-only failure is a stale golden, a flake,
  or "just this machine". Suites sensitive to rasterization should pin the env
  themselves and assert the pin rather than trust the caller —
  `visual-regression.spec.ts` does both.
- **macOS CI, release, preview and benchmark jobs use standard GitHub-hosted
  `macos-26` runners.** Icon Composer needs the macOS 26 host frameworks as
  well as actool 26+. Do not use a paid larger size or `macos-26-intel`, and
  do not move CI onto self-hosted machines. Fork pull requests run macOS E2E
  too, and the required Desktop E2E gate requires every platform to pass.
- **Local headed desktop E2E belongs in the lab VM, not on the operator's
  machine.** It takes over the screen — opens windows, steals focus, drives
  the selector and global hotkeys — and the operator's real windows can leak
  into a capture. For macOS Tart, self-hosted runner, or headed E2E work,
  follow [`.agents/skills/macos-vm-e2e-lab/SKILL.md`](../../.agents/skills/macos-vm-e2e-lab/SKILL.md).
  It prefers PwrSuiteLab Control MCP's live schemas and served
  `manage-pwrlab-e2e` skill. Granted MCP actions need no per-operation native
  confirmation; keep the requested target/scope and controller safety checks.
  Use the existing checkout's managed `macos-tart/run-e2e.sh` only when MCP
  is unavailable, retaining the script runbook's approval and transport gates.
  Invalid arguments require checking the schema, not assuming a lost grant.
  For Windows probes or Windows headed E2E, read the Windows VM skill in
  the existing PwrSuiteLab checkout. Do not provision a
  product-local Tart lab from this repository, improvise direct Tart or SSH
  access, or run headed E2E on the operator's desktop without their explicit
  approval.
