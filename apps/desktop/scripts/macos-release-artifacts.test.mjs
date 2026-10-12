import { afterEach, describe, expect, test } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { linkSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleMacArtifacts, assertStagedSharpTarget, releaseArchitecture, stageName, verifyStageTarget, pruneStagedSharp, thinStagedFfmpeg } from "./macos-release-artifacts.mjs";

const require = createRequire(import.meta.url);
const { MacUpdater } = require("electron-updater/out/MacUpdater.js");
const { resolveFiles, findFile } = require("electron-updater/out/providers/Provider.js");
const roots = [];
const version = "1.2.0-beta.1";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-mac-release-"));
  roots.push(root);
  const dirs = ["universal", "arm64"].map((arch) => {
    const dir = join(root, arch);
    mkdirSync(dir);
    const zip = `PwrSnap-${version}-${arch}-mac.zip`;
    const bytes = Buffer.from(`zip payload ${arch}`);
    const sha512 = createHash("sha512").update(bytes).digest("base64");
    writeFileSync(join(dir, zip), bytes);
    writeFileSync(join(dir, `${zip}.blockmap`), "blockmap");
    writeFileSync(join(dir, `PwrSnap-${version}-${arch}.dmg`), `dmg ${arch}`);
    writeFileSync(join(dir, "latest-mac.yml"), JSON.stringify({ version, files: [{ url: zip, sha512, size: bytes.length }], path: zip, sha512 }));
    return dir;
  });
  return dirs;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("macOS paired release", () => {
  test("isolates targets and rejects ambiguous or invalid architecture flags", () => {
    expect(releaseArchitecture([])).toBe("universal");
    expect(stageName(releaseArchitecture(["--arch=arm64"]))).toBe("release-stage-arm64");
    for (const args of [["--arch=x64"], ["--arch", "arm64"], ["--arch=arm64", "--arch=universal"]]) {
      expect(() => releaseArchitecture(args)).toThrow();
    }
    const [dir] = fixture();
    writeFileSync(join(dir, "release-target.json"), JSON.stringify({ arch: "universal", version }));
    expect(() => verifyStageTarget(dir, "arm64", version)).toThrow(/mismatch/);
    expect(() => verifyStageTarget(dir, "universal", "9.0.0")).toThrow(/mismatch/);
    expect(() => verifyStageTarget(dir, "universal", version)).not.toThrow();
  });
  test("prunes nested optional dependency declarations without mutating shared manifests", () => {
    const [stage] = fixture();
    const modules = join(stage, "node_modules");
    const all = ["sharp-darwin-arm64", "sharp-libvips-darwin-arm64", "sharp-darwin-x64", "sharp-libvips-darwin-x64"];
    for (const name of all) mkdirSync(join(modules, "@img", name), { recursive: true });
    mkdirSync(join(modules, "sharp"));
    const original = JSON.stringify({ optionalDependencies: Object.fromEntries(all.map((name) => [`@img/${name}`, "1.0.0"])) });
    const shared = join(stage, "workspace-sharp.json");
    writeFileSync(shared, original);
    linkSync(shared, join(modules, "sharp/package.json"));
    pruneStagedSharp(stage, "arm64");
    pruneStagedSharp(stage, "arm64");
    expect(readFileSync(shared, "utf8")).toBe(original);
    expect(Object.keys(JSON.parse(readFileSync(join(modules, "sharp/package.json"), "utf8")).optionalDependencies)).toEqual(all.slice(0, 2).map((name) => `@img/${name}`));
    expect(existsSync(join(modules, "@img/sharp-darwin-x64"))).toBe(false);
  });
  // What pnpm deploy + injectDarwinPlatformPackages leave behind: the four
  // injected Darwin slices at the top level, and a sharp manifest that still
  // declares every platform (electron-builder follows those declarations).
  function deployedStage() {
    const [stage] = fixture();
    const modules = join(stage, "node_modules");
    for (const name of ["colour", ...darwinSlices]) mkdirSync(join(modules, "@img", name), { recursive: true });
    mkdirSync(join(modules, "sharp"));
    const declared = [...darwinSlices, "sharp-win32-x64", "sharp-win32-arm64", "sharp-linux-x64", "sharp-libvips-linux-x64", "sharp-webcontainers-wasm32"];
    writeFileSync(join(modules, "sharp/package.json"), JSON.stringify({
      name: "sharp",
      dependencies: { "@img/colour": "1.0.0" },
      optionalDependencies: Object.fromEntries(declared.map((name) => [`@img/${name}`, "1.0.0"]))
    }));
    return { stage, modules };
  }
  const darwinSlices = ["sharp-darwin-arm64", "sharp-libvips-darwin-arm64", "sharp-darwin-x64", "sharp-libvips-darwin-x64"];
  const optionalDeps = (modules) => Object.keys(JSON.parse(readFileSync(join(modules, "sharp/package.json"), "utf8")).optionalDependencies);

  test("narrows the universal stage to both Darwin slices, so no Windows slice ships", () => {
    const { stage, modules } = deployedStage();
    expect(() => assertStagedSharpTarget(stage, "universal")).toThrow(/declared by sharp=.*@img\/sharp-win32-x64/);
    pruneStagedSharp(stage, "universal");
    expect(optionalDeps(modules)).toEqual(darwinSlices.map((name) => `@img/${name}`));
    for (const name of darwinSlices) expect(existsSync(join(modules, "@img", name))).toBe(true);
    expect(JSON.parse(readFileSync(join(modules, "sharp/package.json"), "utf8")).dependencies).toEqual({ "@img/colour": "1.0.0" });
    expect(() => assertStagedSharpTarget(stage, "universal")).not.toThrow();
    // The arm64 assertion still sees the Intel slices as foreign.
    expect(() => assertStagedSharpTarget(stage, "arm64")).toThrow(/foreign=@img\/sharp-darwin-x64, @img\/sharp-libvips-darwin-x64/);
  });

  test.each(["universal", "arm64"])("refuses a staged sharp-wasm32 on %s before deleting anything", (arch) => {
    const { stage, modules } = deployedStage();
    mkdirSync(join(modules, "@img/sharp-wasm32"));
    const manifestBefore = readFileSync(join(modules, "sharp/package.json"), "utf8");
    expect(() => pruneStagedSharp(stage, arch)).toThrow(/no shipped target uses: @img\/sharp-wasm32/);
    expect(existsSync(join(modules, "@img/sharp-wasm32"))).toBe(true);
    expect(existsSync(join(modules, "@img/sharp-darwin-x64"))).toBe(true);
    expect(readFileSync(join(modules, "sharp/package.json"), "utf8")).toBe(manifestBefore);
    expect(() => assertStagedSharpTarget(stage, arch)).toThrow(/foreign=.*@img\/sharp-wasm32/);
  });

  test("assertStagedSharpTarget reports a missing slice and rejects unknown arches", () => {
    const { stage, modules } = deployedStage();
    pruneStagedSharp(stage, "universal");
    rmSync(join(modules, "@img/sharp-darwin-x64"), { recursive: true });
    expect(() => assertStagedSharpTarget(stage, "universal")).toThrow(/missing=@img\/sharp-darwin-x64/);
    expect(() => assertStagedSharpTarget(stage, "x64")).toThrow(/Unsupported macOS architecture/);
    expect(() => pruneStagedSharp(stage, "x64")).toThrow(/Unsupported macOS architecture/);
  });

  test("prunes and asserts every macOS stage, and re-asserts on the sign-only path", () => {
    const release = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
    expect(release).not.toMatch(/if \(releaseArch === "arm64"\)\s*\{?\s*pruneStaged/);
    const prune = release.indexOf("pruneStagedSharp(stageDir, releaseArch);");
    const first = release.indexOf("assertStagedSharpTarget(stageDir, releaseArch)");
    const second = release.indexOf("assertStagedSharpTarget(stageDir, releaseArch)", first + 1);
    const signOnly = release.indexOf("verifyStageTarget(stageDir, releaseArch");
    const builder = release.indexOf("// 8. electron-builder.");
    expect(release.split("assertStagedSharpTarget(stageDir, releaseArch)")).toHaveLength(3);
    expect(prune).toBeGreaterThan(release.indexOf("injectDarwinPlatformPackages();"));
    expect(prune).toBeLessThan(first);
    expect(first).toBeLessThan(signOnly);
    expect(signOnly).toBeLessThan(second);
    expect(second).toBeLessThan(builder);
  });
  test("rejects unverified FFmpeg before extraction or provenance writes", () => {
    const [stage] = fixture();
    mkdirSync(join(stage, "build/ffmpeg"), { recursive: true });
    mkdirSync(join(stage, "build/ffmpeg-source"));
    writeFileSync(join(stage, "build/ffmpeg/ffmpeg"), "unverified binary");
    writeFileSync(join(stage, "build/ffmpeg-source/ffmpeg-8.1.1-macos-universal-manifest.json"), JSON.stringify({ platform: "macos", arch: "universal", sha256: "wrong" }));
    expect(() => thinStagedFfmpeg(stage)).toThrow(/hash mismatch/);
    expect(readFileSync(join(stage, "build/ffmpeg/ffmpeg"), "utf8")).toBe("unverified binary");
    expect(existsSync(join(stage, "build/ffmpeg-source/ffmpeg-macos-arm64-slice.json"))).toBe(false);
  });
  test("archives both stages and the tools needed after the signing boundary", () => {
    const workflow = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
    const archive = workflow.split("- name: Archive signing input")[1].split("- name: Upload signing input")[0];
    for (const input of ["apps/desktop/release-stage-arm64", "apps/desktop/scripts/macos-release-artifacts.mjs", "apps/desktop/scripts/sharp-platform-packages.mjs", "apps/desktop/scripts/better-sqlite3-prebuilds.mjs", "scripts/lib/cli-entrypoint.mjs"]) expect(archive).toContain(input);
    expect(workflow).toContain("--sign-stage-only --no-publish --arch=arm64");
    expect(workflow).toContain("mac-dist/dist/PwrSnap-arm64.dmg");
    expect(workflow).toContain("--draft=false --prerelease");
  });
  test("keeps legacy fallback and routes both architectures with the shipped updater", () => {
    const dirs = fixture();
    const info = assembleMacArtifacts(...dirs, version);
    expect(info.path).toContain("-universal-mac.zip");
    expect(info.sha512).toBe(info.files[0].sha512);
    expect(readFileSync(join(dirs[0], "PwrSnap.dmg"), "utf8")).toBe("dmg universal");
    expect(readFileSync(join(dirs[0], "PwrSnap-arm64.dmg"), "utf8")).toBe("dmg arm64");
    const files = resolveFiles(info, new URL("https://example.test/release/"));
    // isArm64Mac also covers a Rosetta-translated x64 process on Apple Silicon.
    for (const ordering of [files, [...files].reverse()]) {
      expect(findFile(MacUpdater.filterFilesForArch(ordering, true), "zip").url.pathname).toContain("-arm64-mac.zip");
      expect(findFile(MacUpdater.filterFilesForArch(ordering, false), "zip").url.pathname).toContain("-universal-mac.zip");
    }
    expect(findFile(MacUpdater.filterFilesForArch(files.slice(0, 1), true), "zip").url.pathname).toContain("-universal-mac.zip");
    expect(MacUpdater.filterFilesForArch(files.slice(1), false)).toHaveLength(0);
  });
  test.each(["hash", "size", "version", "url", "duplicate", "blockmap"])("rejects %s corruption before overwriting universal metadata", (failure) => {
    const dirs = fixture();
    const original = readFileSync(join(dirs[0], "latest-mac.yml"), "utf8");
    const path = join(dirs[1], "latest-mac.yml");
    const info = JSON.parse(readFileSync(path, "utf8"));
    if (failure === "hash") info.files[0].sha512 = "wrong";
    if (failure === "size") info.files[0].size++;
    if (failure === "version") info.version = "9.0.0";
    if (failure === "url") info.files[0].url = "../wrong.zip";
    if (failure === "duplicate") info.files.push(info.files[0]);
    if (failure === "blockmap") rmSync(join(dirs[1], `${info.path}.blockmap`));
    writeFileSync(path, JSON.stringify(info));
    expect(() => assembleMacArtifacts(...dirs, version)).toThrow();
    expect(readFileSync(join(dirs[0], "latest-mac.yml"), "utf8")).toBe(original);
  });
});
