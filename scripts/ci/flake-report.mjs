const keyOf = ({ kind, platform, lane, sample }) => `${kind}-${platform}-lane-${lane}-sample-${sample}`;

export function expectedSlices() {
  return [
    { kind: "unit", platform: "linux", lane: 1, sample: 1 },
    { kind: "unit", platform: "windows", lane: 1, sample: 1 },
    { kind: "unit", platform: "windows", lane: 2, sample: 1 }, // native clipboard smoke
    { kind: "e2e", platform: "linux", lane: 1, sample: 1 },
    { kind: "e2e", platform: "macos", lane: 1, sample: 1 },
    { kind: "e2e", platform: "windows", lane: 1, sample: 1 },
  ].map((slice) => ({ ...slice, key: keyOf(slice) }));
}

function relativeFile(file, workspace) {
  if (typeof file !== "string") return file;
  const normalized = file.replaceAll("\\", "/");
  const root = workspace?.replaceAll("\\", "/").replace(/\/$/, "");
  return root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? normalized.slice(root.length + 1) : normalized;
}

export function createSlice({ kind, platform, lane, sample = 1, attempt, workspace, first, retries, jobStatus, firstOutcome, retryOutcome }) {
  const slice = { kind, platform, lane: Number(lane), sample: Number(sample) };
  const firstTests = kind === "unit"
    ? (first?.suites ?? []).flatMap((suite) => (suite.tests ?? []).map((test) => ({ ...test, project: suite.project, file: relativeFile(suite.file, workspace) })))
    : (first?.tests ?? []);
  const retryTests = retries.flatMap((report) => kind === "unit"
    ? (report?.suites ?? []).flatMap((suite) => suite.tests ?? []) : (report?.tests ?? []));
  const failed = firstTests.filter((test) => kind === "unit" ? test.state === "failed" : test.outcome === "unexpected");
  const failures = failed.map((test) => {
    const candidates = retryTests.filter((candidate) => candidate.id === test.id
      && (kind !== "unit" || candidate.state !== "skipped"));
    let retry = "unknown";
    if (test.completed && failed.filter((other) => other.id === test.id).length === 1
      && candidates.length === 1 && candidates[0].completed) {
      const state = kind === "unit" ? candidates[0].state : candidates[0].outcome;
      if (state === (kind === "unit" ? "passed" : "expected")) retry = "recovered";
      else if (state === (kind === "unit" ? "failed" : "unexpected")) retry = "failed";
    }
    return { id: test.id, name: test.name, ...(kind === "unit" ? { project: test.project, file: test.file } : {}), retry };
  });
  return {
    ...slice, ...(attempt === undefined || attempt === "" ? {} : { attempt: Number(attempt) }),
    slice: kind === "unit" && platform === "windows" && Number(lane) === 2 ? "native-clipboard-smoke" : "full", key: keyOf(slice), jobStatus, firstOutcome, retryOutcome,
    first: { available: !!first, complete: first?.complete === true, status: first?.reason ?? first?.status ?? null,
      tests: first ? firstTests.length : null, errors: first ? (kind === "unit" ? first.unhandledErrors + (first.suites ?? []).reduce((n, suite) => n + (suite.errors ?? 0), 0) : first.errors) : null,
      ...(kind === "unit" && first?.completion ? { completion: first.completion } : {}) },
    failures,
  };
}

const isAttempt = (value) => Number.isInteger(value) && value >= 1;

// A "Re-run failed jobs" attempt re-runs only the failed jobs and their
// dependents; every other job's slice was uploaded by an earlier attempt of the
// same run and is still downloadable. So the input holds slices from attempts
// 1..N, and each slice identity is reported from the NEWEST attempt that
// uploaded it. A slice absent from every attempt is still missing.
export function aggregateSlices({ slices, runId, attempt, sha, headSha, warnings = [] }) {
  const expected = expectedSlices();
  const reportAttempt = Number(attempt) || 1;
  const byKey = new Map();
  const superseded = [];
  const allowed = new Set(expected.map((slice) => slice.key));
  for (const input of slices) {
    const slice = { ...input, attempt: Number(input.attempt ?? reportAttempt) };
    if (!allowed.has(slice.key) || slice.key !== keyOf(slice)) throw new Error(`Unexpected slice: ${slice.key}`);
    if (!isAttempt(slice.attempt) || slice.attempt > reportAttempt) throw new Error(`Slice ${slice.key} has invalid attempt ${input.attempt}`);
    const held = byKey.get(slice.key);
    if (held && held.attempt === slice.attempt) throw new Error(`Duplicate slice: ${slice.key} (attempt ${slice.attempt})`);
    if (held && held.attempt > slice.attempt) {
      superseded.push({ key: slice.key, attempt: slice.attempt });
      continue;
    }
    if (held) superseded.push({ key: held.key, attempt: held.attempt });
    byKey.set(slice.key, slice);
  }
  const missingSlices = expected.filter((slice) => !byKey.has(slice.key));
  const ordered = expected.filter((slice) => byKey.has(slice.key))
    .map((slice) => ({ ...byKey.get(slice.key), reused: byKey.get(slice.key).attempt < reportAttempt }));
  const failures = ordered.flatMap((slice) => slice.failures);
  return { schemaVersion: 1, runId: runId ?? null, attempt: reportAttempt, sha: sha ?? null, headSha: headSha || null,
    generatedAt: new Date().toISOString(), expectedSlices: expected.length, missingSlices, warnings,
    reusedSlices: ordered.filter((slice) => slice.reused).map(({ key, attempt: from }) => ({ key, attempt: from })),
    supersededSlices: superseded.sort((a, b) => a.key.localeCompare(b.key) || a.attempt - b.attempt),
    totals: { initialFailures: failures.length, recovered: failures.filter((test) => test.retry === "recovered").length,
      failed: failures.filter((test) => test.retry === "failed").length, unknown: failures.filter((test) => test.retry === "unknown").length },
    slices: ordered };
}
