import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export async function resolveBenchmarkCodexHome(
  requestedHome: string,
  activeHomes: readonly string[]
): Promise<string> {
  const benchmarkHome = await realpath(requestedHome);
  for (const home of activeHomes) {
    const activeHome = await realpath(home).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return resolve(home);
      throw error;
    });
    const fromActiveHome = relative(activeHome, benchmarkHome);
    if (!isAbsolute(fromActiveHome) && fromActiveHome !== ".." && !fromActiveHome.startsWith(`..${sep}`)) {
      throw new Error("Use a separate Codex home for the benchmark");
    }
  }

  const auth = await lstat(join(benchmarkHome, "auth.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Sign in directly to the benchmark Codex home first");
    throw error;
  });
  if (!auth.isFile() || auth.nlink !== 1) {
    throw new Error("The benchmark Codex home needs its own auth.json file");
  }
  return benchmarkHome;
}
