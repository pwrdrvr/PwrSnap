import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

function prependPath(env, dirs, platform) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: [...dirs, env[key] ?? ""].join(platform === "win32" ? ";" : delimiter) };
}

// Discovery respects checkout overrides and changes only the child environment.
export function resolveRustEnvironment({ cwd, env = process.env, platform = process.platform,
  home = homedir(), run = spawnSync }) {
  const probe = (command, args, childEnv = env) => {
    const result = run(command, args, { cwd, env: childEnv, encoding: "utf8" });
    if (result.error && result.error.code !== "ENOENT") throw result.error;
    return result;
  };
  const available = (result) => !result.error && result.status === 0;
  if (available(probe("cargo", ["--version"]))) return { cargo: "cargo", env };

  const suffix = platform === "win32" ? ".exe" : "";
  const bins = [...new Set([
    ...(env.CARGO_HOME ? [join(env.CARGO_HOME, "bin")] : []),
    join(home, ".cargo", "bin"),
    ...(platform === "darwin" ? ["/opt/homebrew/opt/rustup/bin", "/usr/local/opt/rustup/bin"] : [])
  ])];
  for (const bin of bins) {
    const childEnv = prependPath(env, [bin], platform);
    const cargo = join(bin, `cargo${suffix}`);
    if (available(probe(cargo, ["--version"], childEnv))) return { cargo, env: childEnv };
  }
  for (const rustup of ["rustup", ...bins.map((bin) => join(bin, `rustup${suffix}`))]) {
    const result = probe(rustup, ["which", "cargo"]);
    const cargo = result.stdout?.trim();
    if (!available(result) || !cargo || !isAbsolute(cargo)) continue;
    const dirs = [dirname(cargo), ...(isAbsolute(rustup) ? [dirname(rustup)] : [])];
    const childEnv = prependPath(env, dirs, platform);
    if (available(probe(cargo, ["--version"], childEnv))) return { cargo, rustup, env: childEnv };
  }
  return null;
}
