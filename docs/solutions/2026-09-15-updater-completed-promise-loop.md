# Updater waits must have a finite retry budget

A user reported a hung PwrSnap 1.1.0 process with many copies of this log
within the same millisecond:

```text
waiting for in-flight update check before switching selection
{ trigger: 'periodic', inFlightSelection: undefined,
  updateChannel: 'latest', updateTrain: 'stable' }
```

The updater previously awaited the in-flight promise, then recursively called
`checkForAppUpdatesNow`. If a settled promise remained installed with no
selection, every recursive call awaited the same completed promise. This
keeps scheduling microtasks without giving timers, IPC, or window events a
chance to run. A timeout alone cannot break that loop.

An older async-IIFE assignment could leave exactly that state: its synchronous
fast path cleared the slot in `finally` before the caller assigned the returned
promise. The existing deferred-start fix and downloaded-update regression test
already exist in the **v1.1.0 tag**. The stable-promotion work in #604 concerns
release selection, not this retry guard. We have reproduced the invalid state
by fault injection, but have not established how the reported binary entered
it or confirmed its running build identity. Do not claim the old assignment
race is proven to be the cause of this particular report.

`waitForUpdateCheckSlot` now detects a completed promise still occupying the
slot and permits at most eight waits if other callers keep replacing it. It
returns an error through the updater's existing result/status path rather than
starting overlapping updater operations. Downloaded/install-failed statuses
remain protected by `setUpdateStatusUnlessActionable`. The guard does not
cancel or time out network operations: pending I/O yields to the event loop.

The start callback reserves the slot synchronously. Returning an empty-slot
answer and awaiting it in the caller would introduce a new concurrency race.
Tests cover that reservation, same-selection joining, success/failure cleanup,
orphaned fulfilled/rejected promises, continuous replacement, and the main
updater's error response. Removing the two guard conditions makes the three
fault-injection cases fail; their own log-count circuit breaker prevents a
regression from hanging the test worker.
