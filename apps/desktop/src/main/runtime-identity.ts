import { execFileSync } from "node:child_process";
import type { AppRuntimeIdentity } from "@pwrsnap/shared";

function readGitValue(cwd: string, args: string[]): string | undefined {
  try {
    const value = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the checkout that launched this development instance. Mirrors
 *  PwrAgent's runtime identity probe, including detached-HEAD handling. */
export function resolveRuntimeIdentity(cwd = process.cwd()): AppRuntimeIdentity {
  const branch =
    readGitValue(cwd, ["branch", "--show-current"]) ??
    readGitValue(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

  if (branch !== undefined) {
    return { branch, cwd };
  }

  const commitSha = readGitValue(cwd, ["rev-parse", "HEAD"]);

  return {
    ...(commitSha !== undefined ? { commitSha, detachedHead: true } : {}),
    cwd
  };
}
