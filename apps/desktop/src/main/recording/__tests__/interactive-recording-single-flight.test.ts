import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { createInteractiveRecordingSingleFlight } from "../interactive-recording-single-flight";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createInteractiveRecordingSingleFlight", () => {
  test("holds one reservation across the whole async attempt and drops duplicates", async () => {
    const attempt = deferred<void>();
    const onDuplicate = vi.fn();
    const runAttempt = vi.fn(async (_protectWindowIds: readonly number[]) =>
      attempt.promise
    );
    const run = createInteractiveRecordingSingleFlight({
      runAttempt,
      onDuplicate
    });

    const first = run([41]);
    await vi.waitFor(() => expect(runAttempt).toHaveBeenCalledTimes(1));

    await expect(run([99])).resolves.toBeUndefined();
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(runAttempt.mock.calls[0]?.[0]).toEqual([41]);

    attempt.resolve(undefined);
    await first;
  });

  test("releases the reservation after success and failure", async () => {
    let shouldThrow = false;
    const runAttempt = vi.fn(async () => {
      if (shouldThrow) throw new Error("boom");
    });
    const run = createInteractiveRecordingSingleFlight({ runAttempt });

    await run();
    shouldThrow = true;
    await expect(run()).rejects.toThrow("boom");
    shouldThrow = false;
    await run();

    expect(runAttempt).toHaveBeenCalledTimes(3);
  });

  test("production wraps the full interactive recording attempt", async () => {
    const indexSource = await readFile(
      new URL("../../index.ts", import.meta.url),
      "utf8"
    );

    expect(indexSource).toContain(
      "const runInteractiveRecord = createInteractiveRecordingSingleFlight({"
    );
    expect(indexSource).toContain("runAttempt: runInteractiveRecordAttempt");
  });
});
