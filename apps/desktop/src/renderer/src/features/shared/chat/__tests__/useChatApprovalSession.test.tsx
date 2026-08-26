// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type {
  ChatApprovalDecision,
  ChatApprovalRequest,
  PwrSnapError,
  Result
} from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { useChatApprovalSession } from "../useChatApprovalSession";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type Handler = (payload: unknown) => void;
type Submit = (
  request: ChatApprovalRequest,
  decision: ChatApprovalDecision
) => Promise<Result<void, PwrSnapError>>;

const REQUEST_A: ChatApprovalRequest = {
  threadId: "thread-1",
  turnId: "turn-1",
  approvalId: "approval-1",
  summary: "Run a command?",
  detail: "command --flag"
};
const REQUEST_B: ChatApprovalRequest = {
  threadId: "thread-1",
  turnId: "turn-2",
  approvalId: "approval-2",
  summary: "Write a file?"
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let handlers: Map<string, Set<Handler>>;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function installApi(): void {
  handlers = new Map();
  window.pwrsnapApi = {
    dispatch: vi.fn(),
    on: (channel: string, handler: Handler): (() => void) => {
      const current = handlers.get(channel) ?? new Set<Handler>();
      current.add(handler);
      handlers.set(channel, current);
      return () => current.delete(handler);
    },
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
}

function emit(channel: string, payload: unknown): void {
  for (const handler of handlers.get(channel) ?? []) handler(payload);
}

function Harness(props: {
  activeThreadId?: string | null;
  pendingApproval?: ChatApprovalRequest | null;
  submit: Submit;
}): ReactElement {
  const session = useChatApprovalSession({
    activeThreadId: props.activeThreadId ?? "thread-1",
    pendingApproval: props.pendingApproval ?? null,
    requestedChannel: EVENT_CHANNELS.libraryChatApprovalRequested,
    resolvedChannel: EVENT_CHANNELS.libraryChatApprovalResolved,
    supersededChannel: EVENT_CHANNELS.libraryChatApprovalSuperseded,
    submit: props.submit
  });
  return (
    <div>
      <span data-testid="request">{session.request?.approvalId ?? "none"}</span>
      <span data-testid="phase">{session.phase}</span>
      <span data-testid="error">{session.errorMessage ?? ""}</span>
      <button
        data-testid="approve"
        disabled={session.phase === "submitting"}
        onClick={() => void session.resolve("approve")}
      >
        Approve
      </button>
      <button
        data-testid="deny"
        disabled={session.phase === "submitting"}
        onClick={() => void session.resolve("deny")}
      >
        Deny
      </button>
      <button
        data-testid="retry"
        disabled={session.retryDecision === null || session.phase === "submitting"}
        onClick={() => void session.resolve(session.retryDecision ?? "deny")}
      >
        Retry
      </button>
    </div>
  );
}

function WindowHarness(props: { id: string; submit: Submit }): ReactElement {
  const session = useChatApprovalSession({
    activeThreadId: REQUEST_A.threadId,
    pendingApproval: REQUEST_A,
    requestedChannel: EVENT_CHANNELS.libraryChatApprovalRequested,
    resolvedChannel: EVENT_CHANNELS.libraryChatApprovalResolved,
    supersededChannel: EVENT_CHANNELS.libraryChatApprovalSuperseded,
    submit: props.submit
  });
  return (
    <section>
      <span data-testid={`${props.id}-request`}>
        {session.request?.approvalId ?? "none"}
      </span>
      <button
        data-testid={`${props.id}-approve`}
        onClick={() => void session.resolve("approve")}
      >
        Approve
      </button>
    </section>
  );
}

async function mount(element: ReactElement): Promise<HTMLDivElement> {
  installApi();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
    await Promise.resolve();
  });
  return container;
}

