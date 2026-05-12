import { existsSync, readFileSync } from "node:fs";
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
  const betterSqlite3PackagePath = require.resolve("better-sqlite3/package.json");
  const betterSqlite3Version = require(betterSqlite3PackagePath).version;
  const betterSqlite3Dir = dirname(betterSqlite3PackagePath);
  const electronNative = join(betterSqlite3Dir, "electron-native", "better_sqlite3.node");
  const metadataPath = join(betterSqlite3Dir, "electron-native", "metadata.json");

  if (
    existsSync(electronNative) &&
    isCurrentElectronNativeMetadata(metadataPath, betterSqlite3Version)
  ) {
    resolvedBinding = electronNative;
    return electronNative;
  }

  resolvedBinding = "";
  return undefined;
}

function isElectron(): boolean {
  return "electron" in process.versions;
}

function isCurrentElectronNativeMetadata(metadataPath: string, betterSqlite3Version: string): boolean {
  if (!existsSync(metadataPath)) {
    return false;
  }

  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    return (
      metadata.arch === process.arch &&
      metadata.betterSqlite3Version === betterSqlite3Version &&
      metadata.electronVersion === process.versions.electron
    );
  } catch {
    return false;
  }
}
