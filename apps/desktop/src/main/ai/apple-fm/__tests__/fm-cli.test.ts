// The transport rules for Apple's fm tool, pinned at the spawn site.
//
// These are the controls that keep the on-device model inside the
// enrichment contract: no tool, no second destination, no carried state,
// nothing agreed to or reconfigured on the user's behalf.

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { buildAppleFmEnrichmentArgs } from "../enrichment";
import {
  APPLE_FM_BINARY,
  APPLE_FM_FORBIDDEN_FLAGS,
  APPLE_FM_MAX_OUTPUT_BYTES,
  AppleFmArgsError,
  AppleFmOutputLimitError,
  AppleFmTimeoutError,
  appleFmEnv,
  assertAppleFmArgs,
  createFmRunner,
  stripAnsi
} from "../fm-cli";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((task) => task()));
});

describe("argv rules", () => {
  test("the binary is a fixed absolute path on the system volume", () => {
    expect(APPLE_FM_BINARY).toBe("/usr/bin/fm");
  });

  test("only the four commands PwrSnap uses are allowed", () => {
    for (const command of ["chat", "serve", "schema", "count-tokens", "quota-usage", "", "--help"]) {
      expect(() => assertAppleFmArgs([command])).toThrow(AppleFmArgsError);
    }
    expect(() => assertAppleFmArgs([])).toThrow(AppleFmArgsError);
    expect(() => assertAppleFmArgs(["models"])).not.toThrow();
  });

  test("the licence can be read but never agreed to", () => {
    expect(() => assertAppleFmArgs(["license", "--status"])).not.toThrow();
    // `fm license` alone PROMPTS for agreement.
    expect(() => assertAppleFmArgs(["license"])).toThrow(AppleFmArgsError);
    expect(() => assertAppleFmArgs(["license", "--show"])).toThrow(AppleFmArgsError);
    expect(() => assertAppleFmArgs(["license", "--status", "--yes"])).toThrow(AppleFmArgsError);
  });

  test("the configuration can be read but never written", () => {
    expect(() => assertAppleFmArgs(["config", "get", "default-model-provider"])).not.toThrow();
    for (const verb of ["set", "add", "remove", "list", "path"]) {
      expect(() => assertAppleFmArgs(["config", verb, "x"])).toThrow(AppleFmArgsError);
    }
  });

  test("respond must name the on-device model, exactly once", () => {
    expect(() => assertAppleFmArgs(["respond", "--model", "system"])).not.toThrow();
    expect(() => assertAppleFmArgs(["respond"])).toThrow(AppleFmArgsError);
    // Apple's cloud model leaves the Mac.
    expect(() => assertAppleFmArgs(["respond", "--model", "pcc"])).toThrow(AppleFmArgsError);
    expect(() => assertAppleFmArgs(["respond", "--model", "system", "--model", "pcc"])).toThrow(
      AppleFmArgsError
    );
  });

  test("property: no argv carrying a forbidden flag is ever accepted", () => {
    const flag = fc.constantFrom(...APPLE_FM_FORBIDDEN_FLAGS);
    const filler = fc.array(fc.constantFrom("--no-stream", "--greedy", "/tmp/a.png", "--image", "x"), {
      maxLength: 6
    });
    fc.assert(
      fc.property(flag, filler, filler, fc.boolean(), (bad, before, after, inline) => {
        const args = [
          "respond",
          "--model",
          "system",
          ...before,
          ...(inline ? [`${bad}=value`] : [bad, "value"]),
          ...after
        ];
        expect(() => assertAppleFmArgs(args)).toThrow(AppleFmArgsError);
      })
    );
  });
});

describe("the enrichment argv", () => {
  const absolutePath = fc
    .array(fc.stringMatching(/^[A-Za-z0-9 ._-]{1,12}$/), { minLength: 1, maxLength: 4 })
    .map((parts) => `/${parts.join("/")}`);

  test("property: it always passes the spawn-site rules and gives the model nothing extra", () => {
    fc.assert(
      fc.property(
        absolutePath,
        fc.array(absolutePath, { minLength: 1, maxLength: 5 }),
        fc.string({ maxLength: 400 }),
        (schemaPath, imagePaths, instructions) => {
          // Instructions are app-owned text, but the rule must hold for any.
          fc.pre(!APPLE_FM_FORBIDDEN_FLAGS.some((f) => instructions === f || instructions.startsWith(`${f}=`)));
          const args = buildAppleFmEnrichmentArgs({ schemaPath, imagePaths, instructions });
          expect(() => assertAppleFmArgs(args)).not.toThrow();
          expect(args[0]).toBe("respond");
          expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
            "--model",
            "system"
          ]);
          expect(args).toContain("--no-stream");
          // One --image per prepared file, each an absolute path.
          const images = args.flatMap((arg, i) => (arg === "--image" ? [args[i + 1]] : []));
          expect(images).toEqual(imagePaths);
          // The prompt is not in argv at all: it travels on stdin.
          expect(args.filter((arg) => !arg.startsWith("-") && !arg.startsWith("/"))).toEqual([
            "respond",
            "system",
            ...(instructions.startsWith("-") || instructions.startsWith("/") ? [] : [instructions])
          ]);
        }
      )
    );
  });

  test("a relative path is refused rather than passed where it could read as a flag", () => {
    const base = { schemaPath: "/jail/schema.json", instructions: "i", imagePaths: ["/jail/a.jpg"] };
    expect(() => buildAppleFmEnrichmentArgs({ ...base, imagePaths: ["--tool"] })).toThrow();
    expect(() => buildAppleFmEnrichmentArgs({ ...base, imagePaths: ["a.jpg"] })).toThrow();
    expect(() => buildAppleFmEnrichmentArgs({ ...base, schemaPath: "schema.json" })).toThrow();
    expect(() => buildAppleFmEnrichmentArgs({ ...base, imagePaths: [] })).toThrow();
  });
});

