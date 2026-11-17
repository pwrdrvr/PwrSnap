import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";

const buildNative = fileURLToPath(new URL("./build-native.mjs", import.meta.url));

// Execute the real entry point, stopping at its MCP subprocess boundary so
// this oracle never installs targets or runs platform compilers.
function mcpBuildArgs(universal) {
  const env = { ...process.env };
  delete env.PWRSNAP_NATIVE_UNIVERSAL;
  if (universal !== undefined) env.PWRSNAP_NATIVE_UNIVERSAL = universal;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { pathToFileURL } from "node:url";
    childProcess.execFileSync = (command, args) => {
      process.stdout.write(JSON.stringify(args));
      process.exit(0);
    };
    syncBuiltinESMExports();
    await import(pathToFileURL(process.argv[1]).href);
  `, buildNative], { env, encoding: "utf8" }));
}

it("native setup builds for the host unless universal staging is explicitly requested", () => {
  // Model: only the release opt-in may request cross compilation. Exercise
  // absent, enabled, misleading truthy values and generated environment text.
  const assertMode = (universal) => {
    const args = mcpBuildArgs(universal);
    expect(args[0]).toMatch(/[/\\]build-mcp\.mjs$/);
    expect(args.slice(1)).toEqual(universal === "1" ? [] : ["--host"]);
  };
  for (const mode of [undefined, "", "0", "1", "true"]) assertMode(mode);
  fc.assert(fc.property(fc.string({ maxLength: 12 }), assertMode), { numRuns: 25 });
});
