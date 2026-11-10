import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronRequire = createRequire(require.resolve("electron/package.json"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const postinstall = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).scripts.postinstall;

it("all Codex setup paths reach the shared installer before native builds and sandbox checks", () => {
  const environment = readFileSync(join(here, "../../../.codex/environments/environment.toml"), "utf8");
  const setup = environment.match(/\[setup(?:\.win32)?\]\s*script = '''([\s\S]*?)'''/g);
  expect(setup).toHaveLength(2);
  for (const script of setup) {
    expect(script).toMatch(/pnpm(?:\.cmd)? install/);
    expect(script).not.toMatch(/--ignore-scripts|--ignore-dep-scripts|ELECTRON_SKIP_BINARY_DOWNLOAD/);
  }
  expect(postinstall).toBe("node ./scripts/ensure-electron-runtime.mjs && pnpm run rebuild:electron-native && node ../../scripts/linux-sandbox.mjs --warn");
});

// Select the install command from the real lifecycle hook. This same oracle
// runs against the original install-electron command before the port exists.
it.skipIf(process.platform !== "darwin")("lifecycle APFS oracle: independent installs share extents and isolate writes", () => {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-lifecycle-oracle-"));
  try {
    const version = electronRequire("./package.json").version;
    const payload = join(root, "payload");
    const executable = "Electron.app/Contents/MacOS/Electron";
    mkdirSync(dirname(join(payload, executable)), { recursive: true });
    const bytes = randomBytes(1024 * 1024);
    writeFileSync(join(payload, executable), bytes, { mode: 0o755 });
    writeFileSync(join(payload, "version"), version);
    const zip = join(root, "runtime.zip");
    execFileSync("zip", ["-qr", zip, "."], { cwd: payload });
    const probe = join(root, "private-size");
    execFileSync("clang", [join(here, "fixtures/apfs-private-size.c"), "-o", probe]);
    const binaries = ["one", "two"].map((name) => {
      const desktop = join(root, name, "apps/desktop");
      const electron = join(desktop, "node_modules/electron");
      mkdirSync(join(electron, "node_modules/@electron/get"), { recursive: true });
      writeFileSync(join(electron, "package.json"), JSON.stringify({ name: "electron", version }));
      writeFileSync(join(electron, "checksums.json"), JSON.stringify({ [`electron-v${version}-darwin-arm64.zip`]: hash(readFileSync(zip)) }));
      writeFileSync(join(electron, "node_modules/@electron/get/index.js"), `exports.downloadArtifact = async () => ${JSON.stringify(zip)};`);
      const legacy = postinstall.startsWith("install-electron &&");
      let script;
      if (legacy) {
        script = join(electron, "install.js");
        cpSync(electronRequire.resolve("./install.js"), script);
        const extractor = join(electron, "node_modules/@electron-internal/extract-zip");
        mkdirSync(extractor, { recursive: true });
        writeFileSync(join(extractor, "index.js"), `module.exports = require(${JSON.stringify(electronRequire.resolve("@electron-internal/extract-zip"))});`);
      } else {
        const scripts = join(desktop, "scripts");
        mkdirSync(scripts);
        for (const file of ["ensure-electron-runtime.mjs", "electron-runtime-cache.mjs"]) cpSync(join(here, file), join(scripts, file));
        script = join(scripts, "ensure-electron-runtime.mjs");
      }
      execFileSync(process.execPath, [script], {
        env: { ...process.env, PWRAGENT_HOME: join(root, "shared-home"), npm_config_platform: "darwin", npm_config_arch: "arm64" },
        stdio: "pipe",
      });
      return join(electron, "dist", executable);
    });
    const metadata = () => execFileSync(probe, binaries, { encoding: "utf8" }).trim().split("\n").map(JSON.parse);
    const [a, b] = metadata();
    expect(hash(readFileSync(binaries[0]))).toBe(hash(bytes));
    expect(hash(readFileSync(binaries[1]))).toBe(hash(bytes));
    expect(a.inode).not.toBe(b.inode);
    expect(a.cloneId).not.toBe("0");
    expect(a.cloneId).toBe(b.cloneId);
    expect(a.privateBytes + b.privateBytes).toBe(0);
    writeFileSync(binaries[1], randomBytes(bytes.length));
    expect(hash(readFileSync(binaries[0]))).toBe(hash(bytes));
    expect(metadata()[1].privateBytes).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
