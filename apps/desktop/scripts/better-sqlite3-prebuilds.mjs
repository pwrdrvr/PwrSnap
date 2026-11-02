import { existsSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const targetTokenPattern = /^[a-z0-9][a-z0-9-]*$/;

function validateTargetToken(label, value) {
  if (typeof value !== "string" || !targetTokenPattern.test(value)) {
    throw new Error(`invalid better-sqlite3 target ${label}: ${String(value)}`);
  }
  return value;
}

/**
 * Prebuilds one packaged runtime target loads.
 *
 * better-sqlite3 13 is N-API and ships a prebuild for every platform it
 * supports inside the one npm package, as prebuilds/<platform>-<arch>.node.
 * Its loader picks the file for process.platform/process.arch at runtime,
 * so Electron and system Node load the same binary and nothing is rebuilt.
 * A universal macOS app keeps both darwin files: each per-arch app tree
 * electron-builder merges carries the pair, and whichever CPU runs the
 * merged app loads its own.
 */
export function betterSqlite3PrebuildsForTarget({ platform, arch }) {
  const targetPlatform = validateTargetToken("platform", platform);
  const targetArch = validateTargetToken("arch", arch);
  if (targetPlatform === "darwin" && targetArch === "universal") {
    return ["darwin-arm64.node", "darwin-x64.node"];
  }
  if (targetArch === "universal") {
    throw new Error(`universal is a darwin-only better-sqlite3 target, not ${targetPlatform}`);
  }
  return [`${targetPlatform}-${targetArch}.node`];
}

/**
 * Delete every other platform's prebuild from one staged node_modules.
 *
 * The rest are ~2 MB each of dead weight, and on macOS a stray x64 slice in
 * the arm64-only app fails verifyPackagedArchitecture. The target is checked
 * before the first deletion, so a broken deploy cannot become a partially
 * pruned stage. Files are unlinked, never rewritten: a stage file hardlinked
 * to the pnpm store loses only the stage's name for it.
 */
export function pruneBetterSqlite3Prebuilds({ nodeModulesDir, platform, arch }) {
  const prebuildsDir = join(nodeModulesDir, "better-sqlite3", "prebuilds");
  if (!existsSync(prebuildsDir)) {
    throw new Error(`staged better-sqlite3 prebuilds missing at ${prebuildsDir}`);
  }
  // A package linked in from outside the stage would make every unlink below
  // a deletion from the workspace install that the stage was deployed from.
  const fromStage = relative(realpathSync(nodeModulesDir), realpathSync(prebuildsDir));
  if (fromStage.startsWith("..") || isAbsolute(fromStage)) {
    throw new Error(`staged better-sqlite3 resolves outside ${nodeModulesDir}; refusing to prune`);
  }

  const required = betterSqlite3PrebuildsForTarget({ platform, arch });
  const listPrebuilds = () =>
    readdirSync(prebuildsDir).filter((name) => name.endsWith(".node")).sort();
  const present = listPrebuilds();
  const missing = required.filter((name) => !present.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `better-sqlite3 prebuild(s) missing for ${platform}/${arch}: ${missing.join(", ")}`
    );
  }

  const removed = present.filter((name) => !required.includes(name));
  for (const name of removed) {
    unlinkSync(join(prebuildsDir, name));
  }

  const after = listPrebuilds();
  if (after.join() !== [...required].sort().join()) {
    throw new Error(
      `better-sqlite3 prebuild pruning postcondition failed for ${platform}/${arch}: ` +
        `left ${after.join(", ") || "<none>"}`
    );
  }

  return { kept: required, removed };
}
