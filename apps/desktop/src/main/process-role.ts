// Which half of the two-process architecture this main process runs.
//
// See docs/plans/2026-06-12-001-feat-two-process-agent-library-split-plan.md.
// `combined` is the single-process shape PwrSnap has always had and stays
// the default until that plan's Phase 4 flips macOS to `agent`. The
// `library` role is never launched by the user directly — the agent's
// supervisor spawns it with the role flag on the command line.

export type ProcessRole = "combined" | "agent" | "library";

/**
 * The role this process resolved at bootstrap. Lives here (not in
 * index.ts) so handler modules can consult it without importing the
 * entry module. Defaults to `combined` — correct for unit tests and
 * any code path that runs before bootstrap.
 */
let runtimeProcessRole: ProcessRole = "combined";

export function setRuntimeProcessRole(role: ProcessRole): void {
  runtimeProcessRole = role;
}

export function getRuntimeProcessRole(): ProcessRole {
  return runtimeProcessRole;
}

export const PROCESS_ROLE_FLAG_PREFIX = "--pwrsnap-role=";

/** The argv flag the supervisor passes when spawning a role process. */
export function processRoleFlag(role: ProcessRole): string {
  return `${PROCESS_ROLE_FLAG_PREFIX}${role}`;
}

/**
 * Parse the role flag from argv, or null when absent. The last role flag
 * wins (mirrors how Chromium treats repeated switches). An unrecognized
 * value reads as `combined`, the safe single-process shape; we never want
 * a typo'd supervisor arg to produce a windowless half-app.
 */
export function parseProcessRoleFlag(argv: readonly string[]): ProcessRole | null {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith(PROCESS_ROLE_FLAG_PREFIX)) continue;
    const value = arg.slice(PROCESS_ROLE_FLAG_PREFIX.length);
    if (value === "combined" || value === "agent" || value === "library") {
      return value;
    }
    return "combined";
  }
  return null;
}

/** Like `parseProcessRoleFlag` but with the missing-flag default applied. */
export function parseProcessRole(argv: readonly string[]): ProcessRole {
  return parseProcessRoleFlag(argv) ?? "combined";
}

/**
 * The role this main process runs, resolved at the top of bootstrap:
 *
 *   1. An explicit `--pwrsnap-role=` flag always wins — that's how the
 *      supervisor launches the library child.
 *   2. E2E forces `combined` (the existing Playwright harness drives one
 *      process) unless the split lane opts in with `PWRSNAP_E2E_SPLIT=1`.
 *   3. Off macOS the split doesn't exist: always `combined`.
 *   4. `PWRSNAP_PROCESS_SPLIT` is the explicit dev/debug override —
 *      `"1"` forces the agent boot, `"0"` forces single-process,
 *      regardless of the user's setting.
 *   5. Otherwise the user's `experimental.processSplit` setting decides
 *      (sync file peek at boot, shipped default OFF — see
 *      process-split/settings-peek.ts). Read once; relaunch to apply.
 */
export function resolveProcessRole(input: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** `experimental.processSplit` from the settings-file peek; pass the
   *  shipped default (false) when the file is missing or unreadable. */
  experimentalProcessSplit: boolean;
}): ProcessRole {
  const flagged = parseProcessRoleFlag(input.argv);
  if (flagged !== null) return flagged;
  if (input.env["PWRSNAP_E2E"] === "1") {
    return input.env["PWRSNAP_E2E_SPLIT"] === "1" && input.platform === "darwin"
      ? "agent"
      : "combined";
  }
  if (input.platform !== "darwin") return "combined";
  const envOverride = input.env["PWRSNAP_PROCESS_SPLIT"];
  if (envOverride === "1") return "agent";
  if (envOverride === "0") return "combined";
  return input.experimentalProcessSplit ? "agent" : "combined";
}
