// Duplicate through the command bus and answer only once the copy exists.
//
// `capture:duplicate` answers a byte-copied video with a background job
// (see duplicate-jobs.ts) and the Library shows its progress. An agent has
// no progress UI and its next step is an edit of the copy, which needs the
// row, so the agent surfaces (MCP's `pwrsnap_capture_duplicate`, the chat's
// `duplicate_capture`) wait here for the commit.
//
// This waits over the BUS, not on `waitForDuplicateJob`. In split mode
// `capture:*` is agent-owned: the job registry lives in the agent process,
// while the MCP server runs in the Library's, where a direct wait finds no
// job and resolves null at once.

import type { CaptureRecord, PwrSnapError, Result } from "@pwrsnap/shared";
import { err, ok } from "@pwrsnap/shared";
import { bus, type CommandDispatchOptions } from "../command-bus";

/** How often to look again while a background copy runs. */
export const DUPLICATE_COMMIT_POLL_MS = 250;

export type AwaitedDuplicate = {
  record: CaptureRecord;
  /** True when the copy ran as a background job before it committed. */
  copiedInBackground: boolean;
};

export async function duplicateAndAwaitCommit(
  req: { captureId: string; withEdits: boolean },
  context: CommandDispatchOptions,
  options: { signal?: AbortSignal | undefined; pollMs?: number } = {}
): Promise<Result<AwaitedDuplicate, PwrSnapError>> {
  const { signal } = options;
  const started = await bus.dispatch("capture:duplicate", req, context);
  if (!started.ok) return started;
  if (started.value.record !== null) {
    return ok({ record: started.value.record, copiedInBackground: false });
  }
  const { job } = started.value;
  const pollMs = options.pollMs ?? DUPLICATE_COMMIT_POLL_MS;
  // `capture:duplicateJobs` lists only jobs still copying, so the job
  // leaving the list is the terminal signal; the row says how it ended.
  for (;;) {
    // An abandoned wait leaves the copy running: the Library shows it,
    // and cancelling there is the user's call, not a dropped request's.
    if (signal?.aborted === true) {
      return err({
        kind: "validation",
        code: "aborted",
        message:
          `stopped waiting; the copy continues in PwrSnap as ${job.captureId} ` +
          "and appears in the Library when it finishes"
      });
    }
    const jobs = await bus.dispatch("capture:duplicateJobs", {}, context);
    if (!jobs.ok) return jobs;
    if (!jobs.value.jobs.some((candidate) => candidate.jobId === job.jobId)) break;
    await delay(pollMs, signal);
  }
  const copy = await bus.dispatch("library:byId", { id: job.captureId }, context);
  if (!copy.ok) return copy;
  if (copy.value === null) {
    // Failed or cancelled (from the Library). The reason went to the
    // Library's progress UI with the job's terminal event.
    return err({
      kind: "persistence",
      code: "duplicate_failed",
      message: "PwrSnap could not finish copying that recording."
    });
  }
  return ok({ record: copy.value, copiedInBackground: true });
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    // An already-aborted signal never fires "abort" again.
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
