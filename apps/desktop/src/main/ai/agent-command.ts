import {
  execFile as execFileCallback,
  execFileSync as nodeExecFileSync
} from "node:child_process";
import { promisify } from "node:util";
import {
  createCommandInvocation,
  prependCommandDirToPath,
  type CommandInvocation
} from "@pwrdrvr/agent-transport";

const execFile = promisify(execFileCallback);

export type AgentCommandParams = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | undefined;
};

/**
 * Pure platform seam for every short-lived local-agent probe. Windows npm
 * installs resolve to `.cmd` shims, which CreateProcess cannot execute
 * directly; the transport helper routes those shims through ComSpec with
 * escaped arguments while native executables retain ordinary argv handling.
 */
export function createAgentCommandInvocation(
  params: AgentCommandParams
): CommandInvocation {
  return createCommandInvocation(params);
}

type AgentCommandExecOptions = {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
};

export async function execAgentCommand(
  command: string,
  args: string[],
  options: AgentCommandExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const env = prependCommandDirToPath(command, options.env);
  const invocation = createAgentCommandInvocation({ command, args, env });
  const result = await execFile(invocation.command, invocation.args, {
    encoding: "utf8",
    env,
    timeout: options.timeoutMs,
    windowsHide: process.platform === "win32",
    ...(invocation.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: invocation.windowsVerbatimArguments })
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export function execAgentCommandSync(
  command: string,
  args: string[],
  options: AgentCommandExecOptions
): string {
  const env = prependCommandDirToPath(command, options.env);
  const invocation = createAgentCommandInvocation({ command, args, env });
  return nodeExecFileSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeoutMs,
    windowsHide: process.platform === "win32",
    ...(invocation.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: invocation.windowsVerbatimArguments })
  });
}
