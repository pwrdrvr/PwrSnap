# Updater spins on a completed check promise

## Evidence

PwrSnap 1.1.0-alpha.11 crashed on macOS on 2026-09-09 at 18:57:01
(UTC-04:00), with SIGTRAP on CrBrowserMain in Electron 41.10.3.
The surviving main.log and main.old.log contained 6,213 repetitions of
`waiting for in-flight update check before switching selection` between
18:56:59.528 and 18:56:59.882. The selection was prerelease/beta;
`inFlightSelection` was absent. Log rotation had overwritten earlier context.

A second machine reportedly hung and required force quit that day. Its logs
were not available for this investigation, so a shared cause is unconfirmed.
The native stack has not been symbolicated; the exact fatal assertion or
allocation failure is not established by the updater reproduction.

## Cause

`checkForAppUpdatesNow` assigned an immediately invoked async function's
promise to `updateCheckInFlight`. Its already-downloaded fast path returned
before the first await. The finally block cleared both in-flight fields
synchronously, then the outer assignment installed the completed promise
again, leaving its selection undefined.

The next check treated this as a different selection still in flight,
awaited the completed promise, and recursively retried forever. This loop
starves the event loop, floods logs, and retains pending async calls.
A synchronous error before the first await could leave the same stale slot.

## Fix and verification

Schedule the check body with `Promise.resolve().then(...)` so the shared
promise is installed before any body or cleanup can run. Existing same-
selection joining and cross-selection serialization remain in place.

The updater regression test downloads an update, runs repeated periodic
checks, then checks another train. Its logger throws after five wait-loop
messages so the unfixed code fails without starving the test timeout.
The test failed on the old code with the completed-promise spin and passed
with the fix. All 25 updater tests and desktop TypeScript checking passed.

This is strong application-level evidence for the local failure, not proof
of the native crash's terminal mechanism. A matching updater log flood on
the other machine would connect its hang to this bug.
