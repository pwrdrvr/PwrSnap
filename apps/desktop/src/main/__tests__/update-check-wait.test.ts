import { describe, expect, test, vi } from "vitest";
import { waitForUpdateCheckSlot, type InFlightUpdateCheck } from "../update-check-wait";

const result = { status: "no-update", version: "1.1.0" } as const;

describe("update check wait guard", () => {
  test.each([false, true])("stops on an orphaned settled promise (rejected=%s)", async (rejected) => {
    const promise = rejected ? Promise.reject(new Error("failed check")) : Promise.resolve(result);
    const read = () => ({ selection: undefined, promise });
    const onWait = vi.fn(() => {
      if (onWait.mock.calls.length > 20) throw new Error("unbounded wait");
    });
    await expect(waitForUpdateCheckSlot("stable:latest", read, onWait, async () => result))
      .rejects.toThrow("did not release its completed request");
    expect(onWait).toHaveBeenCalledTimes(1);
  });

  test("bounds churn even when every completed request is replaced", async () => {
    const onWait = vi.fn(() => {
      // Also prevents a regression from starving Vitest's timer indefinitely.
      if (onWait.mock.calls.length > 20) throw new Error("unbounded wait");
    });
    await expect(waitForUpdateCheckSlot("stable:latest", () => ({
      selection: "beta:latest", promise: Promise.resolve(result)
    }), onWait, async () => result)).rejects.toThrow("selection kept changing");
    expect(onWait).toHaveBeenCalledTimes(8);
  });

  test("joins the requested selection without waiting for another slot", async () => {
    const onWait = vi.fn();
    await expect(waitForUpdateCheckSlot("stable:latest", () => ({
      selection: "stable:latest", promise: Promise.resolve(result)
    }), onWait, async () => result)).resolves.toEqual(result);
    expect(onWait).not.toHaveBeenCalled();
  });

  test("reserves an empty slot before concurrent callers can start another check", async () => {
    let check: InFlightUpdateCheck | undefined;
    const start = vi.fn(() => {
      check = { selection: "stable:latest", promise: Promise.resolve(result) };
      return check.promise;
    });
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      waitForUpdateCheckSlot("stable:latest", () => check, vi.fn(), start)
    ));
    expect(results).toEqual(Array(10).fill(result));
    expect(start).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])("proceeds once the owner releases its slot (rejected=%s)", async (rejected) => {
    let check: InFlightUpdateCheck | undefined;
    check = {
      selection: "beta:latest",
      promise: Promise.resolve().then(() => {
        check = undefined;
        if (rejected) throw new Error("network failure");
        return result;
      })
    };
    await expect(waitForUpdateCheckSlot("stable:latest", () => check, vi.fn(), async () => result))
      .resolves.toEqual(result);
  });
});
