import { realpath } from "node:fs/promises";
import type {
  DesktopCodexCandidateSource,
  DesktopCodexVersionAdvisory
} from "@pwrsnap/shared";

// Model-catalog baseline, separate from the minimum CLI we can launch.
export const CODEX_MINIMUM_RECOMMENDED_VERSION = "0.159.2";

export function parseCodexVersionCore(version: string | undefined): number[] | undefined {
  const match = version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/u);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Unknown is not old. Compare the release core, as PwrAgnt does for alphas. */
export function isCodexVersionBelowMinimum(
  version: string | undefined,
  minimum = CODEX_MINIMUM_RECOMMENDED_VERSION
): boolean {
  const actual = parseCodexVersionCore(version);
  const floor = parseCodexVersionCore(minimum);
  if (!actual || !floor) return false;
  for (let index = 0; index < 3; index += 1) {
    const delta = actual[index]! - floor[index]!;
    if (delta !== 0) return delta < 0;
  }
  return false;
}

export function classifyCodexInstaller(params: {
  command: string;
  resolvedPath?: string | undefined;
  source?: DesktopCodexCandidateSource | undefined;
}): Pick<DesktopCodexVersionAdvisory, "installer" | "upgradeCommand"> {
  const paths = [params.resolvedPath, params.command]
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.replaceAll("\\", "/"));
  const has = (pattern: RegExp): boolean => paths.some((entry) => pattern.test(entry));
  if (has(/\/Caskroom\/codex\//iu)) {
    return { installer: "homebrew", upgradeCommand: "brew upgrade --cask codex" };
  }
  if (has(/\/Cellar\/codex\//iu)) {
    return { installer: "homebrew", upgradeCommand: "brew upgrade codex" };
  }
  // Test package-manager roots before generic node_modules (pnpm/bun use it too).
  if (has(/\/\.bun\/(?:install\/global\/node_modules\/@openai\/codex\b|bin\/codex(?:\.exe)?$)/iu)) {
    return { installer: "bun", upgradeCommand: "bun add -g @openai/codex@latest" };
  }
  if (has(/\/pnpm\/(?:global\/[^/]+\/(?:.*\/)?node_modules\/@openai\/codex\b|codex(?:\.(?:cmd|ps1|exe))?$)/iu)) {
    return { installer: "pnpm", upgradeCommand: "pnpm add -g @openai/codex@latest" };
  }
  if (has(/\/node_modules\/@openai\/codex\b/iu) ||
      has(/\/AppData\/Roaming\/npm\/codex\.(?:cmd|ps1)$/iu)) {
    return { installer: "npm", upgradeCommand: "npm install -g @openai/codex@latest" };
  }
  // Discovery's "application" group includes standalone search locations.
  // Only an actual app bundle path identifies an app-managed installation.
  if (has(/\/(?:ChatGPT|Codex)\.app\//iu)) {
    return { installer: "application" };
  }
  return { installer: "unknown" };
}

export async function buildCodexVersionAdvisory(params: {
  command: string;
  version?: string | undefined;
  source?: DesktopCodexCandidateSource | undefined;
  /** True when discovery resolved no launchable binary. */
  blocking?: boolean;
  resolvePath?: (command: string) => Promise<string | undefined>;
}): Promise<DesktopCodexVersionAdvisory | undefined> {
  if (!isCodexVersionBelowMinimum(params.version)) return undefined;
  const resolvedPath = await (params.resolvePath ?? defaultResolvePath)(params.command);
  return {
    command: params.command,
    version: parseCodexVersionCore(params.version)!.join("."),
    minimumVersion: CODEX_MINIMUM_RECOMMENDED_VERSION,
    ...classifyCodexInstaller({ ...params, resolvedPath }),
    ...(params.blocking ? { blocking: true as const } : {})
  };
}

async function defaultResolvePath(command: string): Promise<string | undefined> {
  try { return await realpath(command); } catch { return undefined; }
}

type Listener = (advisory: DesktopCodexVersionAdvisory | null) => void;
const listeners = new Set<Listener>();
let publishedKey: string | undefined;

/** Publish only content changes; timestamps/unrelated settings cannot re-toast. */
export function publishCodexVersionAdvisory(advisory: DesktopCodexVersionAdvisory | null): void {
  const key = JSON.stringify(advisory);
  if (publishedKey === key) return;
  publishedKey = key;
  for (const listener of [...listeners]) listener(advisory);
}

export function onCodexVersionAdvisoryChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
