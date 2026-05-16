---
name: e2e-docker-repro
description: Run and debug PwrSnap Desktop E2E tests inside the local Docker/xvfb harness that mirrors GitHub Actions. Use when investigating GHA Desktop E2E failures, Linux/xvfb-only Electron bugs, flaky Playwright specs, teardown hangs, source-filter flakes, or when asked to reproduce a PR CI failure locally with scripts/e2e/run-docker.sh.
---

# E2E Docker Repro

Use this skill to reproduce PwrSnap Desktop E2E failures locally in the Linux
Docker harness under [scripts/e2e](../../../scripts/e2e).

## Start Here

1. Read the reported CI failure first: failing job URL, test name, timeout,
   stack trace, and whether Playwright marked it `flaky`.
2. Check the local branch and diff before running anything:

   ```bash
   git status --short --branch
   git log --oneline -3 --decorate
   ```

3. Prefer a focused repro before a full-suite run. Use the exact Playwright
   title substring from CI when possible.
4. Start on Docker's native Linux platform. Use `--platform linux/amd64` only
   when the failure looks architecture-specific or you need exact GHA x86
   parity; it is much slower on Apple Silicon.

## Commands

Run from the repository root.

Focused stress run against the current worktree:

```bash
PWRSNAP_E2E_STAGE=/tmp/pwrsnap-e2e-stage \
  ./scripts/e2e/run-docker.sh \
  --test '<Playwright title or grep pattern>' \
  --iterations 30 \
  --keep-stage
```

Full GHA-style Desktop E2E job:

```bash
PWRSNAP_E2E_STAGE=/tmp/pwrsnap-e2e-stage \
  ./scripts/e2e/run-docker.sh --keep-stage
```

Equivalent root pnpm entrypoint:

```bash
pnpm test:desktop-e2e:docker --keep-stage
```

Run a different ref without switching the worktree:

```bash
git fetch origin
PWRSNAP_E2E_STAGE=/tmp/pwrsnap-e2e-stage \
  ./scripts/e2e/run-docker.sh \
  --ref origin/<branch-or-ref> \
  --test '<pattern>' \
  --iterations 30 \
  --keep-stage
```

Drop into the staged container for ad-hoc inspection:

```bash
PWRSNAP_E2E_STAGE=/tmp/pwrsnap-e2e-stage \
  ./scripts/e2e/run-docker.sh --shell
```

## Workflow

1. Reproduce the failure with a focused `--test` pattern and `--iterations`.
   The wrapper runs Playwright with `--retries 0` in iteration mode, so every
   failure is a real first-attempt failure.
2. If the failure only appears in CI mode, run the full suite. Full-suite mode
   executes the root `pnpm run test:desktop-e2e` under `xvfb-run`, matching GHA.
3. Preserve evidence while investigating:
   - Use `--keep-stage` so `/tmp/pwrsnap-e2e-stage` remains inspectable.
   - Read `apps/desktop/test-results/.../error-context.md` and traces from the
     staged tree when Playwright emits them.
   - Capture the pass/fail rate and exact command in the final report.
4. Instrument narrowly when needed, then remove temporary logging before the
   final fix. Prefer fixture/test-level logging first for Electron lifecycle
   failures, then app-level logging only after the failing boundary is known.
5. Verify fixes with both a focused stress run and a full-suite run when the
   original failure came from CI.

## Interpretation Notes

- A healthy full Linux/GHA-style run only covers the Linux-safe subset. Expect
  the macOS-only specs to be skipped; the current normal shape is 38 total,
  23 passed, 15 skipped.
- `Target page, context or browser has been closed` usually means Electron
  exited or crashed; inspect preceding browser logs for `SIGTRAP`, GLib, DBus,
  or renderer crash output before changing assertions.
- A Playwright `flaky` result in CI means a retry passed. Fix the first-attempt
  failure anyway; first-attempt timeouts can interrupt `finally` cleanup and
  create an additional "error was not a part of any test".
- If the pasted CI timeout differs from the local file's configured timeout,
  check the Actions run `headSha` before debugging. The run may be from an old
  pushed commit.
- CI remains the source of truth after pushing. Local Docker proves likelihood,
  not certainty.

## Common Pitfalls

- Do not trust output text parsing for pass/fail; use process exit status.
- Do not compare native arm64 Docker failures to GHA without considering
  architecture. Retry with `--platform linux/amd64` when the signal appears
  architecture-specific.
- Do not delete or overwrite user work while staging; the wrapper rsyncs into
  `PWRSNAP_E2E_STAGE`, not back into the repo.
- Do not leave debug logs, debug env gates, or preserved-home switches in the
  final patch unless they are intentional product/test features.
