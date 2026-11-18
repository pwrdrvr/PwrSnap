import { test } from "vitest";
import assert from "node:assert/strict";
import { createSlice, aggregateSlices, expectedSlices } from "./flake-report.mjs";

const unit = (tests, complete = true) => ({ complete, reason: "failed", unhandledErrors: 0, completion: { reportedTests: tests.length }, suites: [{ project: "desktop-main", file: "/repo/a.test.ts", errors: 0, tests }] });
const item = (id, state) => ({ id, name: `suite > ${id}`, state, completed: true });

test("each initially failed unit test has its own retry outcome regardless of report order", () => {
  const initial = unit([item("a", "failed"), item("b", "failed"), item("c", "passed")]);
  for (const reports of [[unit([item("b", "failed"), item("a", "passed")])], [unit([item("a", "passed")]), unit([item("b", "failed")])]]) {
    const slice = createSlice({ kind: "unit", platform: "linux", lane: 1, sample: 1, workspace: "/repo", first: initial, retries: reports });
    assert.deepEqual(slice.failures.map(({ id, retry }) => [id, retry]), [["a", "recovered"], ["b", "failed"]]);
    assert.equal(slice.failures[0].file, "a.test.ts");
  }
});

test("missing, skipped, interrupted, and ambiguous retry results cannot count as recovered", () => {
  const first = unit([item("a", "failed"), item("b", "failed"), item("c", "failed"), item("d", "failed")], false);
  const retry = unit([item("a", "skipped"), { ...item("b", "passed"), completed: false }, item("c", "passed"), item("c", "failed")]);
  const slice = createSlice({ kind: "unit", platform: "windows-main", lane: 1, sample: 1, first, retries: [retry] });
  assert.equal(slice.first.complete, false);
  assert.deepEqual(slice.failures.map(({ retry }) => retry), ["unknown", "unknown", "unknown", "unknown"]);
});

test("E2E identifies first unexpected outcomes and matches retry results by ID", () => {
  const first = { status: "failed", complete: true, errors: 0, tests: [{ id: "x", name: "one", outcome: "unexpected", completed: true }, { id: "y", name: "two", outcome: "unexpected", completed: true }] };
  const retry = { status: "failed", complete: true, errors: 0, tests: [{ id: "y", outcome: "unexpected", completed: true }, { id: "x", outcome: "expected", completed: true }] };
  const slice = createSlice({ kind: "e2e", platform: "macos", lane: 2, sample: 1, first, retries: [retry] });
  assert.deepEqual(slice.failures.map(({ retry }) => retry), ["recovered", "failed"]);
});

test("aggregation preserves missing slices, attempts, and distinct diagnostic samples", () => {
  const expected = expectedSlices();
  assert.equal(expected.length, 6);
  const slice = createSlice({ kind: "e2e", platform: "windows", lane: 1, sample: 1, first: null, retries: [] });
  const report = aggregateSlices({ slices: [slice], samples: 3, runId: "123", attempt: "2" });
  assert.equal(report.slices.length, 1);
  assert.equal(report.missingSlices.length, 5);
  assert.equal(report.slices.find((s) => s.key === slice.key).first.available, false);
  assert.equal(report.attempt, 2);
  assert.throws(() => aggregateSlices({ slices: [slice, slice], samples: 3 }), /duplicate/i);
});

