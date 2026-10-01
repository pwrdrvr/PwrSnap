import { err, ok, type CaptureDuplicateJob, type CommandName } from "@pwrsnap/shared";
import { afterEach, describe, expect, test } from "vitest";
import { bus } from "../../command-bus";
import { duplicateAndAwaitCommit } from "../await-duplicate";

const registered: CommandName[] = [];

afterEach(() => {
  for (const command of registered.splice(0)) bus.unregister(command);
});

function register(command: CommandName, handler: (req: any) => Promise<any>): void {
  bus.register(command as never, handler as never);
  registered.push(command);
}

const job: CaptureDuplicateJob = {
  jobId: "job_granola",
  sourceId: "cap_granola",
  captureId: "cap_granola_copy",
  withEdits: true,
  state: "copying",
  bytesCopied: 0,
  totalBytes: 1_000,
  error: null
};

const copyRecord = { id: "cap_granola_copy", kind: "video", family_id: "cap_granola" };

describe("duplicateAndAwaitCommit", () => {
  test("a clone or an image answers with its record, no waiting", async () => {
    let polled = 0;
    register("capture:duplicate", async () => ok({ record: copyRecord, job: null }));
    register("capture:duplicateJobs", async () => {
      polled += 1;
      return ok({ jobs: [] });
    });

    const result = await duplicateAndAwaitCommit(
      { captureId: "cap_granola", withEdits: true },
      { principal: "ipc" }
    );

    expect(result).toEqual(ok({ record: copyRecord, copiedInBackground: false }));
    expect(polled).toBe(0);
  });

  test("a background copy is waited out over the bus, then read back", async () => {
    let polls = 0;
    register("capture:duplicate", async () => ok({ record: null, job }));
    // Still copying for two looks, then gone: terminal.
    register("capture:duplicateJobs", async () => {
      polls += 1;
      return ok({ jobs: polls <= 2 ? [{ ...job, bytesCopied: polls * 400 }] : [] });
    });
    register("library:byId", async (req) => ok(req.id === job.captureId ? copyRecord : null));

    const result = await duplicateAndAwaitCommit(
      { captureId: "cap_granola", withEdits: true },
      { principal: "ipc" },
      { pollMs: 1 }
    );

    expect(result).toEqual(ok({ record: copyRecord, copiedInBackground: true }));
    expect(polls).toBe(3);
  });

  test("a job that ends with no row is a failed copy", async () => {
    register("capture:duplicate", async () => ok({ record: null, job }));
    register("capture:duplicateJobs", async () => ok({ jobs: [] }));
    register("library:byId", async () => ok(null));

    const result = await duplicateAndAwaitCommit(
      { captureId: "cap_granola", withEdits: false },
      { principal: "ipc" },
      { pollMs: 1 }
    );

    expect(result).toMatchObject({ ok: false, error: { code: "duplicate_failed" } });
  });

  test("an aborted wait stops polling and names the copy that keeps running", async () => {
    let polls = 0;
    const controller = new AbortController();
    register("capture:duplicate", async () => ok({ record: null, job }));
    register("capture:duplicateJobs", async () => {
      polls += 1;
      controller.abort();
      return ok({ jobs: [job] });
    });

    const result = await duplicateAndAwaitCommit(
      { captureId: "cap_granola", withEdits: true },
      { principal: "ipc" },
      { pollMs: 60_000, signal: controller.signal }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "aborted", message: expect.stringContaining("cap_granola_copy") }
    });
    expect(polls).toBe(1);
  });

  test.each(["not_found", "trashed", "unsupported", "in_progress"])(
    "passes a %s refusal through",
    async (code) => {
      register("capture:duplicate", async () =>
        err({ kind: "validation", code, message: "invented refusal" })
      );
      const result = await duplicateAndAwaitCommit(
        { captureId: "cap_granola", withEdits: true },
        { principal: "ipc" }
      );
      expect(result).toMatchObject({ ok: false, error: { code } });
    }
  );
});