describe("child environment", () => {
  test("nothing of the app's environment is inherited beyond identity and locale", () => {
    const env = appleFmEnv({
      HOME: "/Users/fixture",
      USER: "fixture",
      LANG: "en_US.UTF-8",
      PATH: "/opt/evil/bin:/usr/bin",
      HTTPS_PROXY: "http://proxy.example:8080",
      OPENAI_API_KEY: "fixture-not-a-key",
      NODE_OPTIONS: "--require /tmp/x.js"
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      NO_COLOR: "1",
      TERM: "dumb",
      HOME: "/Users/fixture",
      USER: "fixture",
      LANG: "en_US.UTF-8"
    });
  });
});

test("stripAnsi removes the colour fm adds to errors even under NO_COLOR", () => {
  expect(stripAnsi("Error: \u001b[38;2;255;107;128mThe model's safety guardrails were triggered.\u001b[0m")).toBe(
    "Error: The model's safety guardrails were triggered."
  );
});

// A shell script stands in for the tool. POSIX only; the tool is macOS-only.
describe.skipIf(process.platform === "win32")("running the tool", () => {
  async function fakeFm(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-fm-test-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "fm");
    await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
    await chmod(path, 0o755);
    return path;
  }

  test("a non-zero exit is an answer, not an error", async () => {
    const run = createFmRunner(await fakeFm('echo "  ✓ system (AFM 3 Core)"; echo oops >&2; exit 1'));
    await expect(run(["models"], { timeoutMs: 5_000 })).resolves.toEqual({
      code: 1,
      signal: null,
      stdout: "  ✓ system (AFM 3 Core)\n",
      stderr: "oops\n"
    });
  });

  test("stdin reaches the tool and is closed, and argv is passed without a shell", async () => {
    const run = createFmRunner(await fakeFm('printf "%s|" "$@"; cat'));
    const result = await run(["respond", "--model", "system", "--instructions", "a b; echo $HOME `id`"], {
      stdin: "Capture metadata:\n- kind: image",
      timeoutMs: 5_000
    });
    expect(result.stdout).toBe(
      "respond|--model|system|--instructions|a b; echo $HOME `id`|Capture metadata:\n- kind: image"
    );
  });

  test("the child sees only the minimal environment", async () => {
    const run = createFmRunner(await fakeFm('echo "$PATH|$NO_COLOR|${PWRSNAP_FIXTURE_SECRET:-unset}"'));
    process.env.PWRSNAP_FIXTURE_SECRET = "leaked";
    try {
      const result = await run(["models"], { timeoutMs: 5_000 });
      expect(result.stdout.trim()).toBe("/usr/bin:/bin|1|unset");
    } finally {
      delete process.env.PWRSNAP_FIXTURE_SECRET;
    }
  });

  test("a run past its deadline is killed and reported as a timeout", async () => {
    const run = createFmRunner(await fakeFm("sleep 30"));
    await expect(run(["models"], { timeoutMs: 150 })).rejects.toBeInstanceOf(AppleFmTimeoutError);
  });

  test("an abort kills the run", async () => {
    const run = createFmRunner(await fakeFm("sleep 30"));
    const controller = new AbortController();
    const pending = run(["models"], { timeoutMs: 20_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("an already-aborted signal never spawns", async () => {
    const run = createFmRunner("/nonexistent/fm");
    const controller = new AbortController();
    controller.abort();
    await expect(run(["models"], { timeoutMs: 1_000, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError"
    });
  });

  test("output past the bound stops the run instead of filling memory", async () => {
    const run = createFmRunner(await fakeFm("yes fixture-output-line"));
    await expect(run(["models"], { timeoutMs: 20_000 })).rejects.toBeInstanceOf(AppleFmOutputLimitError);
    expect(APPLE_FM_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });

  test("the argv rules are enforced before anything is spawned", async () => {
    const run = createFmRunner(await fakeFm("echo ran"));
    expect(() => run(["respond", "--model", "system", "--tool", "ocr"], { timeoutMs: 1_000 })).toThrow(
      AppleFmArgsError
    );
  });

  test("a missing tool rejects with ENOENT", async () => {
    const run = createFmRunner("/nonexistent/pwrsnap-fixture/fm");
    await expect(run(["models"], { timeoutMs: 1_000 })).rejects.toMatchObject({ code: "ENOENT" });
  });
});
