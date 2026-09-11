import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, statSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { pruneSharpNativePackages, sharpNativePackagesForTarget } from "./sharp-platform-packages.mjs";
import { isCliEntrypoint } from "../../../scripts/lib/cli-entrypoint.mjs";

const require = createRequire(import.meta.url);
// Use the same YAML parser as the pinned updater, without adding a dependency.
const updaterRequire = createRequire(require.resolve("electron-updater"));
const yaml = updaterRequire("js-yaml");
export const MAC_ARCHES = ["universal", "arm64"];
export const NATIVE_RESOURCES = {
  "window-list": "PwrSnapWindowList",
  recorder: "PwrSnapRecorder",
  "pasteboard-writer": "PwrSnapPasteboardWriter",
  "pwrsnap-thumbnail-cli": "PwrSnapThumbnailCli"
};
export const EXTENSIONS = ["PwrSnapThumbnailExtension", "PwrSnapPreviewExtension"];

export function releaseArchitecture(args) {
  const flags = args.filter((arg) => arg.startsWith("--arch"));
  if (flags.length === 0) return "universal";
  if (flags.length !== 1 || !/^--arch=(universal|arm64)$/.test(flags[0])) {
    throw new Error("Expected one --arch=universal|arm64 option");
  }
  return flags[0].split("=")[1];
}
export function stageName(arch) {
  if (!MAC_ARCHES.includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
  return arch === "universal" ? "release-stage" : "release-stage-arm64";
}
export function verifyStageTarget(stage, arch, version) {
  const manifest = JSON.parse(readFileSync(join(stage, "release-target.json"), "utf8"));
  if (manifest.arch !== arch || manifest.version !== version) {
    throw new Error(`Release stage target mismatch: expected ${version}/${arch}`);
  }
}
const digest = (path, algorithm = "sha256") => createHash(algorithm).update(readFileSync(path)).digest(algorithm === "sha512" ? "base64" : "hex");
function arches(path) {
  return execFileSync("lipo", ["-archs", path], { encoding: "utf8" }).trim().split(/\s+/).sort();
}
function thinArm64(path) {
  const found = arches(path);
  if (!found.includes("arm64")) throw new Error(`ARM64 slice missing: ${path}`);
  if (found.length > 1) execFileSync("lipo", [path, "-thin", "arm64", "-output", path]);
  if (arches(path).join() !== "arm64") throw new Error(`Not ARM64-only: ${path}`);
}
export function pruneStagedArm64Sharp(stage) {
  const nodeModulesDir = join(stage, "node_modules");
  pruneSharpNativePackages({ nodeModulesDir, platform: "darwin", arch: "arm64" });
  // pnpm's nested optional-dependency links can rediscover Intel payloads even
  // after pruning top-level @img. Restrict only the deployed Sharp manifest.
  // Atomic replacement breaks pnpm hardlinks rather than editing the workspace.
  const path = join(nodeModulesDir, "sharp/package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const allowed = new Set(sharpNativePackagesForTarget({ platform: "darwin", arch: "arm64" }).map((name) => `@img/${name}`));
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    if (name.startsWith("@img/sharp-") && !allowed.has(name)) delete manifest.optionalDependencies[name];
  }
  writeFileSync(`${path}.arm64-tmp`, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(`${path}.arm64-tmp`, path);
}

export function thinStagedHelpers(stage) {
  for (const name of Object.keys(NATIVE_RESOURCES)) thinArm64(join(stage, "build/native", name));
  for (const name of EXTENSIONS) thinArm64(join(stage, "build/native", `${name}.appex/Contents/MacOS/${name}`));
}
export function thinStagedFfmpeg(stage) {
  const binary = join(stage, "build/ffmpeg/ffmpeg");
  const sources = join(stage, "build/ffmpeg-source");
  const manifests = readdirSync(sources).filter((name) => /^ffmpeg-.*-macos-universal-manifest\.json$/.test(name));
  if (manifests.length !== 1) throw new Error("Expected exactly one verified universal FFmpeg manifest");
  const original = JSON.parse(readFileSync(join(sources, manifests[0]), "utf8"));
  const provenancePath = join(sources, "ffmpeg-macos-arm64-slice.json");
  const before = digest(binary);
  if (existsSync(provenancePath)) {
    const prior = JSON.parse(readFileSync(provenancePath, "utf8"));
    if (prior.sourceSha256 !== original.sha256 || prior.sha256 !== before || arches(binary).join() !== "arm64") {
      throw new Error("Staged ARM64 FFmpeg provenance mismatch");
    }
    return;
  }
  if (original.platform !== "macos" || original.arch !== "universal" || original.sha256 !== before) {
    throw new Error("Universal FFmpeg manifest/hash mismatch before ARM64 extraction");
  }
  thinArm64(binary);
  writeFileSync(provenancePath, JSON.stringify({
    version: original.version, platform: "macos", arch: "arm64",
    transformation: "lipo -thin arm64 (before codesigning)",
    sourceManifest: manifests[0], sourceSha256: before, sha256: digest(binary)
  }, null, 2) + "\n");
}
function regularFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? regularFiles(path) : entry.isFile() ? [path] : [];
  });
}
export function verifyPackagedArchitecture(app, arch) {
  const required = [
    "Contents/MacOS/PwrSnap",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    ...Object.values(NATIVE_RESOURCES).map((name) => `Contents/Resources/${name}`),
    "Contents/Resources/PwrSnapFFmpeg",
    "Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/electron-native/better_sqlite3.node",
    ...EXTENSIONS.map((name) => `Contents/PlugIns/${name}.appex/Contents/MacOS/${name}`)
  ];
  for (const path of required) if (!existsSync(join(app, path))) throw new Error(`Missing packaged runtime: ${path}`);
  for (const target of arch === "universal" ? ["arm64", "x64"] : ["arm64"]) {
    for (const name of [`sharp-darwin-${target}`, `sharp-libvips-darwin-${target}`]) {
      if (!existsSync(join(app, "Contents/Resources/app.asar.unpacked/node_modules/@img", name))) {
        throw new Error(`Missing packaged Sharp runtime: ${name}`);
      }
    }
  }
  const binaries = new Set();
  for (const path of regularFiles(app)) {
    const header = Buffer.alloc(4);
    const fd = openSync(path, "r");
    try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
    const magic = header.toString("hex");
    if (!["cafebabe", "cafebabf", "cffaedfe", "cefaedfe", "feedfacf", "feedface"].includes(magic)) continue;
    const found = arches(path);
    const name = relative(app, path);
    const expected = arch === "arm64" ? ["arm64"]
      : name.includes("/sharp-darwin-arm64/") || name.includes("/sharp-libvips-darwin-arm64/") ? ["arm64"]
      : name.includes("/sharp-darwin-x64/") || name.includes("/sharp-libvips-darwin-x64/") ? ["x86_64"]
      : ["arm64", "x86_64"];
    if (found.join() !== expected.join()) throw new Error(`Wrong architecture for ${name}: ${found}, expected ${expected}`);
    binaries.add(name);
  }
  for (const name of required) if (!binaries.has(name)) throw new Error(`Required runtime is not a Mach-O: ${name}`);
}
export function assembleMacArtifacts(universalDir, arm64Dir, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid release version");
  const inputs = MAC_ARCHES.map((arch, index) => {
    const dir = index === 0 ? universalDir : arm64Dir;
    const info = yaml.load(readFileSync(join(dir, "latest-mac.yml"), "utf8"));
    const zip = `PwrSnap-${version}-${arch}-mac.zip`;
    const dmg = `PwrSnap-${version}-${arch}.dmg`;
    if (info?.version !== version || info.files?.length !== 1 || info.files[0].url !== zip) {
      throw new Error(`Unexpected ${arch} updater metadata`);
    }
    const file = info.files[0];
    for (const name of [zip, `${zip}.blockmap`, dmg]) {
      const path = join(dir, name);
      if (!lstatSync(path).isFile() || statSync(path).size === 0) throw new Error(`Missing release artifact: ${name}`);
    }
    if (file.size !== statSync(join(dir, zip)).size || file.sha512 !== digest(join(dir, zip), "sha512") ||
        info.path !== zip || info.sha512 !== file.sha512) throw new Error(`${arch} ZIP size/hash mismatch`);
    return { arch, dir, zip, dmg, file, info };
  });
  // Validate both complete inputs before touching the shared manifest or aliases.
  for (const input of inputs) {
    if (input.arch === "arm64") {
      for (const name of [input.zip, `${input.zip}.blockmap`, input.dmg]) copyFileSync(join(input.dir, name), join(universalDir, name));
    }
    copyFileSync(join(input.dir, input.dmg), join(universalDir, input.arch === "universal" ? "PwrSnap.dmg" : "PwrSnap-arm64.dmg"));
  }
  const merged = { ...inputs[0].info, files: inputs.map((input) => input.file) };
  writeFileSync(join(universalDir, "latest-mac.yml"), yaml.dump(merged));
  const sizes = inputs.map(({ arch, dir, zip, dmg }) => ({ arch, zipBytes: statSync(join(dir, zip)).size, dmgBytes: statSync(join(dir, dmg)).size }));
  writeFileSync(join(universalDir, "macos-artifact-sizes.json"), JSON.stringify({ version, sizes }, null, 2) + "\n");
  return merged;
}
if (isCliEntrypoint(import.meta.url)) {
  const [universalDir, arm64Dir, version] = process.argv.slice(2);
  if (!universalDir || !arm64Dir || !version) throw new Error("Usage: macos-release-artifacts.mjs <universal-dist> <arm64-dist> <version>");
  assembleMacArtifacts(universalDir, arm64Dir, version);
}
