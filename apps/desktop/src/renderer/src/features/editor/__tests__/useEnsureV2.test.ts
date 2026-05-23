// Unit tests for `useEnsureV2` — Phase 3 v1 → v2 lazy doctor
// orchestration hook.
//
// The hook is a small state machine fed by:
//   • the parent-supplied `currentBundleFormatVersion` (from
//     useCaptureModel)
//   • `v1ToV2:upgrade` dispatch responses (migrated / already_v2 /
//     parked / err)
//   • `events:v1-to-v2-doctor:progress` broadcasts (failed)
//   • `v1ToV2:status` cached-snapshot on mount (late-mount race
//     recovery)
//   • the user calling `retry()` from the view_only banner
//
// Same bare-React + createRoot + act harness as
// useCaptureModel.test.ts — no @testing-library/react.

import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from "vitest";
import { EVENT_CHANNELS, type V1ToV2DoctorProgress } from "@pwrsnap/shared";

// ---- Mocks ----------------------------------------------------------

type Resolver<T> = (value: T) => void;
type Pending<T> = { promise: Promise<T>; resolve: Resolver<T> };

function deferred<T>(): Pending<T> {
  let resolve!: Resolver<T>;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const dispatchMock = vi.fn();
const subscribers = new Map<string, Array<(payload: unknown) => void>>();

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
  subscribe: (channel: string, handler: (payload: unknown) => void) => {
    const list = subscribers.get(channel) ?? [];
    list.push(handler);
    subscribers.set(channel, list);
    return () => {
      const next = subscribers.get(channel) ?? [];
      const idx = next.indexOf(handler);
      if (idx >= 0) next.splice(idx, 1);
      subscribers.set(channel, next);
    };
  }
}));

function broadcast(channel: string, payload: unknown): void {
  const list = subscribers.get(channel) ?? [];
  for (const handler of list) handler(payload);
}

import { useEnsureV2, type UseEnsureV2Return } from "../useEnsureV2";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

// ---- Probe + render harness -----------------------------------------

type ProbeProps = {
  readonly captureId: string;
  readonly currentBundleFormatVersion: number | null;
  readonly onSnapshot: (ret: UseEnsureV2Return) => void;
};

function Probe(props: ProbeProps): null {
  const ret = useEnsureV2({
    captureId: props.captureId,
    currentBundleFormatVersion: props.currentBundleFormatVersion
  });
  const onSnapshot = useRef(props.onSnapshot);
  onSnapshot.current = props.onSnapshot;
  useEffect(() => {
    onSnapshot.current(ret);
  });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactElement): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

function rerender(node: React.ReactElement): void {
  act(() => {
    root!.render(node);
  });
}

beforeEach(() => {
  dispatchMock.mockReset();
  subscribers.clear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  if (host !== null) {
    document.body.removeChild(host);
    host = null;
  }
  root = null;
  vi.useRealTimers();
});

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ---- Tests ----------------------------------------------------------

