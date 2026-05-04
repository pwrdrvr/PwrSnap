#!/usr/bin/env node
/**
 * Compile the bundled native helpers (currently just the
 * window-list helper). Idempotent — skips when the source hasn't
 * changed since the last build.
 *
 * Output: apps/desktop/build/native/<name>
 *
 * The compiled binaries are picked up by electron-builder via the
 * `extraResources` entry in electron-builder.yml and end up at
 * Contents/Resources/PwrSnap<Name> in the packaged .app. At runtime,
 * src/main/capture/window-list.ts looks them up via
 * `process.resourcesPath` (production) or by walking up from
 * `__dirname` (dev — `out/main/...` → `apps/desktop/build/native/...`).
 *
 * macOS-only — these helpers wrap macOS-specific APIs. On
 * Linux/Windows the build is a no-op so unit tests + Linux CI keep
 * working.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopRoot = resolve(__dirname, "..");
const nativeRoot = join(desktopRoot, "native");
const buildRoot = join(desktopRoot, "build", "native");

if (process.platform !== "darwin") {
  console.log("[build-native] non-darwin platform — skipping");
  process.exit(0);
}

mkdirSync(buildRoot, { recursive: true });

const targets = [
  {
    name: "window-list",
    sources: [join(nativeRoot, "window-list", "main.swift")],
    output: join(buildRoot, "window-list")
  }
];

for (const target of targets) {
  const newestSourceMtime = Math.max(
    ...target.sources.map((p) => statSync(p).mtimeMs)
  );
  const outputExists = existsSync(target.output);
  const upToDate =
    outputExists && statSync(target.output).mtimeMs >= newestSourceMtime;

  if (upToDate) {
    console.log(`[build-native] ${target.name} up to date`);
    continue;
  }

  console.log(`[build-native] compiling ${target.name}…`);
  const result = spawnSync(
    "swiftc",
    [
      "-O", // optimized; binary is small + invoked synchronously on hot paths
      "-o",
      target.output,
      ...target.sources
    ],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    console.error(`[build-native] ${target.name} compilation failed`);
    process.exit(result.status ?? 1);
  }
  console.log(`[build-native] ${target.name} → ${target.output}`);
}
