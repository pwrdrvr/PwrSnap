import { execFileSync } from "node:child_process";
import type { AppRuntimeIdentity } from "@pwrsnap/shared";

type DevelopmentRuntimeIdentityOptions = {
  isPackaged: boolean;
  nodeEnv: string | undefined;
  cwd?: string;
};

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

/** Only development checkouts expose Git identity to app surfaces. */
export function resolveDevelopmentRuntimeIdentity(
  options: DevelopmentRuntimeIdentityOptions
): AppRuntimeIdentity | undefined {
  if (options.isPackaged || options.nodeEnv === "production") return undefined;

  const identity = resolveRuntimeIdentity(options.cwd);
  if (identity.branch === undefined && identity.commitSha === undefined) return undefined;
  return identity;
}

/** Electron renders `version` as the parenthesized build value in the native
 *  About panel. Put the useful checkout identity there for development runs. */
export function resolveAboutPanelBuildVersion(
  appVersion: string,
  identity: AppRuntimeIdentity | undefined
): string {
  if (identity?.branch !== undefined) return identity.branch;
  if (identity?.detachedHead === true && identity.commitSha !== undefined) {
    return `HEAD ${identity.commitSha.slice(0, 8)}`;
  }
  return appVersion;
}
