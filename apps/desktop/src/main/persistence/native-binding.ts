import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let resolvedBinding: string | undefined;

export function getNativeBinding(): string | undefined {
  if (resolvedBinding !== undefined) {
    return resolvedBinding || undefined;
  }

  if (!isElectron()) {
    resolvedBinding = "";
    return undefined;
  }

  const require = createRequire(import.meta.url);
  const betterSqlite3Dir = dirname(require.resolve("better-sqlite3/package.json"));
  const electronNative = join(betterSqlite3Dir, "electron-native", "better_sqlite3.node");

  if (existsSync(electronNative)) {
    resolvedBinding = electronNative;
    return electronNative;
  }

  resolvedBinding = "";
  return undefined;
}

function isElectron(): boolean {
  return "electron" in process.versions;
}
