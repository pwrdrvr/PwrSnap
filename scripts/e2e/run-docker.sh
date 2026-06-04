#!/usr/bin/env bash
# Run the Desktop E2E suite (or a subset) inside a Linux + xvfb
# container that mirrors the GHA `Desktop E2E` job. Wraps the
# bind-mount + named-volume + xvfb-run dance so callers don't have
# to remember it.
#
# The script is parametric on:
#   - what source to test (current worktree, an arbitrary path, or
#     a git ref the script will check out into a tmp dir)
#   - where to stage the source for mounting (some Docker engines —
#     notably Colima with a non-default mounts: config — can't see
#     arbitrary host paths; we rsync into a known-mountable stage
#     dir as a workaround)
#   - which test pattern to run, and how many times
#
# Usage:
#   ./scripts/e2e/run-docker.sh [options]
#
# Options:
#   --source <path>     Source directory to test. Default: repo
#                       root (`git rev-parse --show-toplevel`).
#                       Mutually exclusive with --ref.
#   --ref <git-ref>     Check out the given ref into a tmp dir
#                       instead of using --source. Useful for
#                       reproducing a PR's CI failure without
#                       switching your worktree. Clones from
#                       `origin` of the current repo. Mutually
#                       exclusive with --source.
#   --stage <path>      Where to materialize source for mounting.
#                       Default: $PWRSNAP_E2E_STAGE if set, else
#                       /tmp/pwrsnap-e2e-stage. Override with a
#                       Docker-engine-visible path when bind-mounts
#                       from /tmp don't work for your engine (e.g.
#                       on Colima with non-default mounts, point
#                       this at something under /Volumes/Dev).
#   --test <pattern>    Playwright -g pattern. Default: empty (runs
#                       the full e2e suite). Example:
#                       --test 'source-app filters'
#   --iterations <n>    Run the test pattern N times in a loop.
#                       Default: 1. Useful for surfacing flakes —
#                       --iterations 20 quickly reveals a 25%
#                       failure rate.
#   --image <name>      Image tag. Default: pwrsnap-e2e:local.
#   --build             Force rebuild the image even if it exists.
#                       Otherwise the image is built on first run
#                       and reused.
#   --platform <arch>   Pass to `docker build/run --platform`.
#                       Default: Docker's native Linux platform.
#                       Set to `linux/amd64` only when you need to
#                       emulate GHA's x86 hardware (requires
#                       Docker buildx + qemu; expect 5-10× slower
#                       runs).
#   --keep-stage        Don't remove the stage directory after the
#                       run. Useful for poking at the staged source
#                       afterward.
#   --shell             Drop into a shell in the container instead
#                       of running the test. Source + node_modules
#                       are mounted; pnpm install is NOT run
#                       automatically (you can run it yourself).
#   -h, --help          Show this message and exit.
#
# Environment:
#   PWRSNAP_E2E_STAGE   Default for --stage. Set this in your
#                       shell rc to avoid passing --stage every
#                       time (e.g. Colima users:
#                       `export PWRSNAP_E2E_STAGE=/Volumes/Dev/pwrsnap-e2e-stage`).
#
# Examples:
#   # Run the full suite once against the current worktree.
#   ./scripts/e2e/run-docker.sh
#
#   # Stress-test the flaky source-filter spec 20 times.
#   ./scripts/e2e/run-docker.sh \
#       --test 'source-app filters' --iterations 20
#
#   # Reproduce a specific PR's failure on a different ref.
#   ./scripts/e2e/run-docker.sh --ref origin/fix/foo \
#       --test 'source-app filters' --iterations 30
#
#   # Drop into a shell for ad-hoc poking.
#   ./scripts/e2e/run-docker.sh --shell

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SCRIPT_DIR="$REPO_ROOT/scripts/e2e"

