---
name: macos-vm-e2e-lab
description: >-
  Route PwrSnap macOS Tart, self-hosted runner, and headed E2E work through an
  existing PwrSuiteLab checkout and its managed controllers. Use when a user
  mentions Tart, a local macOS VM, an E2E VM, self-hosted macOS runners, headed
  desktop E2E, or E2E windows stealing focus. Do not use for Windows VM probes
  or Windows E2E.
---

# PwrSnap macOS VM E2E lab

PwrSnap does not own the Tart lab, runner VMs, or guest OS baseline —
PwrSuiteLab does. Product tests and CI contracts belong here; lab inventory,
configuration, transport, diagnosis, and recovery belong only there. Do not
provision a product-local Tart lab, clone a base image, or register a runner
from this repository, and never copy private lab details into PwrSnap (see
AGENTS.md for what that covers).

## Why this exists

Headed desktop E2E takes over the screen: it opens windows, steals focus, and
drives the region selector and global hotkeys. Run on the operator's own
desktop it interrupts whatever they are doing and can pull their real windows
into a capture under test.

## Get approval first

**A lab run is a live action, not a read.** It boots a VM, takes a lock that
serializes the single guest display against every other consumer of that
guest, and runs for minutes. PwrSuiteLab's runbook requires explicit operator
approval naming the target and the intended test; `--confirm-live-run` is a
bare argv check in the controller, not a prompt, so typing it asserts an
approval you must actually have.

So: get the operator's go-ahead for *this* run before invoking the controller.
An instruction that names the machine and the test is approval for that scoped
run — it is not standing approval for later runs, a wider spec set, or any
other lab operation. Running headed E2E on the operator's own desktop instead
needs the same explicit approval.

## Resolve the lab checkout

1. Discover an existing PwrSuiteLab checkout from the thread's attached or
   linked directories, known local project checkouts, or project metadata. An
   explicit operator pointer is also valid. Do not assume or hardcode a
   machine-specific pathname, and do not clone, install, or provision
   PwrSuiteLab as a fallback.
2. Use its primary checkout, not one of its disposable worktrees.
3. Read that checkout's `AGENTS.md` and its current `macos-tart` runbook before
   running or diagnosing anything. **That runbook is authoritative and wins on
   conflict with anything here**; its guest names, hosts, and approval gates
   live only there.
4. Verify the ignored config exists with an exact filesystem test —
   `test -f "$suite_lab_root/local-config/macos-tart.sh"`. Absence in
   `rg --files` or `git ls-files` proves nothing. Never read, print, copy, or
   summarize it. If it is missing, ask the operator only for an existing config
   path.

If no usable checkout is discoverable, or the work needs private construction
or access details, ask the operator and stop. Do not invent a fallback lab.

## Run it

Use the invocation in [CONTRIBUTING.md](../../../CONTRIBUTING.md) — one copy,
so it cannot drift — subject to the lab runbook's gates. Notes that have bitten
before:

- **The controller's flags are positional, not a parse loop.** The documented
  order is the only one that works. Move `--workload` after `--local` and it is
  silently swallowed into the Playwright arguments; the run then boots the VM,
  installs, and builds before dying on an unknown Playwright option.
- **Everything after `--local <path>` is an opaque Playwright filter**, matched
  as an unanchored REGEX against the full test-file path — not a path resolved
  against a cwd. `e2e/editor` therefore selects all 19 `editor-*.spec.ts`
  files. Quote patterns and prefer a full filename.
- **Only committed `HEAD` is sent, and the check is
  `--untracked-files=all`.** A single unstaged *or untracked* file fails the
  run — so a brand-new spec needs `git add -A` before committing, not
  `git commit -am`, which stages nothing new and fails identically.
- **Pass the narrowest useful spec list.** The guest display is serialized, so
  a full suite blocks every other consumer for its duration. Full runs are for
  when they are asked for or a PR checklist needs them.
- **Redirect with `> run.log 2>&1`, and do not pipe through `tail`.** Every
  failure reason — lock contention, transport failure, timeout — goes to
  stderr, and a pipe buffers the report until the run ends. The collected
  `e2e.log` artifact is the other way to read it.
- **The guest does not set `CI`**, so `playwright.config.ts` gives no HTML
  report, no trace, and no retry there. A CI failure that only reproduces on
  the retry attempt will not reproduce in the lab.
- An interrupted controller detaches; the guest job keeps running and keeps the
  lock. Retrieve it later through the lab's own artifact-collection helper
  rather than starting a second run.

For lock, status, execution, or recovery, never run or recommend: bare `tart`
commands (including `tart ip`); raw `ssh`; manual host-key acceptance or the
global known-hosts file; password-prompting authentication; or disabling strict
host-key checking. Diagnosis and recovery stay in PwrSuiteLab, through its own
skills and gates. Do not bypass the controller to inspect or repair the guest.

## PwrSnap product facts

Product and CI contracts, verifiable in this repository:

- The macOS CI lane is `runs-on: [self-hosted, macOS, ARM64, pwrdrvr-macos]`,
  runs the whole suite with `PWRSNAP_E2E_DISABLE_GPU=1`, and is guarded against
  fork-head pull requests — all three in `.github/workflows/ci.yml`, which is
  the thing to check, not this list.
- The lab adapter sets that same variable. Note the caveat AGENTS.md already
  records: rasterization-sensitive suites pin the env *themselves*, and
  `visual-regression.spec.ts` does, so the variable does not explain a local
  visual-regression failure.
- **Do not refresh screenshot goldens through the lab.** `--update-snapshots`
  is forwarded and will rewrite the baselines inside the guest — but the
  controller only collects `test-results` and `playwright-report`, and the next
  run resets and cleans that checkout, so the rewritten files are unreachable
  and then destroyed. The supported macOS flow is the promote-from-artifacts
  procedure in [CONTRIBUTING.md](../../../CONTRIBUTING.md).
- For the Linux/xvfb GitHub Actions subset, use
  [`e2e-docker-repro`](../e2e-docker-repro/SKILL.md) — a Docker harness,
  unrelated to this lab.
- For Windows probes or Windows headed E2E, read the Windows VM skill in the
  attached PwrSuiteLab checkout. Do not use this skill for Windows work.
