// The gate exists because a `rename` can land after an `rm -rf`. These tests
// drive that ordering directly with deferred promises rather than through
// ffmpeg, because the bug is entirely about WHEN each side runs — the
// filesystem work is incidental and a real encode would only make the race
// non-deterministic again.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setRuntimeProcessRole } from "../../process-role";
import {
  forwardDerivedCacheCleanup,
  installDerivedCacheCleanupForwarder,
  resetDerivedCacheCleanupForwarderForTests,
  resetDerivedCacheGateForTests,
  runGatedCacheWrite,
  withDerivedCacheCleanup
} from "../derived-cache-gate";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued microtask/timer callback run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetDerivedCacheGateForTests();
  resetDerivedCacheCleanupForwarderForTests();
  setRuntimeProcessRole("combined");
});

afterEach(() => {
  resetDerivedCacheGateForTests();
  resetDerivedCacheCleanupForwarderForTests();
  setRuntimeProcessRole("combined");
});

describe("admission", () => {
  test("a write admitted while a cleanup is in progress is rejected, not queued", async () => {
    const blocked = deferred<void>();
    const cleanup = withDerivedCacheCleanup({ captureId: "cap-a" }, () => blocked.promise);
    await settle();

    // The whole point: this must not wait for the cleanup and then write into
    // the directory it just emptied.
    await expect(
      runGatedCacheWrite("cap-a", "cap-a/playback.mp4", async () => "written")
    ).rejects.toMatchObject({ name: "AbortError" });

    blocked.resolve();
    await cleanup;
  });

  test("admission reopens once the cleanup's filesystem work finishes", async () => {
    const blocked = deferred<void>();
    const cleanup = withDerivedCacheCleanup({ captureId: "cap-a" }, () => blocked.promise);
    await settle();
    blocked.resolve();
    await cleanup;

    await expect(
      runGatedCacheWrite("cap-a", "cap-a/playback.mp4", async () => "written")
    ).resolves.toBe("written");
  });

  test("a cleanup for one capture does not block writes for another", async () => {
    const blocked = deferred<void>();
    const cleanup = withDerivedCacheCleanup({ captureId: "cap-a" }, () => blocked.promise);
    await settle();

    await expect(
      runGatedCacheWrite("cap-b", "cap-b/playback.mp4", async () => "b")
    ).resolves.toBe("b");

    blocked.resolve();
    await cleanup;
  });

  test('a "all" cleanup blocks writes for every capture', async () => {
    const blocked = deferred<void>();
    const cleanup = withDerivedCacheCleanup("all", () => blocked.promise);
    await settle();

    await expect(
      runGatedCacheWrite("cap-b", "cap-b/playback.mp4", async () => "b")
    ).rejects.toMatchObject({ name: "AbortError" });

    blocked.resolve();
    await cleanup;
  });
});

describe("draining", () => {
  test("the filesystem cleanup does not start until in-flight writes have drained", async () => {
    const order: string[] = [];
    const encode = deferred<string>();
    // A holder, not a bare `let`: TS narrows a `let` assigned only inside a
    // closure to its initializer, and the read below becomes `never`.
    const seen: { signal: AbortSignal | null } = { signal: null };

    const write = runGatedCacheWrite("cap-a", "cap-a/playback.mp4", async (signal) => {
      seen.signal = signal;
      const value = await encode.promise;
      order.push("write settled");
      return value;
    });
    // Swallow here; asserted below. Without this the abort rejection is
    // unhandled before the assertion attaches.
    const writeResult = write.catch((cause: unknown) => cause);
    await settle();

    const cleanup = withDerivedCacheCleanup({ captureId: "cap-a" }, async () => {
      order.push("rm -rf");
    });
    await settle();

    // abort() reached the work, but the cleanup has NOT run yet — an aborted
    // ffmpeg still holds its staging file when abort() returns.
    expect(seen.signal?.aborted).toBe(true);
    expect(order).toEqual([]);

    encode.resolve("late");
    await cleanup;
    expect(order).toEqual(["write settled", "rm -rf"]);
    await expect(writeResult).resolves.toMatchObject({ name: "AbortError" });
  });

  test("a write that completes during a cleanup does not report success", async () => {
    // The work finished, but its output has just been deleted. Reporting the
    // asset as available would hand a player a URL for a file that is gone.
    const encode = deferred<string>();
    const write = runGatedCacheWrite("cap-a", "cap-a/playback.mp4", () => encode.promise);
    const writeResult = write.catch((cause: unknown) => cause);
    await settle();

    const cleanup = withDerivedCacheCleanup({ captureId: "cap-a" }, async () => undefined);
    encode.resolve("published");
    await cleanup;

    await expect(writeResult).resolves.toMatchObject({ name: "AbortError" });
  });
});

