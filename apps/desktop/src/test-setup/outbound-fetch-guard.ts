// Fails any test that makes a real outbound HTTP request.
//
// Ported from PwrAgnt's `apps/desktop/src/test-setup/outbound-fetch-guard.ts`.
//
// The suites reach live network paths with no test-mode gate of their own:
// `auto-updater` polls the GitHub releases API, and the sizzle voice path
// (`sizzle/tts.ts`, `sizzle/speech-timing.ts`) calls OpenAI. The GitHub one is
// why this file exists: the REST API allows 60 anonymous requests per hour per
// IP, shared by every process on the machine, so a suite that quietly spends
// from that budget takes it away from the shipped app's update checks — and
// from every other suite running on the same CI runner.
//
// The hook is `globalThis.fetch` rather than an injected `fetch` option on each
// caller, because it is the one chokepoint every request funnels through, so it
// covers modules that were never given a seam and any network path added later.
// Injection is how you *fix* a failure here, but it cannot be what enforces the
// rule, because a module with no seam is exactly the case that needs catching.
//
// It records **and** throws. The throw alone is not enough:
// `readAppUpdateReleaseVersions` catches every error and degrades to
// `unavailableReason` strings, and `fetchLatestGitHubRelease` swallows its own
// errors by design — so a bare throw would be absorbed and the test would pass
// green having attempted the request anyway. The recorded attempt is what fails
// the test.
//
// Loopback is allowed through, because it is not egress: a request to
// `localhost` / `127.0.0.0/8` / `::1` reaches a server the test itself started.
// So is a scheme that never opens a socket at all (`data:`, `blob:`, `file:`,
// and PwrSnap's own `pwrsnap-capture://` protocol). See `staysOnThisMachine`.
//
// Not covered: `http.request` / `https.request` / `net.connect` and Electron's
// `net` module. Node's `fetch` is undici and does not route through them, and
// nothing in these suites uses them directly, so the narrower hook is the one
// that earns its keep.
//
// Fix a failure by keeping the request out of the test, never by calling
// through to the real `fetch`:
//   - Auto-updater: replace `globalThis.fetch` for the test's own duration, as
//     `auto-updater.test.ts`, `auto-updater-retry.test.ts`, and
//     `auto-updater-release-cache.test.ts` do. This file reinstalls the guard
//     for the next test file either way.
//   - Anything else: `vi.mock` the module that owns the request, or inject a
//     fetch seam and pass a fake.
import { afterAll, afterEach } from "vitest";

type Attempt = { method: string; url: string };

const INSTALLED = Symbol.for("pwrsnap.outboundFetchGuard.installed");
const ATTEMPTS = Symbol.for("pwrsnap.outboundFetchGuard.attempts");
const NATIVE = Symbol.for("pwrsnap.outboundFetchGuard.native");

type GuardGlobal = typeof globalThis & {
  [INSTALLED]?: typeof globalThis.fetch;
  [ATTEMPTS]?: Attempt[];
  [NATIVE]?: typeof globalThis.fetch;
};

const guardGlobal = globalThis as GuardGlobal;
const attempts: Attempt[] = (guardGlobal[ATTEMPTS] ??= []);
// Captured on the first install only. A reinstall sees whatever the previous
// test file left behind, which may be that file's mock — passing loopback
// traffic to a stale mock would be worse than blocking it.
const nativeFetch: typeof globalThis.fetch = (guardGlobal[NATIVE] ??= guardGlobal.fetch);

// Setup files re-run for every test file in a worker, and `globalThis.fetch` is
// a plain writable property that tests routinely replace, so re-asserting the
// guard here is what makes it the baseline each file starts from rather than a
// one-shot install a single unrestored mock could retire for the rest of the
// worker. The identity check keeps a re-run from wrapping the guard in itself.
if (guardGlobal[INSTALLED] !== guardGlobal.fetch) {
  const guardedFetch = function guardedFetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]
  ): Promise<Response> {
    const attempt = describeRequest(input, init);
    if (staysOnThisMachine(attempt.url)) {
      return nativeFetch(input, init);
    }
    attempts.push(attempt);
    throw new Error(describeAttempt(attempt));
  } as typeof globalThis.fetch;
  Object.defineProperty(guardGlobal, "fetch", {
    configurable: true,
    value: guardedFetch,
    writable: true
  });
  guardGlobal[INSTALLED] = guardedFetch;
}

