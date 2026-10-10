import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  betterSqlite3PrebuildsForTarget,
  pruneBetterSqlite3Prebuilds
} from "./better-sqlite3-prebuilds.mjs";

const require = createRequire(import.meta.url);
const roots = [];

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

// Every prebuild better-sqlite3 13.0.3 ships.
const allPrebuilds = [
  "darwin-arm64.node",
  "darwin-x64.node",
  "linux-arm64.node",
  "linux-x64.node",
  "linuxmusl-arm64.node",
  "linuxmusl-x64.node",
  "win32-arm64.node",
  "win32-x64.node"
];

function tempStage(prebuilds = allPrebuilds) {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-sqlite-prune-"));
  roots.push(root);
  const nodeModulesDir = join(root, "node_modules");
  const prebuildsDir = join(nodeModulesDir, "better-sqlite3", "prebuilds");
  mkdirSync(prebuildsDir, { recursive: true });
  for (const name of prebuilds) writeFileSync(join(prebuildsDir, name), name);
  return { root, nodeModulesDir, prebuildsDir };
}

describe("better-sqlite3 prebuild targets", () => {
  test("a universal Mac keeps both darwin slices; every other target keeps one file", () => {
    expect(betterSqlite3PrebuildsForTarget({ platform: "darwin", arch: "universal" })).toEqual([
      "darwin-arm64.node",
      "darwin-x64.node"
    ]);
    expect(betterSqlite3PrebuildsForTarget({ platform: "darwin", arch: "arm64" })).toEqual([
      "darwin-arm64.node"
    ]);
    expect(betterSqlite3PrebuildsForTarget({ platform: "win32", arch: "x64" })).toEqual([
      "win32-x64.node"
    ]);
  });

  test("rejects universal off darwin and malformed target tokens", () => {
    expect(() => betterSqlite3PrebuildsForTarget({ platform: "win32", arch: "universal" })).toThrow(
      /darwin-only/
    );
    expect(() => betterSqlite3PrebuildsForTarget({ platform: "../win32", arch: "x64" })).toThrow(
      /invalid better-sqlite3 target platform/
    );
    expect(() => betterSqlite3PrebuildsForTarget({ platform: "win32", arch: undefined })).toThrow(
      /invalid better-sqlite3 target arch/
    );
  });

  // The packaging scripts prune to these, and the Linux and macOS CI jobs load
  // from the installed tree directly: a release that dropped one would break
  // that target with a module-not-found, not a compile.
  test("the installed better-sqlite3 carries every prebuild PwrSnap loads", () => {
    const packageDir = dirname(require.resolve("better-sqlite3/package.json"));
    const shipped = readdirSync(join(packageDir, "prebuilds"));
    for (const name of [
      "darwin-arm64.node",
      "darwin-x64.node",
      "win32-x64.node",
      "linux-x64.node",
      "linux-arm64.node"
    ]) {
      expect(shipped).toContain(name);
    }
  });
});

describe("better-sqlite3 prebuild pruning", () => {
  test("removes every other target's prebuild, and is idempotent", () => {
    const { nodeModulesDir, prebuildsDir } = tempStage();

    const plan = pruneBetterSqlite3Prebuilds({ nodeModulesDir, platform: "win32", arch: "x64" });
    expect(plan.kept).toEqual(["win32-x64.node"]);
    expect(plan.removed).toEqual(allPrebuilds.filter((name) => name !== "win32-x64.node"));
    expect(readdirSync(prebuildsDir)).toEqual(["win32-x64.node"]);

    expect(
      pruneBetterSqlite3Prebuilds({ nodeModulesDir, platform: "win32", arch: "x64" }).removed
    ).toEqual([]);
  });

  test("a universal Mac stage keeps both darwin slices", () => {
    const { nodeModulesDir, prebuildsDir } = tempStage();
    pruneBetterSqlite3Prebuilds({ nodeModulesDir, platform: "darwin", arch: "universal" });
    expect(readdirSync(prebuildsDir).sort()).toEqual(["darwin-arm64.node", "darwin-x64.node"]);
  });

  test("a missing target prebuild fails before anything is deleted", () => {
    const { nodeModulesDir, prebuildsDir } = tempStage(
      allPrebuilds.filter((name) => name !== "darwin-x64.node")
    );
    expect(() =>
      pruneBetterSqlite3Prebuilds({ nodeModulesDir, platform: "darwin", arch: "universal" })
    ).toThrow(/missing for darwin\/universal: darwin-x64\.node/);
    expect(readdirSync(prebuildsDir)).toHaveLength(allPrebuilds.length - 1);
  });

  test("a stage file hardlinked to the store only loses the stage's name for it", () => {
    const { root, nodeModulesDir, prebuildsDir } = tempStage(["win32-x64.node"]);
    const storeCopy = join(root, "store-linux-x64.node");
    writeFileSync(storeCopy, "store bytes");
    linkSync(storeCopy, join(prebuildsDir, "linux-x64.node"));

    pruneBetterSqlite3Prebuilds({ nodeModulesDir, platform: "win32", arch: "x64" });
    expect(existsSync(join(prebuildsDir, "linux-x64.node"))).toBe(false);
    expect(readFileSync(storeCopy, "utf8")).toBe("store bytes");
  });

  test("refuses a package that resolves outside the stage", () => {
    const workspace = tempStage();
    const root = mkdtempSync(join(tmpdir(), "pwrsnap-sqlite-stage-"));
    roots.push(root);
    const nodeModulesDir = join(root, "node_modules");
    mkdirSync(nodeModulesDir);
    symlinkSync(
      join(workspace.nodeModulesDir, "better-sqlite3"),
      join(nodeModulesDir, "better-sqlite3"),
      "junction"
    );

    expect(() =>
      pruneBetterSqlite3Prebuilds({ nodeModulesDir, platform: "win32", arch: "x64" })
    ).toThrow(/resolves outside/);
    expect(readdirSync(workspace.prebuildsDir)).toHaveLength(allPrebuilds.length);
  });

  test("a stage with no prebuilds directory is an error, not a no-op", () => {
    const root = mkdtempSync(join(tmpdir(), "pwrsnap-sqlite-empty-"));
    roots.push(root);
    expect(() =>
      pruneBetterSqlite3Prebuilds({
        nodeModulesDir: join(root, "node_modules"),
        platform: "win32",
        arch: "x64"
      })
    ).toThrow(/prebuilds missing/);
  });
});