describe("serialization", () => {
  test("overlapping cleanups run one at a time", async () => {
    // Clear/Trim walk the whole root and a purge walks part of it; running
    // them concurrently races an `rm -rf` against a `readdir` that already
    // listed the entries.
    const order: string[] = [];
    const first = deferred<void>();
    const second = deferred<void>();

    const clear = withDerivedCacheCleanup("all", async () => {
      order.push("clear start");
      await first.promise;
      order.push("clear end");
    });
    const trim = withDerivedCacheCleanup("all", async () => {
      order.push("trim start");
      await second.promise;
      order.push("trim end");
    });
    await settle();

    expect(order).toEqual(["clear start"]);
    first.resolve();
    await settle();
    expect(order).toEqual(["clear start", "clear end", "trim start"]);

    second.resolve();
    await Promise.all([clear, trim]);
    expect(order).toEqual(["clear start", "clear end", "trim start", "trim end"]);
  });

  test("overlapping cleanups keep admission closed until the LAST one finishes", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const a = withDerivedCacheCleanup({ captureId: "cap-a" }, () => first.promise);
    const b = withDerivedCacheCleanup({ captureId: "cap-a" }, () => second.promise);
    await settle();

    first.resolve();
    await a;

    // `a` is done, but `b` is still deleting this capture's directory.
    await expect(
      runGatedCacheWrite("cap-a", "cap-a/playback.mp4", async () => "x")
    ).rejects.toMatchObject({ name: "AbortError" });

    second.resolve();
    await b;
    await expect(
      runGatedCacheWrite("cap-a", "cap-a/playback.mp4", async () => "x")
    ).resolves.toBe("x");
  });

  test("a failed cleanup releases admission and does not poison the next one", async () => {
    const failing = withDerivedCacheCleanup("all", async () => {
      throw new Error("rm failed: EBUSY");
    });
    await expect(failing).rejects.toThrow("EBUSY");

    // The caller saw its own failure; the NEXT cleanup must still run, and
    // writes must be admitted again.
    const ran = vi.fn(async () => undefined);
    await expect(withDerivedCacheCleanup("all", ran)).resolves.toBeUndefined();
    expect(ran).toHaveBeenCalledTimes(1);
    await expect(
      runGatedCacheWrite("cap-a", "cap-a/playback.mp4", async () => "x")
    ).resolves.toBe("x");
  });
});

describe("coalescing", () => {
  test("two writers of the same artifact share one run", async () => {
    const work = vi.fn(async () => "shared");
    const [a, b] = await Promise.all([
      runGatedCacheWrite("cap-a", "cap-a/playback-k1.mp4", work),
      runGatedCacheWrite("cap-a", "cap-a/playback-k1.mp4", work)
    ]);
    expect(work).toHaveBeenCalledTimes(1);
    expect([a, b]).toEqual(["shared", "shared"]);
  });

  test("writers of different artifacts do not adopt each other's result", async () => {
    // A rendition's name encodes the source revision. Coalescing across two
    // revisions would serve one caller the other's bytes.
    const [a, b] = await Promise.all([
      runGatedCacheWrite("cap-a", "cap-a/playback-k1.mp4", async () => "k1"),
      runGatedCacheWrite("cap-a", "cap-a/playback-k2.mp4", async () => "k2")
    ]);
    expect([a, b]).toEqual(["k1", "k2"]);
  });

  test("a settled write is retired, so the next call re-runs the work", async () => {
    const work = vi.fn(async () => "again");
    await runGatedCacheWrite("cap-a", "cap-a/playback-k1.mp4", work);
    await runGatedCacheWrite("cap-a", "cap-a/playback-k1.mp4", work);
    expect(work).toHaveBeenCalledTimes(2);
  });
});

describe("split-mode forwarding", () => {
  test("the library forwards instead of cleaning locally", async () => {
    setRuntimeProcessRole("library");
    const forward = vi.fn(async () => undefined);
    installDerivedCacheCleanupForwarder(forward);

    const forwarded = forwardDerivedCacheCleanup({ operation: "purge", captureId: "cap-a" });
    expect(forwarded).not.toBeNull();
    await forwarded;
    expect(forward).toHaveBeenCalledWith({ operation: "purge", captureId: "cap-a" });
  });

  test("the agent and combined roles clean locally", () => {
    for (const role of ["agent", "combined"] as const) {
      setRuntimeProcessRole(role);
      expect(forwardDerivedCacheCleanup({ operation: "clear" })).toBeNull();
    }
  });

  test("a library with no forwarder fails closed rather than cleaning locally", async () => {
    // A local `rm -rf` here would race the agent's writes — the bug this
    // whole module exists to prevent. Not cleaning is the safe answer.
    setRuntimeProcessRole("library");
    const forwarded = forwardDerivedCacheCleanup({ operation: "trim" });
    expect(forwarded).not.toBeNull();
    await expect(forwarded).rejects.toThrow(/owner unavailable/);
  });

  test("the forwarder is installed exactly once", () => {
    installDerivedCacheCleanupForwarder(async () => undefined);
    expect(() => installDerivedCacheCleanupForwarder(async () => undefined)).toThrow(
      /already installed/
    );
  });
});