afterEach(() => {
  reportRecordedAttempts("This test");
});

// `afterEach` cannot see a request issued from `afterAll`, nor one from an
// async path that settles after the final test — and a swallowed throw leaves
// nothing else to notice it.
afterAll(() => {
  reportRecordedAttempts("This test file, after its last test,");
});

function reportRecordedAttempts(subject: string): void {
  const observed = attempts.splice(0);
  if (observed.length > 0) {
    throw new Error(
      [
        `${subject} attempted ${observed.length} real outbound HTTP request(s):`,
        ...observed.map((attempt) => `  ${describeAttempt(attempt)}`),
        "Serve the request from the test instead — see the remedies in",
        "apps/desktop/src/test-setup/outbound-fetch-guard.ts."
      ].join("\n")
    );
  }
}

/**
 * `fetch` takes a string, a `URL`, or a `Request`, and a `Request` carries its
 * own method. Read both shapes so the failure names the URL that was actually
 * attempted rather than `[object Request]`.
 */
function describeRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1]
): Attempt {
  if (typeof input === "object" && input !== null && "url" in input) {
    const request = input as Request;
    return { method: init?.method ?? request.method, url: request.url };
  }
  return { method: init?.method ?? "GET", url: String(input) };
}

function describeAttempt(attempt: Attempt): string {
  return `${attempt.method.toUpperCase()} ${attempt.url}`;
}

/**
 * A request that cannot leave the machine is not the thing this guard exists to
 * stop. Two shapes qualify:
 *
 *   - Loopback — a test talking to a server the test itself started. PwrSnap's
 *     local-agent MCP server and tool RPC server are both in that category.
 *   - A scheme that opens no socket at all — `data:`, `blob:`, `file:`, and the
 *     app's own `pwrsnap-capture://` protocol. Those have no host to classify,
 *     and reading an inline fixture or a registered protocol is not egress.
 *
 * An unparseable URL is treated as escaping: nothing here can prove where it
 * would go.
 */
function staysOnThisMachine(url: string): boolean {
  const parsed = parseRequestUrl(url);
  if (parsed === null) {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }
  return isLoopbackHost(parsed.hostname.toLowerCase());
}

/**
 * jsdom gives the renderer a document origin, so a relative URL there is a
 * same-origin request against `localhost` rather than an unparseable one — the
 * guard measures egress, not same-origin. Node has no `location`, and undici
 * rejects a relative URL outright, so the same input there stays in the
 * "cannot prove where it goes" case alongside a malformed URL.
 */
function parseRequestUrl(url: string): URL | null {
  try {
    return new URL(url, globalThis.location?.href);
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  // Node reports IPv6 hosts in their bracketed form.
  const address = host.replace(/^\[|\]$/g, "");
  return (
    address === "localhost" ||
    address.endsWith(".localhost") ||
    // The wildcard bind addresses: a client that connects to one reaches a
    // local listener, so a test addressing its own `0.0.0.0`/`::` server is
    // still talking to itself.
    address === "0.0.0.0" ||
    address === "::" ||
    address === "::1" ||
    // A dual-stack socket reports IPv4 loopback as `::ffff:127.0.0.1`, which
    // the URL parser normalizes to its hex form — `::ffff:7f00:1` for
    // `127.0.0.1`. The first group is `7f` plus the second octet, so the whole
    // of `127.0.0.0/8` is `7f00`–`7fff`.
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(address) ||
    /^127(\.\d{1,3}){3}$/.test(address)
  );
}
