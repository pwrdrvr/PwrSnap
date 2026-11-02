import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Empty pnpm 12 environment values inherit the user's global hook. A stage
// carries its own no-op, and signing computes the path after restoration.
export function stagedPnpmConfigEnv(stageDir) {
  const hookPath = resolve(stageDir, ".pnpmfile-global.cjs");
  if (!existsSync(hookPath)) {
    throw new Error(`Prepared stage is missing its pnpm global hook: ${hookPath}`);
  }
  return {
    pnpm_config_global_pnpmfile: hookPath,
    PNPM_CONFIG_GLOBAL_PNPMFILE: hookPath
  };
}
