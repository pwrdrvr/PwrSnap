// Codex model listing for Settings + chat model pickers.
//
// This routes through the app-wide Codex owner so model listing reuses the
// same App Server process as chat instead of spawning a short-lived one.

import type { CodexModelOption } from "@pwrsnap/shared";
import { listCodexModelsFromPool } from "./codex-agent-pool";

export type CodexModelLister = (input: {
  command: string;
  env: NodeJS.ProcessEnv;
  includeHidden: boolean;
}) => Promise<CodexModelOption[]>;

export const listCodexModels: CodexModelLister = async ({
  command,
  env,
  includeHidden
}) => listCodexModelsFromPool({ command, env, includeHidden });
