import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const workflow = (file) => readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");

function job(source, name) {
  const jobs = [...source.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)];
  const match = jobs.find(([, jobName]) => jobName === name);
  expect(match, name).toBeDefined();
  return match[2];
}

test("a queued preview selects the same immutable event revision for compiling and packaging", () => {
  const preview = workflow("preview-build.yml");
  const compile = job(preview, "apple-caption").match(/^\s+ref: (.*)$/m)?.[1];
  const checkout = job(preview, "preview").match(/uses: actions\/checkout[^\n]*\n\s+with:\n\s+ref: (.*)$/m)?.[1];
  expect(checkout).toBe("${{ github.sha }}");
  expect(compile).toBe(checkout);
});

describe("manual release retries", () => {
  const release = workflow("release.yml");

  test("all jobs use the resolved revision and only tags with the helper require a successful build", () => {
    const source = job(release, "release-source");
    const compile = job(release, "apple-caption");
    const prepare = job(release, "prepare");
    const resolvedRef = "ref: ${{ needs.release-source.outputs.commit }}";
    expect(source).toContain("format('refs/tags/{0}', inputs.tag)");
    expect(compile).toContain(resolvedRef);
    expect(prepare).toContain(resolvedRef);
    expect(compile).toContain("if: needs.release-source.outputs.has-apple-caption == 'true'");
    expect(prepare).toContain("!cancelled()");
    expect(prepare).toContain("needs.release-source.result == 'success'");
    expect(prepare).toContain("needs.distribution-audit.result == 'success'");
    expect(prepare).toMatch(/has-apple-caption == 'true' && needs\.apple-caption\.result == 'success'/);
    expect(prepare).toMatch(/has-apple-caption == 'false' && needs\.apple-caption\.result == 'skipped'/);
    expect(prepare).toMatch(/name: Stage Apple captions helper\n\s+if: needs\.release-source\.outputs\.has-apple-caption == 'true'/);
  });

  test.skipIf(process.platform === "win32")("the release source probe reads the checked-out tag's actual tree", () => {
    const source = job(release, "release-source");
    const script = source.match(/^        run: \|\n((?:^          .*\n)+)/m)?.[1];
    expect(script).toBeDefined();

    const cwd = mkdtempSync(join(tmpdir(), "pwrsnap-release-source-"));
    const git = (...args) => execFileSync("git", [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args
    ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init");
      git("commit", "--allow-empty", "-m", "Before Apple captions");
      git("tag", "v1.0.0");
      mkdirSync(join(cwd, "apps/desktop/native/apple-caption"), { recursive: true });
      writeFileSync(join(cwd, "apps/desktop/native/apple-caption/main.swift"), "// fixture\n");
      git("add", "apps");
      git("commit", "-m", "Add Apple captions");
      git("tag", "-a", "v1.1.0", "-m", "Apple captions");

      const output = join(cwd, "output");
      for (const [tag, hasHelper] of [["v1.0.0", "false"], ["v1.1.0", "true"]]) {
        git("checkout", "--detach", `refs/tags/${tag}`);
        writeFileSync(output, "");
        execFileSync("bash", ["-c", script], { cwd, env: { ...process.env, GITHUB_OUTPUT: output } });
        expect(readFileSync(output, "utf8").trim().split("\n").sort()).toEqual([
          `commit=${git("rev-parse", `refs/tags/${tag}^{commit}`)}`, `has-apple-caption=${hasHelper}`
        ]);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
