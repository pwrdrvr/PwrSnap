import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFileSync(new URL(path, new URL("../../../", import.meta.url)), "utf8");
const workspace = JSON.parse(read("package.json")).scripts;
const desktop = JSON.parse(read("apps/desktop/package.json")).scripts;

it("exposes native compilation explicitly and keeps ordinary lifecycle scripts compiler-free", () => {
  expect(workspace["build:native"]).toBe("pnpm --filter @pwrsnap/desktop build:native");
  expect(desktop["build:native"]).toBe("node ./scripts/build-native.mjs");
  for (const scripts of [workspace, desktop]) {
    for (const key of ["preinstall", "install", "postinstall", "predev", "dev", "prebuild", "build", "pretest", "test", "pretest:e2e"])
      expect(scripts[key] ?? "", key).not.toMatch(/build:native|rebuild:electron-native|build-mcp|build-native|cargo|rustup|swiftc|cl\.exe/);
  }
});

// Execute the actual Dev entry point but stop at the GUI process boundary.
// The pre-fix Dev script invokes build-native here and fails this oracle.
// No Electron window, native compiler or download is allowed to run.
it("Dev reaches electron-vite without invoking native setup", () => {
  const dev = fileURLToPath(new URL("./dev.mjs", import.meta.url));
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import cp from "node:child_process";
    import { EventEmitter } from "node:events";
    import { syncBuiltinESMExports } from "node:module";
    import { pathToFileURL } from "node:url";
    const calls = [];
    cp.spawnSync = (command, args) => {
      calls.push({ command, args });
      if (/cargo|rustup|swiftc|cl\\.exe/.test(command) || args.some(arg => /build-native|build-mcp/.test(arg)))
        throw new Error("Dev invoked native compilation");
      return { status: 0, stdout: "", stderr: "" };
    };
    cp.spawn = (command, args) => {
      if (!args[0].endsWith("electron-vite/bin/electron-vite.js") && !args[0].endsWith("electron-vite\\\\bin\\\\electron-vite.js"))
        throw new Error("Unexpected GUI command");
      calls.push({ command, args });
      const child = new EventEmitter(); child.pid = 424242;
      setImmediate(() => child.emit("close", 0));
      return child;
    };
    syncBuiltinESMExports();
    const modulePath = process.argv[1];
    process.argv[1] = "fixture-runner";
    const { main } = await import(pathToFileURL(modulePath).href);
    process.exitCode = await main([], { ...process.env, PWRSNAP_FFMPEG_PATH: "/fixture/ffmpeg" });
    process.stdout.write(JSON.stringify(calls));
  `, dev], { cwd: root, encoding: "utf8" });
  const calls = JSON.parse(output.slice(output.indexOf("[{")));
  expect(calls.at(-1).args.slice(1)).toEqual(["dev"]);
});

it("CI explicitly prepares native helpers before unit and E2E consumers", () => {
  const ci = read(".github/workflows/ci.yml");
  for (const job of ["test", "desktop-e2e", "desktop-e2e-macos", "windows", "windows-e2e"]) {
    const body = ci.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
    expect(body, job).toMatch(/pnpm (?:build:native|rebuild:electron-native|--filter @pwrsnap\/desktop build:native)/);
  }
});
