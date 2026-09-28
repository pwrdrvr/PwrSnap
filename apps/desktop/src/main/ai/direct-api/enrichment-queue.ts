import { IterableQueueMapperSimple } from "@shutterstock/p-map-iterable";

export const ENRICHMENT_QUEUE_MAX_AGE_MS = 15 * 60_000;
export const DIRECT_ENRICHMENT_TIMEOUT_MS = 15 * 60_000;

export class EnrichmentQueueExpiredError extends Error {
  constructor() {
    super("the enrichment waited at least 15 minutes in the queue and was not sent to the model");
    this.name = "EnrichmentQueueExpiredError";
  }
}

type Ticket = {
  queuedAt: number;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: unknown) => void;
  released: Promise<void>;
};
type Lane = { queue: IterableQueueMapperSimple<Ticket>; pending: number };

/** Slots cover preparation through request cleanup, not just fetch headers.
 * Cancelled tickets stay in FIFO order as cheap tombstones. Nothing polls or
 * times them out while waiting: age is checked only when a slot is available.
 * A connection retains its limit until its queue drains, preventing a settings
 * change from creating a second set of workers for the same endpoint. */
export class EnrichmentQueue {
  private readonly lanes = new Map<string, Lane>();
  constructor(private readonly now: () => number = () => performance.now()) {}

  acquire(connectionId: string, concurrency: number, signal: AbortSignal): {
    ready: Promise<void>; release: () => void;
  } {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const ticket: Ticket = { queuedAt: this.now(), signal, resolve, reject, released };
    const aborted = (): void => reject(new DOMException("Enrichment cancelled", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    // Reject queued cancellation immediately for the UI, but do not splice the
    // package's queue. The mapper will discard this same ticket at its head.
    if (signal.aborted) aborted();
    void ready.then(
      () => signal.removeEventListener("abort", aborted),
      () => signal.removeEventListener("abort", aborted)
    );

    let lane = this.lanes.get(connectionId);
    if (!lane) {
      const created: Lane = {
        pending: 0,
        queue: new IterableQueueMapperSimple<Ticket>(async (item) => {
          try {
            item.signal.throwIfAborted();
            if (this.now() - item.queuedAt >= ENRICHMENT_QUEUE_MAX_AGE_MS) throw new EnrichmentQueueExpiredError();
            item.resolve();
            await item.released;
          } catch (error) {
            item.reject(error);
          } finally {
            this.retire(connectionId, created);
          }
        }, { concurrency })
      };
      lane = created;
      this.lanes.set(connectionId, lane);
    }
    lane.pending++;
    const owner = lane;
    // enqueue stores each ticket synchronously in FIFO order; its promise
    // waits for admission. Keep IPC responsive instead of awaiting admission.
    void lane.queue.enqueue(ticket).catch((error: unknown) => {
      reject(error);
      this.retire(connectionId, owner);
    });
    return { ready, release };
  }

  private retire(connectionId: string, lane: Lane): void {
    if (--lane.pending !== 0) return;
    this.lanes.delete(connectionId);
    // onIdle closes the package's iterator; only do so after every ticket has
    // been consumed. A later batch may now use an updated concurrency setting.
    void lane.queue.onIdle();
  }
}
