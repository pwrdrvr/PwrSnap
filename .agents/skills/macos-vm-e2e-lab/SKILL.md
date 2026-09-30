---
name: macos-vm-e2e-lab
description: >-
  Route PwrSnap macOS Tart, self-hosted runner, and headed E2E work through
  PwrSuiteLab Control MCP connection, with managed scripts only when MCP is
  unavailable. Use when a user mentions Tart, a local macOS VM, an E2E VM, self-hosted macOS runners, headed
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

## Prefer Control MCP

Discover the available PwrSuiteLab Control MCP tools and read their live input
schemas and served `skill://manage-pwrlab-e2e/SKILL.md` before operating. Use
that skill for the current job, ownership, transport, and recovery contract;
do not assume this product guide replaces it. If a tool discovery client is
available, search its live MCP connections even if no lab tools were initially
registered. Discover skills with `skills/list` and `skills/get` (or
`resources/list` for older clients), then read the served skill with
`resources/read`.

An Operate grant authorizes the exposed MCP actions for the requested work
without per-operation native confirmation. A Read only grant does not. Keep
the requested target and test scope; a grant does not authorize unrelated
work or bypass controller safety checks. Do not ask again for an already
authorized run. Running on the operator's own desktop still requires explicit
approval.

- Use `lab_status` and the exact dedicated E2E target it returns. Never use a
  GitHub Actions runner or the physical desktop for this workflow. Check
  status before preparing and again before submitting a run; idle shutdown
  can stop the VM between jobs, and `lab_e2e_run` starts it when needed.
- Both `lab_e2e_run` and `lab_e2e_acquire` require top-level `agent_name`,
  `project_name`, and `thread_name`, including when consuming a reservation.
  Use actual display attribution (`PwrSnap` for the project); use a descriptive
  task title if the thread title is unavailable. Include `pr_number` as a
  decimal string only when applicable and known; omit it otherwise. These
  labels are not authentication. Never include secrets or local paths in them.
- `job.repository` is the absolute path to this thread's exact clean, committed
  worktree. Check untracked files too; never discard changes to make it clean.
  Only committed HEAD and locally available submodule/LFS content travel.
  Obtain needed LFS objects before submission. No push or named-workload
  enrollment is required; the repository must be local to Control's host.
- `job.setup` is an ordered array of argv arrays; `job.command` is an argv
  array. Explicit `["bash", "-c", "..."]` is allowed for shell setup. All
  commands run in the guest. Select runtime versions, dependency installation,
  native rebuild/build, and narrow tests from PwrSnap's current package scripts
  and CI. The concrete example lives in [CONTRIBUTING.md](../../../CONTRIBUTING.md).
  Never install tools on the host as a workaround or copy credentials.
- Bound the timeout and artifact paths to this task. Artifacts are relative
  checkout paths, with no traversal or symlinks; do not collect a whole home
  directory or dependency tree. The live schema sets the current limits.
- Save both the returned request ID and `run_id`. Poll `lab_request_status`
  with the request ID for operation status; a completed launch with
  `job_state: running` is not a passing test. Use `lab_e2e_collect` with the
  exact target and saved `run_id` for job progress and artifacts, polling its
  request ID if necessary. Inspect the returned artifact directory, `e2e.log`,
  exit code, and artifact completeness. Distinguish setup and test failures.
- On `Invalid tool or arguments`, inspect the current schema and missing or
  mistyped fields first, especially attribution and argv arrays. This is a
  schema/tool mismatch, not evidence that an Operate grant was lost. Correct
  the call; do not request reauthorization or switch to scripts/raw SSH to
  evade a validation or permission refusal. If launch or transport failed,
  inspect any returned run ID before retrying: the guest may already be running.

## Ownership and recovery through MCP

`lab_e2e_run` acquires the display itself; an initial acquire is unnecessary.
It can consume this connection's reservation and transfer it to the job.
`lab_e2e_release` (Control's **Release reservation**) releases only the caller's
own reservation, not a workload lock. Do not release after a successful
handoff. The guest releases its job lock after completion. Other callers'
reservations and live jobs must remain untouched.

`roles.e2e.lock_started_at` is UTC (`Z`), and `lock_age_seconds` is the full
age measured from the guest owner file, independent of chart window or app
uptime. Age alone never proves a lock is stale. Preserve an interrupted job's
lock until guarded `lab_e2e_recover` validates the orphan; recovery refuses
live sessions/reservations, malformed owners, and unknown transport state.
Never delete locks manually.

Jobs survive Control disconnection. Reuse the saved run ID and same OAuth
connection to collect; collection does not rerun tests or boot a stopped VM.
If needed, start the exact target with `lab_e2e_start` before collecting.
Missing VM baseline prerequisites or strict-SSH failures are lab problems,
not permission to rebuild the VM, change credentials, or bypass the controller.

## Script fallback only when MCP is unavailable

Use the managed script path only when Control MCP is unavailable, not when a
call is refused or invalid. The script path retains its own approval gates:
a live run needs explicit operator approval naming the target and intended
test. Existing approval for that scoped run suffices; `--confirm-live-run`
asserts that approval and does not obtain it. It is not standing approval for
wider tests or other lab operations.

### Resolve the fallback lab checkout

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

### Run the fallback controller

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
- **The script adapter does not set `CI`**, so `playwright.config.ts` gives no HTML
  report, no trace, and no retry there. A CI failure that only reproduces on
  the retry attempt will not reproduce with that script configuration.
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
- The script adapter sets that same variable; MCP jobs must set it
  explicitly. Note the caveat AGENTS.md already records: rasterization-sensitive
  suites pin the env *themselves*, and
  `visual-regression.spec.ts` does, so the variable does not explain a local
  visual-regression failure.
- MCP collects only requested artifact paths (plus `e2e.log`). If an authorized
  task updates goldens, explicitly collect the narrow changed snapshot
  directories and review/promote those files locally; a guest rewrite alone
  does not update this worktree. The fallback script only collects
  `test-results` and `playwright-report`, so do not use its
  `--update-snapshots`: the rewritten goldens are not collected and the next
  run cleans the checkout. The existing promote-from-actual-artifacts flow in
  [CONTRIBUTING.md](../../../CONTRIBUTING.md) remains supported.
- For the Linux/xvfb GitHub Actions subset, use
  [`e2e-docker-repro`](../e2e-docker-repro/SKILL.md) — a Docker harness,
  unrelated to this lab.
- For Windows probes or Windows headed E2E, read the Windows VM skill in the
  attached PwrSuiteLab checkout. Do not use this skill for Windows work.