function text(testId: string): string {
  return container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

function click(testId: string): void {
  container?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useChatApprovalSession", () => {
  test("rehydrates an exact pending request after unmount/remount without denying it", async () => {
    const submit = vi.fn<Submit>();
    await mount(<Harness pendingApproval={REQUEST_A} submit={submit} />);
    expect(text("request")).toBe("approval-1");

    await act(async () => root?.unmount());
    expect(submit).not.toHaveBeenCalled();
    expect(handlers.get(EVENT_CHANNELS.libraryChatApprovalRequested)?.size ?? 0).toBe(0);

    root = createRoot(container!);
    await act(async () => {
      root?.render(<Harness pendingApproval={REQUEST_A} submit={submit} />);
      await Promise.resolve();
    });
    expect(text("request")).toBe("approval-1");
    expect(submit).not.toHaveBeenCalled();
  });

  test("ignores a late submission failure after unmount and replays from main on remount", async () => {
    const response = deferred<Result<void, PwrSnapError>>();
    const submit = vi.fn<Submit>(() => response.promise);
    await mount(<Harness pendingApproval={REQUEST_A} submit={submit} />);

    await act(async () => {
      click("approve");
      await Promise.resolve();
    });
    expect(text("phase")).toBe("submitting");

    await act(async () => root?.unmount());
    response.resolve({
      ok: false,
      error: { kind: "ai", code: "transport_failed", message: "raw private error" }
    });
    await response.promise;

    root = createRoot(container!);
    await act(async () => {
      root?.render(<Harness pendingApproval={REQUEST_A} submit={submit} />);
      await Promise.resolve();
    });
    expect(text("request")).toBe(REQUEST_A.approvalId);
    expect(text("phase")).toBe("pending");
    expect(text("error")).toBe("");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("keeps success submitting until the exact resolved event and guards duplicate clicks", async () => {
    const response = deferred<Result<void, PwrSnapError>>();
    const submit = vi.fn<Submit>(() => response.promise);
    await mount(<Harness pendingApproval={REQUEST_A} submit={submit} />);

    await act(async () => {
      click("approve");
      click("approve");
      click("deny");
      await Promise.resolve();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(REQUEST_A, "approve");
    expect(text("phase")).toBe("submitting");

    await act(async () => {
      response.resolve({ ok: true, value: undefined });
      await response.promise;
      await Promise.resolve();
    });
    expect(text("phase")).toBe("submitting");
    expect(text("request")).toBe("approval-1");

    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatApprovalResolved, {
        threadId: REQUEST_A.threadId,
        turnId: REQUEST_A.turnId,
        approvalId: REQUEST_A.approvalId,
        decision: "approve"
      });
    });
    expect(text("request")).toBe("none");
    expect(text("phase")).toBe("idle");

    // Even if a lagging thread view still carries the old detail, navigating
    // away and back must not resurrect a request made terminal by the event.
    await act(async () => {
      root?.render(<Harness activeThreadId="other-thread" submit={submit} />);
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(<Harness pendingApproval={REQUEST_A} submit={submit} />);
      await Promise.resolve();
    });
    expect(text("request")).toBe("none");
  });

  test("a resolution submitted in one window clears the exact request in every window", async () => {
    const submitA = vi.fn<Submit>().mockResolvedValue({ ok: true, value: undefined });
    const submitB = vi.fn<Submit>().mockResolvedValue({ ok: true, value: undefined });
    await mount(
      <>
        <WindowHarness id="window-a" submit={submitA} />
        <WindowHarness id="window-b" submit={submitB} />
      </>
    );

    expect(text("window-a-request")).toBe(REQUEST_A.approvalId);
    expect(text("window-b-request")).toBe(REQUEST_A.approvalId);
    await act(async () => {
      click("window-a-approve");
      await Promise.resolve();
    });
    expect(submitA).toHaveBeenCalledTimes(1);
    expect(submitB).not.toHaveBeenCalled();

    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatApprovalResolved, {
        threadId: REQUEST_A.threadId,
        turnId: REQUEST_A.turnId,
        approvalId: REQUEST_A.approvalId,
        decision: "approve"
      });
    });
    expect(text("window-a-request")).toBe("none");
    expect(text("window-b-request")).toBe("none");
  });

  test("a late requested broadcast cannot resurrect a request resolved from replay in another window", async () => {
    const submitA = vi.fn<Submit>().mockResolvedValue({ ok: true, value: undefined });
    const submitB = vi.fn<Submit>().mockResolvedValue({ ok: true, value: undefined });
    await mount(
      <>
        <WindowHarness id="window-a" submit={submitA} />
        <WindowHarness id="window-b" submit={submitB} />
      </>
    );

    // Both windows hydrated the broker's pending view before the adapter's
    // one-shot approvalRequested broadcast. Window A resolves that replay.
    await act(async () => {
      click("window-a-approve");
      await Promise.resolve();
      emit(EVENT_CHANNELS.libraryChatApprovalResolved, {
        threadId: REQUEST_A.threadId,
        turnId: REQUEST_A.turnId,
        approvalId: REQUEST_A.approvalId,
        decision: "approve"
      });
    });
    expect(text("window-a-request")).toBe("none");
    expect(text("window-b-request")).toBe("none");

    // The delayed adapter event for the same immutable broker identity must
    // not clear the terminal tombstone or reopen either modal.
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatApprovalRequested, REQUEST_A);
    });
    expect(text("window-a-request")).toBe("none");
    expect(text("window-b-request")).toBe("none");
    expect(submitA).toHaveBeenCalledTimes(1);
    expect(submitB).not.toHaveBeenCalled();
  });

  test("keeps a Result failure visible with sanitized retry and can safely deny", async () => {
    const submit = vi
      .fn<Submit>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "ai",
          code: "approval_transport_failed",
          message: "SECRET /Users/person/private plus raw tool args",
          cause: { arguments: "secret" }
        }
      })
      .mockResolvedValue({ ok: true, value: undefined });
    await mount(<Harness pendingApproval={REQUEST_A} submit={submit} />);

    await act(async () => {
      click("approve");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text("request")).toBe("approval-1");
    expect(text("phase")).toBe("pending");
    expect(text("error")).toContain("request is still pending");
    expect(text("error")).not.toContain("SECRET");

    await act(async () => {
      click("deny");
      await Promise.resolve();
    });
    expect(submit).toHaveBeenNthCalledWith(2, REQUEST_A, "deny");
  });

  test("turns a thrown transport failure into the same retryable sanitized state", async () => {
    const submit = vi.fn<Submit>().mockRejectedValue(new Error("raw socket and tool payload"));
    await mount(<Harness pendingApproval={REQUEST_A} submit={submit} />);

    await act(async () => {
      click("approve");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text("request")).toBe("approval-1");
    expect(text("phase")).toBe("pending");
    expect(text("error")).not.toContain("raw socket");

    await act(async () => {
      click("retry");
      await Promise.resolve();
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith(REQUEST_A, "approve");
  });

  test("a newer request survives stale terminal events and a late failure for the old request", async () => {
    const oldResponse = deferred<Result<void, PwrSnapError>>();
    const submit = vi.fn<Submit>(() => oldResponse.promise);
    await mount(<Harness pendingApproval={REQUEST_A} submit={submit} />);

    await act(async () => {
      click("approve");
      emit(EVENT_CHANNELS.libraryChatApprovalRequested, REQUEST_B);
    });
    expect(text("request")).toBe("approval-2");

    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatApprovalSuperseded, {
        threadId: REQUEST_A.threadId,
        turnId: REQUEST_A.turnId,
        approvalId: REQUEST_A.approvalId,
        reason: "request_replaced"
      });
      oldResponse.resolve({
        ok: false,
        error: { kind: "ai", code: "stale", message: "old failure" }
      });
      await oldResponse.promise;
      await Promise.resolve();
    });
    expect(text("request")).toBe("approval-2");
    expect(text("error")).toBe("");
  });

  test("ignores requests for an inactive thread and clears only an exact terminal identity", async () => {
    const submit = vi.fn<Submit>();
    await mount(<Harness submit={submit} />);
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatApprovalRequested, {
        ...REQUEST_A,
        threadId: "other-thread"
      });
    });
    expect(text("request")).toBe("none");

    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatApprovalRequested, REQUEST_A);
      emit(EVENT_CHANNELS.libraryChatApprovalResolved, {
        threadId: REQUEST_A.threadId,
        turnId: REQUEST_A.turnId,
        approvalId: "different-approval",
        decision: "deny"
      });
    });
    expect(text("request")).toBe("approval-1");
  });
});
