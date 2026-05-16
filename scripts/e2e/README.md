# Local Docker repro of the GHA Desktop E2E job

A harness for poking at e2e flakes locally without waiting on
GHA. Builds a Linux container that mirrors the `Desktop E2E`
job: bookworm-based Node 24.14.1 image + xvfb + Electron runtime
libs, executed via `xvfb-run --auto-servernum pnpm run
test:desktop-e2e`.

## Quick start

```bash
# Full suite, current worktree.
./scripts/e2e/run-docker.sh

# Filter to one spec, stress-test 20 iterations (great for
# flake-hunting).
./scripts/e2e/run-docker.sh --test 'source-app filters' --iterations 20

# Reproduce a specific PR's failure without switching worktree.
./scripts/e2e/run-docker.sh --ref origin/fix/foo --iterations 30

# Drop into a shell in the container.
./scripts/e2e/run-docker.sh --shell
```

See `./scripts/e2e/run-docker.sh --help` for the full option list.

You can also invoke the same harness through pnpm from the repository root:

```bash
pnpm test:desktop-e2e:docker
pnpm test:desktop-e2e:docker --test 'source-app filters' --iterations 30
```

## What this runs

This mirrors the Linux GitHub Actions `Desktop E2E` job, not the complete
macOS-local E2E surface. The job runs the root `test:desktop-e2e` script under
`xvfb-run` in a Linux container, so specs that are explicitly macOS-only are
reported as skipped.

At the time this harness was added, a healthy full Linux run reports 38 tests:
23 passed and 15 skipped. The skipped tests are intentional:

- 5 clipboard copy tests that exercise macOS pasteboard behavior
- 4 float-over visibility tests that depend on macOS windowing behavior
- 1 library focus/scroll restoration test marked macOS-only
- 1 region capture test that is macOS-only and opt-in
- 1 menu-bar region selector test marked macOS-only
- 3 tray sizing tests that depend on macOS tray/popover behavior

Use this harness for GHA/Linux/xvfb parity and flake reproduction. Use native
macOS E2Es when validating pasteboard, tray, menu-bar, screen-capture, or other
AppKit-facing behavior.

## Layout

- `Dockerfile.e2e` — Linux image. Bookworm base, Node 24.14.1
  pinned, xvfb + Electron runtime libs (matches what GHA's
  ubuntu-latest pulls in via the bundled Chrome).
- `run-docker.sh` — wrapper. Handles the bind-mount + named-volume
  + xvfb-run dance, source staging (rsync to a known-mountable
  path), git-ref checkout, iteration loops.
- `README.md` — you are here.

## Why the wrapper rsyncs through a stage dir

Docker engines vary on what host paths they expose to containers:

- Docker Desktop usually mounts `$HOME` automatically.
- Colima mounts only what `~/.colima/<profile>/colima.yaml` lists
  under `mounts:`. With non-default configs, `$HOME` is unavailable.
- Lima/orbstack/nerdctl all have their own quirks.

The wrapper sidesteps the question by rsyncing source to a
`--stage` dir before running. On Colima, point that at something
the VM can see:

```bash
export PWRSNAP_E2E_STAGE=/Volumes/Dev/pwrsnap-e2e-stage
./scripts/e2e/run-docker.sh ...
```

On Docker Desktop the default `/tmp/pwrsnap-e2e-stage` Just
Works.

## Why anonymous volumes for `node_modules`

The script binds source at `/work` and declares anonymous volumes
for every workspace's `node_modules`:

```
-v /work/node_modules
-v /work/apps/desktop/node_modules
-v /work/packages/shared/node_modules
-v /work/packages/codex-app-server-protocol/node_modules
```

Without these, the bind would expose the host's macOS-arm64
prebuilt `.node` binaries (`better-sqlite3.node`, `sharp/*.node`)
to the Linux container, which crash on load. The anonymous
volumes are empty on first start; `pnpm install` (which the
wrapper always runs) populates them with Linux-native binaries
that stay invisible to the host.

The named `pwrsnap-pnpm-store` volume persists pnpm's content-
addressable store across container runs so subsequent installs
hit the local CAS instead of npmjs.org.

## Faithfulness caveat — Apple Silicon vs GHA

GHA's `ubuntu-latest` runners are `x86-64` Linux. This harness on
an Apple Silicon host runs `linux/arm64` natively. The
Chromium/GTK code paths under xvfb differ between architectures
— most visibly, arm64 + xvfb hits a `_NET_WM_WINDOW_TYPE_PANEL`
atom-cache complaint and a flood of `g_object_ref/unref:
assertion 'G_IS_OBJECT (object)' failed` errors when PwrSnap
creates `type: "panel"` BrowserWindows (focus-sink, region
selectors). The GHA x86 builds don't show those.

Native Docker is the default because it is much faster and usually enough for
flake hunting. If you need a more faithful x86 reproduction:

```bash
# Requires Docker buildx + qemu installed (Docker Desktop ships
# them; Colima users need `colima start --arch x86_64` or qemu).
./scripts/e2e/run-docker.sh --platform linux/amd64 --build ...
```

Expect 5-10× slower runs, but better signal for x86-specific
flakes.

For most purposes the arm64 native run surfaces enough timing-
sensitive flakes (the bulk of E2E breakage). Just keep in mind
that "renderer crashes with GLib errors" is an arm64-emulation
artifact, not a GHA bug.

## When NOT to use this

- For fast unit tests: just `pnpm test` locally.
- For confirming a fix on real hardware: open a PR and watch CI.
  CI is the source of truth.
- For investigating non-flake failures: the host's `pnpm
  --filter @pwrsnap/desktop test:e2e` is faster (no Docker
  startup, native arm64 binaries, no xvfb) and surfaces the
  same logic bugs.

The harness shines when you need to:

- Reproduce a flake at a higher rate than CI (`--iterations 30`)
- Test against a specific git ref without switching worktree
  (`--ref origin/foo`)
- Confirm an xvfb-specific issue isn't host-display dependent
- Surface a Linux-specific behavior that doesn't happen on Mac
