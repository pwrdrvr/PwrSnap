import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveBenchmarkCodexHome } from "./still-sizing/benchmark-profile";

test("uses an independently signed-in home in place and rejects an active home or shared auth file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pwrsnap-sizing-profile-"));
  try {
    const active = join(root, "active");
    const alias = join(root, "active-alias");
    const nested = join(active, "named-profile");
    const benchmark = join(root, "benchmark");
    await mkdir(nested, { recursive: true });
    await mkdir(benchmark);
    await symlink(active, alias, "junction");
    for (const home of [active, alias, nested]) {
      await expect(resolveBenchmarkCodexHome(home, [active])).rejects.toThrow("separate Codex home");
    }
    await expect(resolveBenchmarkCodexHome(benchmark, [active])).rejects.toThrow("Sign in directly");

    const auth = join(benchmark, "auth.json");
    const activeAuth = join(active, "auth.json");
    await writeFile(activeAuth, "{}");
    await link(activeAuth, auth);
    await expect(resolveBenchmarkCodexHome(benchmark, [active])).rejects.toThrow("own auth.json");
    await rm(auth);
    await writeFile(auth, "{}");
    await expect(resolveBenchmarkCodexHome(benchmark, [active])).resolves.toBe(await realpath(benchmark));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