test("the CLI produces a consolidated report including incomplete and absent slices", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const cwd = mkdtempSync(join(tmpdir(), "flake-report-test-"));
  const script = resolve("scripts/ci/write-flake-report.mjs");
  try {
    mkdirSync(join(cwd, ".local/ci/retry"), { recursive: true });
    writeFileSync(join(cwd, ".local/ci/retry/unit-first.json"), JSON.stringify(unit([item("a", "failed")], false)));
    const env = { ...process.env, FLAKE_KIND: "unit", FLAKE_PLATFORM: "linux", FLAKE_LANE: "1", FLAKE_SAMPLE: "1", GITHUB_WORKSPACE: "/repo" };
    const slice = spawnSync(process.execPath, [script, "slice"], { cwd, env, encoding: "utf8" });
    assert.equal(slice.status, 0, slice.stderr);
    const downloads = join(cwd, ".local/ci/flake-slices");
    const namedArtifact = join(downloads, "flake-slice-1-unit-linux-lane-1-sample-1");
    for (const artifact of [downloads, namedArtifact]) {
      rmSync(downloads, { recursive: true, force: true });
      mkdirSync(artifact, { recursive: true });
      writeFileSync(join(artifact, "flake-slice.json"), readFileSync(join(cwd, ".local/ci/flake-slice.json")));
      const aggregate = spawnSync(process.execPath, [script, "aggregate"], { cwd, env: { ...env, FLAKE_SAMPLES: "1", GITHUB_RUN_ATTEMPT: "1" }, encoding: "utf8" });
      assert.equal(aggregate.status, 1, aggregate.stderr);
      const result = JSON.parse(readFileSync(join(cwd, ".local/ci/flake-report/flake-report.json")));
      assert.equal(result.expectedSlices, 6);
      assert.equal(result.missingSlices.length, 5);
      assert.equal(result.slices[0].first.complete, false);
      assert.equal(result.slices[0].failures[0].retry, "unknown");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the job summary counts every unavailable or incomplete first report even when all slices arrived", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const cwd = mkdtempSync(join(tmpdir(), "flake-summary-test-"));
  const script = resolve("scripts/ci/write-flake-report.mjs");
  try {
    const expected = expectedSlices();
    const summary = join(cwd, "summary.md");
    for (const incomplete of [1, 2, 3, 0]) {
      const downloads = join(cwd, ".local/ci/flake-slices");
      rmSync(downloads, { recursive: true, force: true });
      for (const [index, dimension] of expected.entries()) {
        const first = index >= incomplete ? (dimension.kind === "unit"
          ? unit([item("passing", "passed")])
          : { status: "passed", complete: true, errors: 0, tests: [{ id: "passing", name: "passing", outcome: "expected", completed: true }] })
          : index % 2 === 0 ? null : (dimension.kind === "unit" ? unit([], false) : { status: "interrupted", complete: false, errors: 0, tests: [] });
        const slice = createSlice({ ...dimension, first, retries: [] });
        const artifact = join(downloads, slice.key);
        mkdirSync(artifact, { recursive: true });
        writeFileSync(join(artifact, "flake-slice.json"), JSON.stringify(slice));
      }
      writeFileSync(summary, "");
      const result = spawnSync(process.execPath, [script, "aggregate"], { cwd, encoding: "utf8", env: { ...process.env, FLAKE_SAMPLES: "1", GITHUB_RUN_ATTEMPT: "1", GITHUB_STEP_SUMMARY: summary } });
      assert.equal(result.status, incomplete ? 1 : 0, result.stderr);
      const content = readFileSync(summary, "utf8");
      assert.match(content, /Slices received: 6\/6; missing: 0/);
      assert.match(content, new RegExp(`First reports unavailable or incomplete: ${incomplete}\\.`));
      if (incomplete > 0) assert.match(content, /failure counts may be incomplete/i);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the expected slices cover each CI test selection", () => {
  const expected = expectedSlices().map(({ kind, platform, lane }) => `${kind}:${platform}:${lane}`);
  assert.deepEqual(expected, ["unit:linux:1", "unit:windows:1", "unit:windows:2", "e2e:linux:1", "e2e:macos:1", "e2e:windows:1"]);
});

// Property: after "Re-run failed jobs", the downloaded slices are spread over
// attempts 1..N. The aggregate must report every slice that any attempt
// uploaded, each from its newest attempt, and call a slice missing only when
// no attempt uploaded it. Oracle: a per-key max over the generated uploads.
test("slices spread over attempts resolve to each slice's newest attempt", () => {
  let seed = 0x5eed;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const expected = expectedSlices();
  const sliceAt = (dimension, attempt) => createSlice({ ...dimension, attempt, first: dimension.kind === "unit"
    ? unit([item(`from-${attempt}`, "failed")]) : { status: "failed", complete: true, errors: 0, tests: [{ id: `from-${attempt}`, name: "t", outcome: "unexpected", completed: true }] },
  retries: [] });
  for (let run = 0; run < 300; run += 1) {
    const attempts = 1 + Math.floor(random() * 4);
    const uploads = [];
    const newest = new Map();
    for (const dimension of expected) {
      // Every slice uploads in attempt 1 unless this run drops it entirely;
      // each later attempt re-runs it (a failed job or a dependent) at random.
      if (random() < 0.15) continue;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (attempt > 1 && random() < 0.5) continue;
        uploads.push(sliceAt(dimension, attempt));
        newest.set(dimension.key, attempt);
      }
    }
    for (let i = uploads.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [uploads[i], uploads[j]] = [uploads[j], uploads[i]];
    }
    const report = aggregateSlices({ slices: uploads, attempt: String(attempts) });
    assert.deepEqual(report.slices.map(({ key, attempt }) => [key, attempt]),
      expected.filter(({ key }) => newest.has(key)).map(({ key }) => [key, newest.get(key)]));
    assert.deepEqual(report.missingSlices.map(({ key }) => key), expected.filter(({ key }) => !newest.has(key)).map(({ key }) => key));
    for (const slice of report.slices) {
      assert.equal(slice.reused, slice.attempt < attempts);
      assert.deepEqual(slice.failures.map(({ id }) => id), [`from-${slice.attempt}`]);
    }
    assert.deepEqual(report.reusedSlices, report.slices.filter((s) => s.attempt < attempts).map(({ key, attempt }) => ({ key, attempt })));
    assert.equal(report.supersededSlices.length, uploads.length - report.slices.length);
    assert.equal(report.totals.initialFailures, report.slices.length);
  }
});

test("a slice uploaded twice by one attempt, or by a future attempt, is refused", () => {
  const dimension = expectedSlices()[0];
  const slice = createSlice({ ...dimension, attempt: 2, first: null, retries: [] });
  assert.throws(() => aggregateSlices({ slices: [slice, slice], attempt: "2" }), /duplicate/i);
  assert.throws(() => aggregateSlices({ slices: [slice], attempt: "1" }), /invalid attempt/i);
  // An unset or empty run attempt means attempt 1, not attempt 0.
  const first = createSlice({ ...dimension, attempt: 1, first: null, retries: [] });
  for (const attempt of [undefined, ""]) assert.equal(aggregateSlices({ slices: [first], attempt }).attempt, 1);
});

test("the CLI completes a partial re-run report from earlier attempts' artifacts", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const cwd = mkdtempSync(join(tmpdir(), "flake-rerun-test-"));
  const script = resolve("scripts/ci/write-flake-report.mjs");
  const passing = (kind) => kind === "unit" ? unit([item("passing", "passed")])
    : { status: "passed", complete: true, errors: 0, tests: [{ id: "passing", name: "passing", outcome: "expected", completed: true }] };
  // The PR #824 shape: attempt 1 uploads all six; attempt 2 re-runs only the
  // Windows unit job (both of its lanes).
  const artifactName = ({ kind, platform, lane }, attempt) => `flake-slice-${attempt}-${kind}-${platform}-${lane}`;
  try {
    const downloads = join(cwd, ".local/ci/flake-slices");
    const summary = join(cwd, "summary.md");
    const upload = (dimension, attempt, { recordAttempt = true } = {}) => {
      const slice = createSlice({ ...dimension, ...(recordAttempt ? { attempt } : {}), first: passing(dimension.kind), retries: [] });
      const dir = join(downloads, artifactName(dimension, attempt));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "flake-slice.json"), JSON.stringify(slice));
    };
    const aggregate = () => {
      writeFileSync(summary, "");
      const result = spawnSync(process.execPath, [script, "aggregate"], { cwd, encoding: "utf8",
        env: { ...process.env, FLAKE_SAMPLES: "1", GITHUB_RUN_ATTEMPT: "2", GITHUB_STEP_SUMMARY: summary } });
      return { status: result.status, stderr: result.stderr, report: JSON.parse(readFileSync(join(cwd, ".local/ci/flake-report/flake-report.json"))), summary: readFileSync(summary, "utf8") };
    };
    const expected = expectedSlices();
    const rerun = (d) => d.kind === "unit" && d.platform === "windows";
    for (const dimension of expected) upload(dimension, 1, { recordAttempt: dimension.kind === "e2e" });
    for (const dimension of expected.filter(rerun)) upload(dimension, 2);

    const complete = aggregate();
    assert.equal(complete.status, 0, complete.stderr + complete.summary);
    assert.equal(complete.report.missingSlices.length, 0);
    assert.deepEqual(complete.report.slices.map(({ key, attempt }) => [key, attempt]), expected.map((d) => [d.key, rerun(d) ? 2 : 1]));
    assert.match(complete.summary, /Slices received: 6\/6; missing: 0/);
    assert.match(complete.summary, /Reused from earlier attempts \(no upload in attempt 2\): unit-linux-lane-1-sample-1 \(attempt 1\), e2e-linux-lane-1-sample-1 \(attempt 1\)/);

    // A slice no attempt uploaded still fails the job.
    rmSync(join(downloads, artifactName(expected[3], 1)), { recursive: true });
    const missing = aggregate();
    assert.equal(missing.status, 1);
    assert.deepEqual(missing.report.missingSlices.map(({ key }) => key), [expected[3].key]);
    assert.match(missing.summary, /Not found in any attempt's artifacts \(never uploaded, or expired\): e2e-linux-lane-1-sample-1\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
