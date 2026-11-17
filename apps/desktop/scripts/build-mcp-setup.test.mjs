import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const buildMcp = fileURLToPath(new URL("./build-mcp.mjs", import.meta.url));

// Exercise the CLI with a controlled compiler boundary; never run Rust or
// install targets. Any attempt to copy/stage a helper after failure will fail.
function build({ args = ["--host", "--allow-missing-cargo"], code = "ENOENT", ci, universal } = {}) {
  const env = { ...process.env };
  delete env.CI;
  delete env.PWRSNAP_NATIVE_UNIVERSAL;
  if (ci !== undefined) env.CI = ci;
  if (universal !== undefined) env.PWRSNAP_NATIVE_UNIVERSAL = universal;
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { pathToFileURL } from "node:url";
    childProcess.spawnSync = (command) => {
      if (command === "rustup") return { status: 0 };
      if (command !== "cargo") throw new Error("Unexpected subprocess: " + command);
      return ${code === null ? '{ status: 1 }' : `{ error: Object.assign(new Error("cargo unavailable"), { code: ${JSON.stringify(code)} }) }`};
    };
    syncBuiltinESMExports();
    await import(pathToFileURL(process.argv[1]).href);
  `, buildMcp, ...args], { env, encoding: "utf8" });
}

it("warns and completes local native setup when Cargo is missing", () => {
  const result = build();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("WARNING: cargo was not found on PATH");
  expect(result.stderr).toContain("MCP transport requires a built helper");
  expect(result.stderr).toContain("build:mcp --host");
});

it.each([
  { args: ["--host"] },
  { args: [] },
  { args: ["--allow-missing-cargo"] },
  { ci: "true" },
  { universal: "1" },
  { code: "EACCES" },
  { code: null }
])("keeps explicit builds, CI, releases and real build failures strict: %j", (options) => {
  const result = build(options);
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toContain("WARNING: cargo was not found on PATH");
  expect(result.stderr).toMatch(/cargo unavailable|cargo failed/);
});
