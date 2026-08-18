import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { isCliEntrypoint } from "../lib/cli-entrypoint.mjs";
import { BUNDLED_FFMPEG_VERSION } from "../generate-third-party-licenses.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("isCliEntrypoint", () => {
  test("matches when the module is the script node was asked to run", () => {
    const scriptPath = join(repoRoot, "scripts", "generate-third-party-licenses.mjs");

    expect(isCliEntrypoint(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
  });

  test("matches a path that needs percent-encoding in its file URL", () => {
    // The bug class this guard exists for. `file://${argvPath}` string-concat
    // produces an unencoded URL that never equals `import.meta.url`, so the
    // guard evaluates false, `runCli()` never runs, and the script exits 0
    // having checked nothing. Both a space and `#` trigger it.
    const scriptPath = join(repoRoot, "some dir #1", "check.mjs");
    const href = pathToFileURL(scriptPath).href;

    expect(isCliEntrypoint(href, scriptPath)).toBe(true);
    // Guard the exact expression that shipped broken.
    expect(href).not.toBe(`file://${scriptPath}`);
  });

  test("does not match a different script", () => {
    const scriptPath = join(repoRoot, "scripts", "a.mjs");
    const otherPath = join(repoRoot, "scripts", "b.mjs");

    expect(isCliEntrypoint(pathToFileURL(scriptPath).href, otherPath)).toBe(false);
  });

  test("tolerates a missing argv[1] (node --eval / REPL)", () => {
    // Must clear process.argv[1] rather than pass `undefined` explicitly:
    // an explicit undefined triggers the default parameter, so argvPath becomes
    // the vitest runner path and the guarded branch never executes.
    const scriptPath = join(repoRoot, "scripts", "a.mjs");
    const original = process.argv[1];
    try {
      process.argv[1] = undefined;
      expect(isCliEntrypoint(pathToFileURL(scriptPath).href)).toBe(false);
    } finally {
      process.argv[1] = original;
    }
  });

  test("matches through a symlinked invocation path", () => {
    // Node realpaths the main module for import.meta.url but leaves
    // process.argv[1] as typed, so a symlinked checkout must still match.
    const root = mkdtempSync(join(tmpdir(), "pwrsnap-cli-entry-"));
    try {
      const realDir = join(root, "real");
      mkdirSync(realDir);
      const scriptPath = join(realDir, "probe.mjs");
      writeFileSync(scriptPath, "// probe\n");
      const linkDir = join(root, "link");
      symlinkSync(realDir, linkDir);

      // import.meta.url side is realpathed by Node; argv side is the symlink.
      expect(isCliEntrypoint(pathToFileURL(scriptPath).href, join(linkDir, "probe.mjs"))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The Windows CI lane silently passed `licenses:check` for months: the guard in
// generate-third-party-licenses.mjs compared `import.meta.url`
// (file:///D:/a/...) against `file://${process.argv[1]}` (file://D:\a\...), so
// runCli() never fired and the script exited 0 without checking anything. A
// check that fails open is worse than no check, so assert the CLIs actually
// speak. This runs the real scripts as subprocesses — the only way to exercise
// the module-level entrypoint guard.
describe("license CLIs report a result when run", () => {
  const cases = [
    {
      script: "scripts/check-package-license-policy.mjs",
      args: [],
      expected: /package license policy check (passed|failed)/,
    },
    {
      script: "scripts/check-dependency-version-policy.mjs",
      args: [],
      expected: /dependency version policy check (passed|failed)/,
    },
    {
      script: "scripts/generate-third-party-licenses.mjs",
      args: ["--check"],
      // Any real verdict is fine, including an environment failure. What must
      // never happen is silence — that means the entrypoint guard did not fire.
      // `pnpm licenses list` working is enforced by `licenses:check` in lint,
      // not here, so tolerate every way a missing/broken pnpm reports itself:
      // POSIX spawn ENOENT, cmd.exe's "is not recognized" under the win32
      // `shell: true` path, and the generator's own resolve/stale diagnostics.
      expected:
        /third-party license notice check passed|THIRD_PARTY_LICENSES is out of date|not installed on disk|pnpm licenses list|spawnSync|is not recognized|Cannot resolve|ERR_PNPM/,
    },
  ];

  for (const { script, args, expected } of cases) {
    test(`${script} ${args.join(" ")} produces a verdict`, () => {
      const result = spawnSync(process.execPath, [join(repoRoot, script), ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        // spawnSync blocks the worker's event loop, so vitest's own timeout
        // cannot preempt it — a pnpm store-lock stall would hang the job.
        timeout: 120_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

      expect(output).not.toBe("");
      expect(output).toMatch(expected);
      // A pass must be a real pass, not an unfired entrypoint guard.
      if (result.status === 0) {
        expect(output).toMatch(/passed/);
      }
    });
  }

  test("scripts/check-bundled-ffmpeg-notice.mjs produces a verdict", () => {
    // This one runs inside the protected signing jobs, where silence means the
    // release ships unverified, so it gets the same spawn coverage as the rest.
    //
    // It originally hand-rolled `argv[1].endsWith(<filename>)` to avoid
    // importing scripts/lib, on the theory that the Windows signing tarball has
    // no scripts/lib in it. That was both weaker (case-sensitive, while Windows
    // paths are not; blind to symlink and wrapper invocations) and unnecessary:
    // the tarball must carry cli-entrypoint.mjs regardless, because
    // verify-asar-contents.mjs imports it.
    const root = mkdtempSync(join(tmpdir(), "pwrsnap-ffmpeg-cli-"));
    try {
      const manifestPath = join(root, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify({ version: BUNDLED_FFMPEG_VERSION }));

      const result = spawnSync(
        process.execPath,
        [
          join(repoRoot, "scripts/check-bundled-ffmpeg-notice.mjs"),
          "--manifest",
          manifestPath,
          "--notice",
          join(repoRoot, "THIRD_PARTY_LICENSES"),
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

      expect(output).not.toBe("");
      expect(output).toMatch(/bundled FFmpeg notice check (passed|failed)/);
      if (result.status === 0) {
        expect(output).toMatch(/passed/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
