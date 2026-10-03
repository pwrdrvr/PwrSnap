// Standalone Node tests: the audit workflow intentionally installs no dependencies.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const helpers = import("./audit-package-channels.mjs");
const ok = (body) => ({ status: 200, headers: {}, body });
const emptySearch = { incomplete_results: false, total_count: 0, items: [] };

test("429 retries are bounded and never become an absence result", async () => {
  const { makeApi } = await helpers;
  let calls = 0;
  const waits = [];
  const api = makeApi({
    request: async () => { calls++; return { status: 429, headers: {}, body: null }; },
    sleep: async (ms) => waits.push(ms),
  });
  await assert.rejects(api("search/code", { search: true }), /throttled.*no absence conclusion/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [60_000, 120_000]);
});

test("a transient throttle can recover with a complete authenticated response", async () => {
  const { makeApi } = await helpers;
  const responses = [
    { status: 403, headers: { "retry-after": "90" }, body: { message: "secondary rate limit" } },
    ok(emptySearch),
  ];
  const waits = [];
  const api = makeApi({ request: async () => responses.shift(), sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await api("search/code", { search: true }), emptySearch);
  assert.deepEqual(waits, [90_000]);
});

test("long server retry delays stop rather than retry early", async () => {
  const { makeApi } = await helpers;
  const api = makeApi({
    request: async () => ({ status: 429, headers: { "retry-after": "300" }, body: null }),
    sleep: async () => assert.fail("must not retry earlier than the server allows"),
  });
  await assert.rejects(api("search/code"), /retry delay exceeds 120s budget/);
});

test("primary reset time is respected and an invalid PAT does not silently fall back", async () => {
  const { makeApi } = await helpers;
  const api = makeApi({
    request: async () => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "500" }, body: null }),
    now: () => 0,
    sleep: async () => assert.fail("reset is beyond the retry budget"),
  });
  await assert.rejects(api("search/code"), /retry delay exceeds/);
  const denied = makeApi({ request: async () => ({ status: 401, headers: {}, body: { message: "do not log credentials" } }) });
  await assert.rejects(denied("search/code"), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /do not log credentials/);
    return true;
  });
});

test("incomplete or missing search completeness never certifies zero results", async () => {
  const { makeApi } = await helpers;
  for (const incomplete_results of [true, undefined]) {
    const api = makeApi({ request: async () => ok({ total_count: 0, items: [], incomplete_results }), sleep: async () => {} });
    await assert.rejects(api("search/code", { search: true }), /incomplete search.*no absence conclusion/);
  }
});

test("search pagination reads all results and refuses the 1000-result ceiling", async () => {
  const { searchAll } = await helpers;
  const batch = Array.from({ length: 100 }, (_, n) => ({ path: `${n}` }));
  const results = [
    { incomplete_results: false, total_count: 101, items: batch },
    { incomplete_results: false, total_count: 101, items: [{ path: "last" }] },
  ];
  assert.equal((await searchAll(async () => results.shift(), "code", "PwrSnap")).length, 101);
  await assert.rejects(searchAll(async () => ({ total_count: 1001, items: batch }), "code", "PwrSnap"), /truncated search/);
  await assert.rejects(searchAll(async () => ({ total_count: 1, items: [] }), "code", "PwrSnap"), /incomplete search pagination/);
});

test("duplicate search pages or changing counts cannot masquerade as complete pagination", async () => {
  const { searchAll } = await helpers;
  const page = Array.from({ length: 100 }, (_, n) => ({ path: `${n}` }));
  const duplicated = [
    { total_count: 101, items: page },
    { total_count: 101, items: [page[0]] },
  ];
  await assert.rejects(searchAll(async () => duplicated.shift(), "code", "PwrSnap"), /duplicate.*no absence conclusion/);
  const changing = [{ total_count: 101, items: page }, { total_count: 102, items: [{ path: "last" }] }];
  await assert.rejects(searchAll(async () => changing.shift(), "code", "PwrSnap"), /search changed.*no absence conclusion/);
});

function fixtureApi({ repoDenied = false, alternative = false } = {}) {
  return async (path) => {
    if (/^repos\/[^/]+\/[^/]+$/.test(path)) {
      if (repoDenied && path.includes("winget-pkgs")) throw new Error("Audit blocked: HTTP 403; no absence conclusion");
      return { private: false };
    }
    if (path.endsWith("/releases/latest")) return { tag_name: "v1.0.4", html_url: "latest", assets: [] };
    if (path.includes("/releases?")) return [
      { tag_name: "v1.9.0", prerelease: false, draft: false },
      { tag_name: "v1.10.0", prerelease: false, draft: false },
      { tag_name: "v2.0.0-alpha.1", prerelease: false, draft: false },
      { tag_name: "v3.0.0", prerelease: true, draft: false },
    ];
    if (path.includes("winget-pkgs/contents")) return null;
    if (path.startsWith("search/")) return {
      ...emptySearch,
      ...(alternative && path.includes("search/code") && path.includes("winget-pkgs")
        ? { total_count: 1, items: [{ path: "manifests/p/Other/PwrSnap/1.0.0/a.yaml" }] } : {}),
    };
    if (path.includes("Casks/pwrsnap.rb")) return {
      encoding: "base64",
      content: Buffer.from(`cask "pwrsnap" do\n  version "1.1.2"\n  sha256 "${"a".repeat(64)}"\n  url "https://github.com/pwrdrvr/PwrSnap/releases/download/v#{version}/PwrSnap-#{version}-universal.dmg"\nend`).toString("base64"),
    };
    assert.fail(`unexpected request ${path}`);
  };
}

test("audits distinguish older Latest, highest promoted stable, and confirmed known-path absence", async () => {
  const { auditChannels } = await helpers;
  const result = await auditChannels(fixtureApi());
  assert.equal(result.status, "complete");
  assert.equal(result.github.latest.version, "v1.0.4");
  assert.equal(result.github.highestPromotedStable.version, "v1.10.0");
  assert.equal(result.winget.status, "not-published-at-known-path");
  assert.equal(result.homebrew.version, "1.1.2");
  assert.match(result.homebrew.url, /v1\.1\.2\/PwrSnap-1\.1\.2-universal\.dmg$/);
});

test("unreadable sources and alternate identities cannot be reported as package absence", async () => {
  const { auditChannels } = await helpers;
  await assert.rejects(auditChannels(fixtureApi({ repoDenied: true })), /no absence conclusion/);
  const result = await auditChannels(fixtureApi({ alternative: true }));
  assert.equal(result.winget.status, "identity-needs-review");
  assert.equal(result.winget.identities.length, 1);
});