SOURCE=""
REF=""
STAGE="${PWRSNAP_E2E_STAGE:-/tmp/pwrsnap-e2e-stage}"
TEST_PATTERN=""
ITERATIONS=1
IMAGE="pwrsnap-e2e:local"
FORCE_BUILD=0
PLATFORM=""
KEEP_STAGE=0
SHELL_MODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2;;
    --ref) REF="$2"; shift 2;;
    --stage) STAGE="$2"; shift 2;;
    --test) TEST_PATTERN="$2"; shift 2;;
    --iterations) ITERATIONS="$2"; shift 2;;
    --image) IMAGE="$2"; shift 2;;
    --build) FORCE_BUILD=1; shift;;
    --platform) PLATFORM="$2"; shift 2;;
    --keep-stage) KEEP_STAGE=1; shift;;
    --shell) SHELL_MODE=1; shift;;
    -h|--help)
      # Print the leading comment block (everything between `# Usage:`
      # and the first non-`#` line after it) so --help and the file
      # header stay in lock-step automatically.
      sed -n '/^# Usage:/,/^[^#]/ { /^[^#]/d; s/^# \{0,1\}//; p; }' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      echo "run with --help for usage" >&2
      exit 2
      ;;
  esac
done

if [[ -n "$SOURCE" && -n "$REF" ]]; then
  echo "--source and --ref are mutually exclusive" >&2
  exit 2
fi

# Materialize the source to test.
TMP_CLONE=""
if [[ -n "$REF" ]]; then
  TMP_CLONE="$(mktemp -d -t pwrsnap-e2e-ref-XXXXXX)"
  echo "[run-docker] materializing $REF → $TMP_CLONE" >&2
  # `git archive` is cleaner than `git clone --depth` here: no .git
  # dir, no remote-tracking refs to resolve, just the tree at the
  # requested ref. Works for any ref the local repo knows about
  # (commits, tags, branches, remote-tracking branches).
  if ! (cd "$REPO_ROOT" && git rev-parse --quiet --verify "$REF" >/dev/null); then
    echo "[run-docker] ref not found locally: $REF" >&2
    echo "[run-docker] hint: run 'git fetch origin' first to update remote-tracking refs" >&2
    exit 2
  fi
  (cd "$REPO_ROOT" && git archive --format=tar "$REF") | tar -xf - -C "$TMP_CLONE"
  SOURCE="$TMP_CLONE"
elif [[ -z "$SOURCE" ]]; then
  SOURCE="$REPO_ROOT"
fi

if [[ ! -d "$SOURCE" ]]; then
  echo "source not a directory: $SOURCE" >&2
  exit 2
fi

# Build the image if missing, --build forced, or the caller requests
# a platform that does not match the existing tagged image. Docker
# cache layers do the rest.
BUILD_ARGS=()
if [[ -n "$PLATFORM" ]]; then BUILD_ARGS+=(--platform "$PLATFORM"); fi
IMAGE_ID="$(docker images -q "$IMAGE" 2>/dev/null || true)"
IMAGE_PLATFORM_MISMATCH=0
TARGET_PLATFORM="$PLATFORM"
if [[ -z "$TARGET_PLATFORM" ]]; then
  TARGET_PLATFORM="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null || true)"
fi
if [[ -n "$IMAGE_ID" && -n "$TARGET_PLATFORM" ]]; then
  IMAGE_OS="$(docker image inspect -f '{{.Os}}' "$IMAGE" 2>/dev/null || true)"
  IMAGE_ARCH="$(docker image inspect -f '{{.Architecture}}' "$IMAGE" 2>/dev/null || true)"
  IMAGE_VARIANT="$(docker image inspect -f '{{.Variant}}' "$IMAGE" 2>/dev/null || true)"
  IMAGE_PLATFORM="$IMAGE_OS/$IMAGE_ARCH"
  if [[ -n "$IMAGE_VARIANT" ]]; then IMAGE_PLATFORM="$IMAGE_PLATFORM/$IMAGE_VARIANT"; fi
  if [[ "$TARGET_PLATFORM" != "$IMAGE_PLATFORM" && "$TARGET_PLATFORM" != "$IMAGE_OS/$IMAGE_ARCH" ]]; then
    IMAGE_PLATFORM_MISMATCH=1
  fi
