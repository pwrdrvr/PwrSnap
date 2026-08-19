// A guard that silently stopped firing would be worse than no guard: the
// suite would look protected while spending the shared anonymous GitHub
// quota. These tests drive the installed guard through `globalThis.fetch`,
// which is the only surface it exposes.
//
// Each blocked-request test drains the guard's recorded-attempt list itself.
// The guard records an attempt *and* throws — the recorded attempt is what
// fails the test in `afterEach` — so a test that deliberately trips the guard
// has to consume its own record, and asserting on what it drained is how the
// test proves the recording half works.
//
// The blocked-request cases deliberately target the reserved `.invalid` TLD
// (RFC 2606), never a real host. If the guard is ever not installed — someone
// drops the `setupFiles` entry — these calls reach the real `fetch`, and a
// test that named `api.github.com` would then spend a request from the very
// quota the guard exists to protect, on every run, while reporting only a
// failed assertion. An unresolvable host costs a DNS failure instead, and
// exercises identical guard logic: non-loopback, `https:` scheme.
import { describe, expect, test } from "vitest";

type Attempt = { method: string; url: string };

const ATTEMPTS = Symbol.for("pwrsnap.outboundFetchGuard.attempts");

function drainAttempts(): Attempt[] {
  const recorded = (globalThis as typeof globalThis & { [ATTEMPTS]?: Attempt[] })[ATTEMPTS];
  return recorded === undefined ? [] : recorded.splice(0);
}

describe("outbound fetch guard", () => {
  test("blocks and records an external request", () => {
    expect(() => fetch("https://guard.invalid/repos/pwrdrvr/PwrSnap/releases")).toThrow(
      "GET https://guard.invalid/repos/pwrdrvr/PwrSnap/releases"
    );

    expect(drainAttempts()).toEqual([
      { method: "GET", url: "https://guard.invalid/repos/pwrdrvr/PwrSnap/releases" }
    ]);
  });

  test("names the method and URL of a Request object", () => {
    expect(() =>
      fetch(new Request("https://guard.invalid/v1/audio/speech", { method: "POST" }))
    ).toThrow("POST https://guard.invalid/v1/audio/speech");

    expect(drainAttempts()).toEqual([
      { method: "POST", url: "https://guard.invalid/v1/audio/speech" }
    ]);
  });

  test("blocks a URL it cannot classify", () => {
    expect(() => fetch("not-a-url")).toThrow("GET not-a-url");
    expect(drainAttempts()).toHaveLength(1);
  });

  test("lets loopback through — a test's own server is not egress", async () => {
    // Port 9 (discard) with nothing bound refuses fast. What matters is that
    // the rejection comes from the connection, not from the guard, and that
    // nothing was recorded.
    await expect(
      fetch("http://127.0.0.1:9/", { signal: AbortSignal.timeout(2_000) })
    ).rejects.toThrow(/fetch failed|aborted|timeout/i);

    expect(drainAttempts()).toEqual([]);
  });

  test("lets a scheme that opens no socket through", async () => {
    const response = await fetch("data:text/plain,pwrsnap");

    expect(await response.text()).toBe("pwrsnap");
    expect(drainAttempts()).toEqual([]);
  });
});
