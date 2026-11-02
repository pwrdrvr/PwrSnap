import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dirname, "../..");
const source = readFileSync(join(root, "apps/desktop/scripts/release.mjs"), "utf8");
const directories = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test.each(["set-keychain-settings", "import", "set-key-partition-list"])(
  "a failed %s still has a registered keychain exit cleanup", (failure) => {
    const commands = [];
    const listeners = {};
    const context = {
      process: { platform: "darwin", pid: 123, env: { CSC_LINK: "/fixture/cert.p12", CSC_KEY_PASSWORD: "fixture" },
        once: (event, handler) => { listeners[event] = handler; } },
      join, tmpdir: () => "/fixture/temp", cscLinkFilePath: () => "/fixture/cert.p12",
      parseSecurityKeychains: () => ["/fixture/login.keychain-db"],
      runQuiet: (_file, args) => { commands.push(args); if (args[0] === failure) throw new Error("fixture setup failure"); return ""; },
      restoreCodesignKeychains: (original, keychain) => { commands.push(["cleanup", original, keychain]); },
      console, Date
    };
    const start = source.indexOf("function maybePrepareCodesignKeychain()");
    const end = source.indexOf("\nif (!signStageOnly)", start);
    runInNewContext(`let codesignKeychainCleanup = null; ${source.slice(start, end)}; this.prepare = maybePrepareCodesignKeychain;`, context);
    expect(() => context.prepare()).toThrow("fixture setup failure");
    expect(listeners.exit).toBeTypeOf("function");
    listeners.exit();
    expect(commands.at(-1)[0]).toBe("cleanup");
    expect(commands.at(-1)[1]).toEqual(["/fixture/login.keychain-db"]);
    expect(commands.at(-1)[2]).toMatch(/pwrsnap-codesign-123-.*\.keychain-db$/);
  }
);

describe.skipIf(process.platform === "win32")("workflow signing credential cleanup", () => {
  function fixture() {
    const temporary = mkdtempSync(join(tmpdir(), "pwrsnap-cleanup-test-"));
    directories.push(temporary);
    const signing = join(temporary, "pwrsnap-signing.fixture");
    mkdirSync(signing);
    const bin = join(temporary, "bin");
    mkdirSync(bin);
    const log = join(temporary, "security.jsonl");
    writeFileSync(join(bin, "security"), `#!/usr/bin/env python3\nimport os,sys,json\nwith open(os.environ["SECURITY_LOG"],"a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\nsys.exit(int(os.environ.get("SECURITY_FAIL","0")))\n`, { mode: 0o755 });
    writeFileSync(join(signing, "keychains-before.txt"), '    "/fixture/login with spaces.keychain-db"\n');
    writeFileSync(join(signing, "AuthKey_fixture.p8"), "fixture key");
    writeFileSync(join(signing, "fixture.p12"), "fixture certificate");
    writeFileSync(join(signing, "pwrsnap-codesign-fixture.keychain-db"), "fixture keychain");
    const unrelated = join(temporary, "unrelated.p8");
    writeFileSync(unrelated, "preserve");
    const run = (path = signing, extra = {}) => spawnSync("python3", [join(root, "scripts/release/cleanup-macos-signing.py"), path], {
      encoding: "utf8", env: { ...process.env, RUNNER_TEMP: temporary, PATH: `${bin}:${process.env.PATH}`, SECURITY_LOG: log, ...extra }
    });
    return { temporary, signing, log, unrelated, run };
  }

  test("restores the original search list and deletes only this job's credentials", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    expect(readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse)).toEqual([
      ["list-keychains", "-d", "user", "-s", "/fixture/login with spaces.keychain-db"],
      ["delete-keychain", join(f.signing, "pwrsnap-codesign-fixture.keychain-db")]
    ]);
    expect(existsSync(f.signing)).toBe(false);
    expect(existsSync(f.unrelated)).toBe(true);
  });

  test("removes credential files and fails the job when keychain cleanup fails", () => {
    const f = fixture();
    expect(f.run(f.signing, { SECURITY_FAIL: "1" }).status).not.toBe(0);
    expect(existsSync(f.signing)).toBe(false);
    expect(existsSync(f.unrelated)).toBe(true);
  });

  test("refuses an unrelated root and a symlink to another job", () => {
    const f = fixture();
    expect(f.run(f.temporary).status).not.toBe(0);
    const link = join(f.temporary, "pwrsnap-signing.link");
    symlinkSync(f.signing, link);
    expect(f.run(link).status).not.toBe(0);
    expect(existsSync(f.signing)).toBe(true);
  });
});