fi
if [[ "$FORCE_BUILD" -eq 1 || -z "$IMAGE_ID" || "$IMAGE_PLATFORM_MISMATCH" -eq 1 ]]; then
  echo "[run-docker] building $IMAGE" >&2
  docker build "${BUILD_ARGS[@]}" -f "$SCRIPT_DIR/Dockerfile.e2e" -t "$IMAGE" "$REPO_ROOT"
fi

# Stage the source where Docker can mount it. rsync handles the
# Colima case (HOME not auto-mounted) and the "source is on a path
# the engine can't see" case generically. Excludes the same dirs
# the Dockerfile install would rebuild anyway.
echo "[run-docker] staging $SOURCE → $STAGE" >&2
mkdir -p "$STAGE"
rsync -a --delete \
  --exclude=node_modules --exclude=out --exclude=.git \
  --exclude=playwright-report --exclude=test-results --exclude=dist \
  --exclude=.pnpm-store \
  "$SOURCE/" "$STAGE/"

cleanup() {
  if [[ -n "$TMP_CLONE" ]]; then rm -rf "$TMP_CLONE"; fi
  if [[ "$KEEP_STAGE" -ne 1 ]]; then rm -rf "$STAGE"; fi
}
trap cleanup EXIT

# Compose the test command. Anonymous volumes for every node_modules
# path keep the host's macOS/arm64 .node binaries from leaking into
# the Linux container. The named pnpm-store volume survives across
# runs so subsequent installs hit the local CAS instead of npm.
RUN_ARGS=(
  --rm
  -v "$STAGE:/work"
  -v /work/node_modules
  -v /work/apps/desktop/node_modules
  -v /work/packages/shared/node_modules
  -v pwrsnap-pnpm-store:/root/.local/share/pnpm
)
if [[ -n "$PLATFORM" ]]; then RUN_ARGS+=(--platform "$PLATFORM"); fi

if [[ "$SHELL_MODE" -eq 1 ]]; then
  RUN_ARGS+=(-it)
  exec docker run "${RUN_ARGS[@]}" "$IMAGE" bash -l
fi

# Build the inner command. Always installs deps + builds first;
# either runs the test pattern N times in a loop, or runs the full
# test:desktop-e2e job.
INNER='set -euo pipefail
cd /work
echo "==install==" >&2
pnpm install --frozen-lockfile=false 2>&1 | tail -2
echo "==build==" >&2
pnpm --filter @pwrsnap/desktop build 2>&1 | tail -2
cd apps/desktop'

if [[ -n "$TEST_PATTERN" || "$ITERATIONS" -ne 1 ]]; then
  # Run the (optionally filtered) test N times; report pass/fail
  # counts at the end so callers can spot flake rates immediately.
  INNER+="
echo \"==test (iterations=$ITERATIONS, pattern='$TEST_PATTERN')==\" >&2
PASS=0
FAIL=0
for i in \$(seq 1 $ITERATIONS); do
  set +e
  OUTPUT=\$(CI= xvfb-run --auto-servernum pnpm exec playwright test -c playwright.config.ts ${TEST_PATTERN:+-g \"$TEST_PATTERN\"} --workers 1 --retries 0 --reporter line 2>&1)
  STATUS=\$?
  set -e
  RESULT=\$(printf '%s\\n' \"\$OUTPUT\" | tail -3 | tr -d '\\r')
  if [ \"\$STATUS\" -eq 0 ]; then
    PASS=\$((PASS+1))
    DURATION=\$(printf '%s\\n' \"\$RESULT\" | grep -oE '[0-9.]+s' | tail -1 || true)
    echo \"Run \$i: PASS (\$DURATION)\"
  else
    FAIL=\$((FAIL+1))
    echo \"Run \$i: FAIL\"
    printf '%s\\n' \"\$RESULT\" | head -5 || true
  fi
done
echo \"\"
echo \"=== \$PASS / $ITERATIONS passed ===\"
exit \$([ \$FAIL -eq 0 ] && echo 0 || echo 1)"
else
  # Full suite, GHA-style.
  INNER+="
cd /work
xvfb-run --auto-servernum pnpm run test:desktop-e2e
STATUS=\$?
exit \$STATUS"
fi

docker run "${RUN_ARGS[@]}" "$IMAGE" bash -lc "$INNER"
