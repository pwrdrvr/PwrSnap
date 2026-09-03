---
name: macos-vm-e2e-lab
description: >-
  Route PwrSnap macOS Tart, self-hosted runner, headed E2E, and visual-golden
  work through an existing PwrSuiteLab checkout and its managed controllers.
  Use when a user mentions Tart, a local macOS VM, an E2E VM, self-hosted macOS
  runners, headed desktop E2E, E2E windows stealing focus, or PwrSnap visual
  goldens. Do not use for Windows VM probes or Windows E2E.
---

# PwrSnap macOS VM E2E lab

PwrSnap does not own the Tart lab, runner VMs, or guest OS baseline.
PwrSuiteLab does. Do not provision a product-local Tart lab from this
repository. Do not clone a base image or register a GitHub Actions runner from
these files.

Keep the boundary explicit: product tests and CI contracts belong in PwrSnap;
private lab inventory, configuration, transport, diagnosis, and recovery belong
only in PwrSuiteLab. Never copy private access values, host or guest names,
addresses, usernames, fingerprints, keys, configuration contents, host
inventory, or lab construction details into PwrSnap — including into a commit
message, PR body, issue, or test fixture.

## Why this exists

Headed desktop E2E takes over the screen: it opens windows, steals focus, and
drives the region selector and global hotkeys. Running it on the operator's
own desktop interrupts whatever they are doing and lets their real windows
leak into a capture. The lab VM exists so that never has to happen.

## Resolve the lab checkout

1. Discover an existing PwrSuiteLab checkout from the current thread's attached
   or linked directories, known local project checkouts, or project metadata.
   An explicit operator pointer is also valid. Do not assume or hardcode a
   machine-specific pathname. Do not clone, install, or provision PwrSuiteLab
   as a fallback.
2. Use PwrSuiteLab's primary checkout for controllers. Do not select or operate
   from one of its disposable worktrees.
3. Read that checkout's `AGENTS.md`, then its current `macos-tart` runbook and
   any skill that runbook identifies, before running or diagnosing anything.
   The lab checkout is authoritative; do not reconstruct its procedure from
   this skill, and expect its guest names, hosts, and gates to live only there.
4. Confirm the required ignored config in the primary checkout with an exact
   filesystem existence test — headed E2E uses `local-config/macos-tart.sh`.
   `rg --files`, `git ls-files`, and checks in other worktrees do not prove a
   config is absent. Never read, print, copy, summarize, or expose it. If the
   exact default is absent, ask the operator only for an existing config path.

If a usable primary checkout is not discoverable, ask the operator where the
existing checkout is or to attach it, then stop. If the work would require
private construction or access details, ask the operator to handle it or to
provide the supported PwrSuiteLab path, then stop. Do not invent a fallback
lab. Running headed E2E directly on the operator's desktop is a fallback of
last resort and needs their explicit approval first.

## Use the managed controller

Normal headed E2E and visual-golden generation use PwrSuiteLab's
`macos-tart/run-e2e.sh`. It owns starting the guest when needed, the strict
transport, the shared lock that serializes the one guest display, artifact
collection, and stopping a guest it started. From a **clean, committed**
PwrSnap worktree:

```bash
suite_lab_root="<PwrSuiteLab checkout discovered as above>"
pwrsnap_root="$(git rev-parse --show-toplevel)"
"$suite_lab_root/macos-tart/run-e2e.sh" --confirm-live-run \
  --workload pwrsnap --local "$pwrsnap_root" \
  e2e/region-selector-ui.spec.ts
```

Subject to the current PwrSuiteLab runbook and its approval gates. Notes that
have bitten before:

- **Only the committed `HEAD` is sent.** The controller rejects a dirty
  worktree. Commit the exact revision you mean to test, as a disposable
  checkpoint if needed.
- **Playwright paths are relative to `apps/desktop`**, because the workload
  adapter runs Playwright from there — `e2e/foo.spec.ts`, not
  `apps/desktop/e2e/foo.spec.ts`.
- **Pass the narrowest useful spec list.** A full suite is valid when
  requested or when a PR checklist needs it, not by default.
- **Do not pipe the run through `tail`.** Output buffers until the pipeline
  ends and you lose the middle of the report. Redirect to a file, or read the
  collected `e2e.log` artifact.
- A run left detached can be retrieved later with the lab's
  `collect-artifacts.sh` rather than re-run.

For E2E lock, status, execution, or recovery, never run or recommend: bare
`tart` commands (including `tart ip`); raw `ssh`; manual host-key acceptance or
the global known-hosts file; password-prompting authentication; disabling
strict host-key checking; or asking the operator to run any of those. Lab
diagnosis and recovery stay in PwrSuiteLab, through its current skills and
controllers with their approval gates. Do not bypass the controller to inspect
or repair the guest.

## PwrSnap product facts

These stay in this repository because they are product or CI contracts, not lab
inventory:

- The macOS CI lane uses `runs-on: [self-hosted, macOS, ARM64, pwrdrvr-macos]`
  and runs the whole suite with `PWRSNAP_E2E_DISABLE_GPU=1`.
- The lab's PwrSnap adapter sets that same variable, so a lab run reproduces
  the CI renderer. A plain local `pnpm test:desktop-e2e` does **not** set it and
  is therefore a different environment — see the note in
  [AGENTS.md](../../../AGENTS.md) before calling a local-only failure a stale
  golden or a flake.
- Screenshot goldens are recorded in that renderer. Generate or refresh them in
  the VM, never from an ordinary host run.
- The `PwrDrvr macOS` runner group is selected-repository only, for PwrSnap and
  PwrAgent. Do not add a repository-scoped runner or grant the rest of the
  organization access. Fork-head pull requests must not run on those machines.
- For the Linux/xvfb GitHub Actions subset, use
  [`e2e-docker-repro`](../e2e-docker-repro/SKILL.md) instead — that harness is
  Docker-based and unrelated to this lab.
- For Windows probes or Windows headed E2E, read the Windows VM skill in the
  attached PwrSuiteLab checkout. Do not use this skill for Windows work.
