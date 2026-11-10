import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { inventory, platformPath } from "./electron-runtime-cache.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

it("dev repair oracle: the default repair entry point reuses the common verified cache without launching Electron", async () => {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap dev cache oracle-"));
  try {
    const version = "44.9.3";
    const executable = platformPath(process.platform);
    const payload = join(root, "payload");
    const bytes = randomBytes(1024 * 1024);
    mkdirSync(dirname(join(payload, executable)), { recursive: true });
    writeFileSync(join(payload, executable), bytes, { mode: 0o755 });
    writeFileSync(join(payload, "version"), version);
    writeFileSync(join(payload, "electron.d.ts"), "// disposable fixture types\n");
    const zip = join(root, "runtime.zip");
    if (process.platform === "win32") {
      const quote = (value) => `'${value.replace(/'/g, "''")}'`;
      execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path ${quote(join(payload, "*"))} -DestinationPath ${quote(zip)}`]);
    } else {
      execFileSync("zip", ["-qr", zip, "."], { cwd: payload });
    }
    const checksum = hash(readFileSync(zip));
    const home = join(root, "home");
    const env = {
      ...process.env, PWRAGENT_HOME: home,
      npm_config_platform: process.platform, npm_config_arch: process.arch,
      electron_use_remote_checksums: undefined, npm_config_electron_use_remote_checksums: undefined,
    };
    const requests = join(root, "requests.jsonl");
    const legacy = join(root, "legacy-installer-ran");
    const packages = ["seed", "repair"].map((name) => {
      const project = join(root, name);
      const desktop = join(project, "apps/desktop");
      const scripts = join(desktop, "scripts");
      const electron = join(desktop, "node_modules/electron");
      mkdirSync(scripts, { recursive: true });
      mkdirSync(join(electron, "node_modules/@electron/get"), { recursive: true });
      for (const file of ["dev.mjs", "dev-ffmpeg.mjs", "ensure-electron-runtime.mjs", "electron-runtime-cache.mjs"]) {
        cpSync(join(here, file), join(scripts, file));
      }
      for (const file of ["check-node-version.mjs", "linux-sandbox.mjs", "lib/cli-entrypoint.mjs"]) {
        const destination = join(project, "scripts", file);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(repo, "scripts", file), destination);
      }
      writeFileSync(join(electron, "package.json"), JSON.stringify({ name: "electron", version }));
      writeFileSync(join(electron, "checksums.json"), JSON.stringify({ [`electron-v${version}-${process.platform}-${process.arch}.zip`]: checksum }));
      writeFileSync(join(electron, "node_modules/@electron/get/index.js"), `
exports.downloadArtifact = async (options) => {
  require("node:fs").appendFileSync(${JSON.stringify(requests)}, JSON.stringify(options) + "\\n");
  return ${JSON.stringify(zip)};
};`);
      // This package file is still used by the existing package health check.
      // Executing it is forbidden: the repair must use our sibling installer.
      writeFileSync(join(electron, "install.js"), `require("node:fs").writeFileSync(${JSON.stringify(legacy)}, "ran"); process.exitCode = 73;`);
      return { desktop, scripts, electron };
    });

    execFileSync(process.execPath, [join(packages[0].scripts, "ensure-electron-runtime.mjs")], { env, stdio: "pipe" });
    const identity = { format: 1, version, platform: process.platform, arch: process.arch, checksum };
    const cache = join(home, "cache/electron-runtime/v1");
    const key = hash(JSON.stringify(identity));
    expect(readdirSync(cache)).toEqual([key]);
    const cacheManifest = readFileSync(join(cache, key, "runtime.json"), "utf8");
    expect(JSON.stringify(JSON.parse(cacheManifest).identity)).toBe(JSON.stringify(identity));
    const cachedFiles = await inventory(join(cache, key, "dist"));

    // Importing dev.mjs calls only its repair function. Never call main(),
    // build helpers, launch electron-vite, or execute the fixture binary.
    const runner = join(root, "repair.mjs");
    writeFileSync(runner, `
import { ensureElectronInstalled } from ${JSON.stringify(pathToFileURL(join(packages[1].scripts, "dev.mjs")).href)};
process.exitCode = ensureElectronInstalled(process.env);
`);
    const result = spawnSync(process.execPath, [runner], { env, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("[dev] repairing Electron install: electron path.txt is missing");
    expect(existsSync(legacy)).toBe(false);
    const dist = join(packages[1].electron, "dist");
    const binary = join(dist, executable);
    expect(await inventory(dist)).toEqual(cachedFiles);
    expect(readFileSync(join(packages[1].electron, "path.txt"), "utf8")).toBe(executable);
    expect(readFileSync(join(packages[1].electron, "electron.d.ts"), "utf8")).toBe("// disposable fixture types\n");
    expect(readFileSync(binary)).toEqual(bytes);
    expect(readdirSync(cache)).toEqual([key]);
    expect(readFileSync(join(cache, key, "runtime.json"), "utf8")).toBe(cacheManifest);
    expect(await inventory(join(cache, key, "dist"))).toEqual(cachedFiles);
    expect(lstatSync(binary).ino).not.toBe(lstatSync(join(cache, key, "dist", executable)).ino);
    const downloads = readFileSync(requests, "utf8").trim().split("\n").map(JSON.parse);
    expect(downloads).toHaveLength(2);
    for (const request of downloads) expect(request).toMatchObject({ version, platform: process.platform, arch: process.arch, checksums: { [`electron-v${version}-${process.platform}-${process.arch}.zip`]: checksum } });

    if (process.platform === "darwin") {
      const probe = join(root, "private-size");
      execFileSync("clang", [join(here, "fixtures/apfs-private-size.c"), "-o", probe]);
      const files = [join(cache, key, "dist", executable), join(packages[0].electron, "dist", executable), binary];
      const metadata = () => execFileSync(probe, files, { encoding: "utf8" }).trim().split("\n").map(JSON.parse);
      const entries = metadata();
      expect(new Set(entries.map((entry) => entry.inode)).size).toBe(3);
      expect(entries[0].cloneId).not.toBe("0");
      expect(new Set(entries.map((entry) => entry.cloneId)).size).toBe(1);
      expect(entries.reduce((sum, entry) => sum + entry.privateBytes, 0)).toBe(0);
      writeFileSync(binary, randomBytes(bytes.length));
      expect(readFileSync(files[0])).toEqual(bytes);
      expect(readFileSync(files[1])).toEqual(bytes);
      expect(metadata()[2].privateBytes).toBeGreaterThan(0);
    }

    // A healthy install still returns immediately, even with no ZIP available.
    rmSync(zip);
    const requestLog = readFileSync(requests, "utf8");
    const inode = lstatSync(binary).ino;
    const healthy = spawnSync(process.execPath, [runner], { env, encoding: "utf8" });
    expect(healthy.status, healthy.stderr).toBe(0);
    expect(healthy.stderr).toBe("");
    expect(readFileSync(requests, "utf8")).toBe(requestLog);
    expect(lstatSync(binary).ino).toBe(inode);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
