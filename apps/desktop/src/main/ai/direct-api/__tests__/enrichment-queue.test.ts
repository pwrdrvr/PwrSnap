import { expect, test, vi } from "vitest";
import { customConnectionSchema, customEnrichmentConcurrency, parseCustomAi } from "@pwrsnap/shared";
import { EnrichmentQueue, EnrichmentQueueExpiredError, ENRICHMENT_QUEUE_MAX_AGE_MS } from "../enrichment-queue";
import { CONNECTION_ID, connection } from "./fixtures";

test.each([1, 2, 4])("eight items obey a concurrency limit of %i and resume in FIFO order", async (limit) => {
  const queue = new EnrichmentQueue();
  const started: number[] = [];
  const tickets = Array.from({ length: 8 }, (_, index) => {
    const ticket = queue.acquire("one-connection", limit, new AbortController().signal);
    void ticket.ready.then(() => { started.push(index); });
    return ticket;
  });
  await vi.waitFor(() => expect(started).toHaveLength(limit));
  expect(started).toEqual(Array.from({ length: limit }, (_, i) => i));
  for (let i = 0; i < tickets.length; i++) {
    await tickets[i]!.ready;
    expect(started.length).toBeLessThanOrEqual(i + limit);
    tickets[i]!.release();
  }
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test("expired items stay queued until the head, then fail without taking a request slot", async () => {
  let now = 0;
  const queue = new EnrichmentQueue(() => now);
  const first = queue.acquire("local", 1, new AbortController().signal);
  await first.ready;
  const stale = queue.acquire("local", 1, new AbortController().signal);
  const outcome = vi.fn();
  const staleResult = stale.ready.then(outcome, (error: unknown) => { outcome(error); return error; });
  now = ENRICHMENT_QUEUE_MAX_AGE_MS;
  await Promise.resolve();
  expect(outcome).not.toHaveBeenCalled();
  const fresh = queue.acquire("local", 1, new AbortController().signal);
  first.release();
  expect(await staleResult).toBeInstanceOf(EnrichmentQueueExpiredError);
  await fresh.ready;
  fresh.release();
});

test("queued cancellation resolves immediately and leaves a tombstone that is skipped", async () => {
  const queue = new EnrichmentQueue();
  const first = queue.acquire("local", 1, new AbortController().signal);
  await first.ready;
  const controller = new AbortController();
  const canceled = queue.acquire("local", 1, controller.signal);
  const rejected = expect(canceled.ready).rejects.toMatchObject({ name: "AbortError" });
  const last = queue.acquire("local", 1, new AbortController().signal);
  controller.abort();
  await rejected;
  // No release of the canceled ticket is needed to reach the next live item.
  first.release();
  await last.ready;
  last.release();
});

test("connections are independent and changing a busy connection's limit cannot create extra workers", async () => {
  const queue = new EnrichmentQueue();
  const first = queue.acquire("a", 1, new AbortController().signal);
  await first.ready;
  const later = queue.acquire("a", 4, new AbortController().signal);
  const started = vi.fn();
  void later.ready.then(started);
  const independent = queue.acquire("b", 2, new AbortController().signal);
  await independent.ready;
  expect(started).not.toHaveBeenCalled();
  independent.release();
  first.release();
  await later.ready;
  later.release();
  // Let the last mapper retire its lane; the next batch adopts the new limit.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const next = Array.from({ length: 4 }, () => queue.acquire("a", 4, new AbortController().signal));
  await Promise.all(next.map((ticket) => ticket.ready));
  next.forEach((ticket) => ticket.release());
});

test("older connections retain their models and default locally to 1, remotely to 2; explicit limits persist", () => {
  for (const baseUrl of ["http://localhost:8080/v1", "http://127.0.0.1:18080/v1", "http://[::1]:8080/v1"]) {
    expect(customEnrichmentConcurrency({ baseUrl })).toBe(1);
  }
  expect(customEnrichmentConcurrency({ baseUrl: "https://api.example.test/v1" })).toBe(2);
  const saved = { ...connection("http://127.0.0.1:8080/v1"), id: CONNECTION_ID };
  expect(parseCustomAi([saved], []).customConnections).toEqual([saved]);
  const configured = { ...saved, enrichmentConcurrency: 4 };
  expect(parseCustomAi([configured], []).customConnections).toEqual([configured]);
  expect(customEnrichmentConcurrency(configured)).toBe(4);
  for (const enrichmentConcurrency of [0, -1, 1.5, 17, "2", null]) {
    expect(customConnectionSchema.safeParse({ ...saved, enrichmentConcurrency }).success).toBe(false);
  }
});