describe("useEnsureV2", () => {
  test("1. format=2 → state.status='irrelevant' from mount; no dispatch", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:status") {
        return Promise.resolve({ ok: true, value: null });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_v2",
        currentBundleFormatVersion: 2,
        onSnapshot: (r) => {
          ret = r;
        }
      })
    );
    await flush();

    expect(ret!.state.status).toBe("irrelevant");
    const upgradeCalls = dispatchMock.mock.calls.filter(
      (c) => c[0] === "v1ToV2:upgrade"
    );
    expect(upgradeCalls.length).toBe(0);
  });

  test("2. format=1 → state.status='upgrading' immediately; dispatches v1ToV2:upgrade", async () => {
    const upgrade = deferred<unknown>();
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:upgrade") return upgrade.promise;
      if (name === "v1ToV2:status")
        return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: 1,
        onSnapshot: (r) => {
          ret = r;
        }
      })
    );
    await flush();

    expect(ret!.state.status).toBe("upgrading");
    const upgradeCalls = dispatchMock.mock.calls.filter(
      (c) => c[0] === "v1ToV2:upgrade"
    );
    expect(upgradeCalls.length).toBe(1);
    expect(upgradeCalls[0]?.[1]).toEqual({ captureId: "cap_v1" });
  });

  test("3. v1ToV2:upgrade resolves migrated:true → state flips to 'ready'", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:upgrade") {
        return Promise.resolve({ ok: true, value: { migrated: true } });
      }
      if (name === "v1ToV2:status")
        return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: 1,
        onSnapshot: (r) => {
          ret = r;
        }
      })
    );
    await flush();

    expect(ret!.state.status).toBe("ready");
  });

  test("4. v1ToV2:upgrade resolves migrated:false reason:already_v2 → state flips to 'ready'", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:upgrade") {
        return Promise.resolve({
          ok: true,
          value: { migrated: false, reason: "already_v2" }
        });
      }
      if (name === "v1ToV2:status")
        return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: 1,
        onSnapshot: (r) => {
          ret = r;
        }
      })
    );
    await flush();

    expect(ret!.state.status).toBe("ready");
  });

  test("5. v1ToV2:upgrade resolves migrated:false reason:parked → state flips to 'view_only' errorCode=parked", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:upgrade") {
        return Promise.resolve({
          ok: true,
          value: { migrated: false, reason: "parked" }
        });
      }
      if (name === "v1ToV2:status")
        return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: 1,
        onSnapshot: (r) => {
          ret = r;
        }
      })
    );
    await flush();

    const s = ret!.state;
    expect(s.status).toBe("view_only");
    if (s.status === "view_only") {
      expect(s.errorCode).toBe("parked");
      expect(s.attempts).toBe(5);
    }
  });

  test("6. v1ToV2:upgrade returns Result.err → state flips to 'view_only' with error.code", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:upgrade") {
        return Promise.resolve({
          ok: false,
          error: {
            kind: "persistence",
            code: "manifest_invalid",
            message: "bad manifest"
          }
        });
      }
      if (name === "v1ToV2:status")
        return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: 1,
        onSnapshot: (r) => {
          ret = r;
        }
      })
    );
    await flush();

    const s = ret!.state;
    expect(s.status).toBe("view_only");
    if (s.status === "view_only") {
      expect(s.errorCode).toBe("manifest_invalid");
    }
  });

  test("7. retry() dispatches v1ToV2:retry THEN v1ToV2:upgrade; state flips back to 'upgrading'", async () => {
    // First upgrade attempt → parked. After retry, the dispatch
    // sequence should be: v1ToV2:retry, then v1ToV2:upgrade.
    let upgradeCalls = 0;
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:upgrade") {
        upgradeCalls += 1;
        if (upgradeCalls === 1) {
          return Promise.resolve({
            ok: true,
            value: { migrated: false, reason: "parked" }
          });
        }
        // Second attempt: stay pending so the test can observe the
        // "upgrading" transition.
        return new Promise<unknown>(() => undefined);
      }
      if (name === "v1ToV2:retry") {
        return Promise.resolve({ ok: true, value: undefined });
      }
      if (name === "v1ToV2:status")
        return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: 1,
        onSnapshot: (r) => {
          ret = r;
        }
      })
    );
    await flush();

    expect(ret!.state.status).toBe("view_only");

    await act(async () => {
      ret!.retry();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Verify ordering: retry came before the second upgrade.
    const verbsInOrder = dispatchMock.mock.calls
      .map((c) => c[0])
      .filter((n) => n === "v1ToV2:retry" || n === "v1ToV2:upgrade");
    // [upgrade(first attempt), retry, upgrade(second attempt)]
    expect(verbsInOrder).toEqual(["v1ToV2:upgrade", "v1ToV2:retry", "v1ToV2:upgrade"]);
    expect(ret!.state.status).toBe("upgrading");
  });

  test("8. Late-mount race recovery: v1ToV2:status snapshot says failed+parked → jumps to view_only", async () => {
    const snapshot: V1ToV2DoctorProgress = {
      status: "failed",
      captureId: "cap_v1",
      errorCode: "disk_full",
      attempts: 5,
      parked: true
    };
    // For this test the format is 2 (already migrated) so the
    // upgrade dispatch path doesn't fire. We're testing that the
    // cached-snapshot reader picks up a prior failure on the SAME
    // capture id even when there's nothing to do.
    //
    // (In practice the snapshot also picks up live-edge state when
    // a v1 capture is opened just after the doctor parked it, but
    // simulating that race needs a coordinated dispatch + snapshot
    // sequence and the format-driven path is simpler.)
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:status") {
        return Promise.resolve({ ok: true, value: snapshot });
      }
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: 2,
        onSnapshot: (r) => {
          ret = r;
        }
      })
    );
    await flush();

    // The snapshot says "failed" for cap_v1; even though the
    // format-driven path would say "irrelevant", the snapshot
    // overrides because the user needs to see that the doctor
    // previously parked this capture.
    const s = ret!.state;
    expect(s.status).toBe("view_only");
    if (s.status === "view_only") {
      expect(s.errorCode).toBe("disk_full");
      expect(s.attempts).toBe(5);
    }
  });

  test("9. Cancel-safety: captureId changes mid-flight; late response from cap_a doesn't clobber cap_b's state", async () => {
    const slowA = deferred<unknown>();
    dispatchMock.mockImplementation((name: string, req: { captureId?: string }) => {
      if (name === "v1ToV2:upgrade") {
        if (req.captureId === "cap_a") return slowA.promise;
        if (req.captureId === "cap_b") {
          // Fast resolution to 'ready'.
          return Promise.resolve({ ok: true, value: { migrated: true } });
        }
      }
      if (name === "v1ToV2:status")
        return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    const onSnapshot = (r: UseEnsureV2Return): void => {
      ret = r;
    };

    render(
      createElement(Probe, {
        captureId: "cap_a",
        currentBundleFormatVersion: 1,
        onSnapshot
      })
    );
    expect(ret!.state.status).toBe("upgrading");

    // Switch to cap_b before cap_a's upgrade resolves.
    rerender(
      createElement(Probe, {
        captureId: "cap_b",
        currentBundleFormatVersion: 1,
        onSnapshot
      })
    );
    await flush();

    // cap_b loaded → ready.
    expect(ret!.state.status).toBe("ready");

    // NOW resolve cap_a's slow upgrade as PARKED. Must NOT clobber
    // cap_b's "ready" state.
    await act(async () => {
      slowA.resolve({ ok: true, value: { migrated: false, reason: "parked" } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ret!.state.status).toBe("ready");
  });

  test("10. Progress event filtering: 'failed' for ANOTHER captureId is ignored", async () => {
    // Keep the dispatch pending so the hook stays in "upgrading"
    // state — that way we can observe whether a stray progress
    // event flips us to view_only.
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:upgrade") {
        return new Promise<unknown>(() => undefined);
      }
      if (name === "v1ToV2:status")
        return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: 1,
        onSnapshot: (r) => {
          ret = r;
        }
      })
    );
    await flush();

    expect(ret!.state.status).toBe("upgrading");

    // Broadcast a "failed" event for SOME OTHER capture. The hook
    // should ignore it.
    await act(async () => {
      broadcast(EVENT_CHANNELS.v1ToV2DoctorProgress, {
        status: "failed",
        captureId: "cap_other",
        errorCode: "manifest_invalid",
        attempts: 5,
        parked: true
      } satisfies V1ToV2DoctorProgress);
      await Promise.resolve();
    });

    expect(ret!.state.status).toBe("upgrading");

    // Broadcast a "failed" event for OUR capture → flips to view_only.
    await act(async () => {
      broadcast(EVENT_CHANNELS.v1ToV2DoctorProgress, {
        status: "failed",
        captureId: "cap_v1",
        errorCode: "manifest_invalid",
        attempts: 5,
        parked: true
      } satisfies V1ToV2DoctorProgress);
      await Promise.resolve();
    });

    const s = ret!.state;
    expect(s.status).toBe("view_only");
    if (s.status === "view_only") {
      expect(s.errorCode).toBe("manifest_invalid");
      expect(s.attempts).toBe(5);
    }
  });

  test("11. boot-time global progress event (captureId === null) is ignored", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:upgrade") {
        return new Promise<unknown>(() => undefined);
      }
      if (name === "v1ToV2:status")
        return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: 1,
        onSnapshot: (r) => {
          ret = r;
        }
      })
    );
    await flush();

    // Boot-time sweep emits captureId === null. Must NOT flip us.
    await act(async () => {
      broadcast(EVENT_CHANNELS.v1ToV2DoctorProgress, {
        status: "running",
        captureId: null,
        total: 10,
        done: 1,
        failed: 0
      } satisfies V1ToV2DoctorProgress);
      await Promise.resolve();
    });

    expect(ret!.state.status).toBe("upgrading");
  });

  test("12. format=null on mount, then resolves to 1 → flips to 'upgrading'", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "v1ToV2:upgrade") {
        return new Promise<unknown>(() => undefined);
      }
      if (name === "v1ToV2:status")
        return Promise.resolve({ ok: true, value: null });
      return Promise.resolve({ ok: true, value: null });
    });

    let ret: UseEnsureV2Return | null = null;
    const onSnapshot = (r: UseEnsureV2Return): void => {
      ret = r;
    };
    render(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: null,
        onSnapshot
      })
    );
    await flush();

    // Initial state is "irrelevant" (the default for null — see
    // initialStateFor). Once the parent re-renders with format=1,
    // the effect fires the dispatch.
    expect(ret!.state.status).toBe("irrelevant");

    rerender(
      createElement(Probe, {
        captureId: "cap_v1",
        currentBundleFormatVersion: 1,
        onSnapshot
      })
    );
    await flush();

    expect(ret!.state.status).toBe("upgrading");
    const upgradeCalls = dispatchMock.mock.calls.filter(
      (c) => c[0] === "v1ToV2:upgrade"
    );
    expect(upgradeCalls.length).toBe(1);
  });
});
