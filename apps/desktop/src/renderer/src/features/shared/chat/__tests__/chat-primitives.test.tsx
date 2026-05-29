// Unit coverage for the Library chat agent-action primitives:
// ChatApprovalModal, ConfirmBatchCard, AiRunBadge.
//
// Uses the same raw react-dom/client + act harness as
// ../../__tests__/RightActivityBar.test.tsx (the project does not have
// @testing-library installed, and adding a dep is out of scope for
// these pure presentational components). The double-click guard tests
// resolve via a manually-controlled "deferred" promise so we can keep
// the component in its busy state across a second click before
// asserting the callback fired exactly once.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChatApprovalRequest } from "@pwrsnap/shared";
import { ChatApprovalModal } from "../ChatApprovalModal";
import { ConfirmBatchCard } from "../ConfirmBatchCard";
import { AiRunBadge } from "../AiRunBadge";

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

async function mount(el: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(el);
    await Promise.resolve();
  });
  return container;
}

function query<T extends HTMLElement>(el: HTMLElement, sel: string): T {
  const found = el.querySelector<T>(sel);
  if (found === null) throw new Error(`element not found: ${sel}`);
  return found;
}

// A promise whose resolution we control, so a callback can stay
// in-flight across a second click to exercise the double-click guard.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const REQUEST: ChatApprovalRequest = {
  threadId: "thread-1",
  turnId: "turn-1",
  approvalId: "appr-1",
  summary: "Run `rm tmp/scratch.png` outside the chat dir?",
  detail: "rm tmp/scratch.png"
};

describe("ChatApprovalModal", () => {
  test("clicking Approve resolves with 'approve' once", async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    const el = await mount(
      createElement(ChatApprovalModal, { request: REQUEST, onResolve })
    );
    await act(async () => {
      query(el, '[data-testid="ps-approval-approve"]').click();
      await Promise.resolve();
    });
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith("approve");
  });

  test("rapid double-click resolves only ONCE (buttons disable + ref guard)", async () => {
    const d = deferred();
    const onResolve = vi.fn(() => d.promise);
    const el = await mount(
      createElement(ChatApprovalModal, { request: REQUEST, onResolve })
    );
    const approve = query<HTMLButtonElement>(
      el,
      '[data-testid="ps-approval-approve"]'
    );
    const deny = query<HTMLButtonElement>(el, '[data-testid="ps-approval-deny"]');

    await act(async () => {
      approve.click();
      // Second click in the same busy window — guard + disabled must
      // swallow it.
      approve.click();
      deny.click();
      await Promise.resolve();
    });

    // Both buttons disabled and a spinner shows while resolving.
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    expect(el.querySelector('[data-testid="ps-approval-spinner"]')).not.toBeNull();

    await act(async () => {
      d.resolve();
      await d.promise;
      await Promise.resolve();
    });

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith("approve");
  });

  test("Escape resolves with 'deny'", async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    await mount(
      createElement(ChatApprovalModal, { request: REQUEST, onResolve })
    );
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
    });
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith("deny");
  });

  test("renders summary and optional detail in a <pre>", async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    const el = await mount(
      createElement(ChatApprovalModal, { request: REQUEST, onResolve })
    );
    expect(el.textContent).toContain(REQUEST.summary);
    const detail = query(el, '[data-testid="ps-approval-detail"]');
    expect(detail.tagName).toBe("PRE");
    expect(detail.textContent).toBe("rm tmp/scratch.png");
  });

  test("omits the detail <pre> when no detail is provided", async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    // Build a request WITHOUT the optional `detail` key (omit, don't set
    // to undefined — exactOptionalPropertyTypes rejects the latter).
    const { detail: _omitDetail, ...requestWithoutDetail } = REQUEST;
    void _omitDetail;
    const el = await mount(
      createElement(ChatApprovalModal, {
        request: requestWithoutDetail,
        onResolve
      })
    );
    expect(el.querySelector('[data-testid="ps-approval-detail"]')).toBeNull();
  });

  test("dialog exposes role=dialog with an accessible label", async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    const el = await mount(
      createElement(ChatApprovalModal, { request: REQUEST, onResolve })
    );
    const dialog = query(el, '[data-testid="ps-approval"]');
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Agent approval");
  });
});

describe("ConfirmBatchCard", () => {
  test("renders 'Apply 5 changes from the agent?'", async () => {
    const el = await mount(
      createElement(ConfirmBatchCard, {
        writeCount: 5,
        summary: "Blur 3 regions, add 2 arrows",
        onAccept: vi.fn(() => Promise.resolve()),
        onReject: vi.fn(() => Promise.resolve())
      })
    );
    expect(el.textContent).toContain("Apply 5 changes from the agent?");
    expect(el.textContent).toContain("Blur 3 regions, add 2 arrows");
  });

  test("uses singular 'change' for a count of 1", async () => {
    const el = await mount(
      createElement(ConfirmBatchCard, {
        writeCount: 1,
        summary: "Add 1 arrow",
        onAccept: vi.fn(() => Promise.resolve()),
        onReject: vi.fn(() => Promise.resolve())
      })
    );
    expect(el.textContent).toContain("Apply 1 change from the agent?");
  });

  test("Accept fires onAccept once; double-click is guarded", async () => {
    const d = deferred();
    const onAccept = vi.fn(() => d.promise);
    const onReject = vi.fn(() => Promise.resolve());
    const el = await mount(
      createElement(ConfirmBatchCard, {
        writeCount: 2,
        summary: "two changes",
        onAccept,
        onReject
      })
    );
    const accept = query<HTMLButtonElement>(
      el,
      '[data-testid="ps-confirm-batch-accept"]'
    );
    const reject = query<HTMLButtonElement>(
      el,
      '[data-testid="ps-confirm-batch-reject"]'
    );

    await act(async () => {
      accept.click();
      accept.click();
      reject.click();
      await Promise.resolve();
    });

    expect(accept.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(
      el.querySelector('[data-testid="ps-confirm-batch-spinner"]')
    ).not.toBeNull();

    await act(async () => {
      d.resolve();
      await d.promise;
      await Promise.resolve();
    });

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  test("is sticky-pinned while pending (is-pending class)", async () => {
    const el = await mount(
      createElement(ConfirmBatchCard, {
        writeCount: 3,
        summary: "three changes",
        onAccept: vi.fn(() => Promise.resolve()),
        onReject: vi.fn(() => Promise.resolve())
      })
    );
    const card = query(el, '[data-testid="ps-confirm-batch"]');
    expect(card.classList.contains("is-pending")).toBe(true);
  });
});

describe("AiRunBadge", () => {
  test("clicking calls onReject with the aiRunId once", async () => {
    const onReject = vi.fn();
    const el = await mount(
      createElement(AiRunBadge, { aiRunId: "run-42", onReject })
    );
    const badge = query<HTMLButtonElement>(el, '[data-testid="ps-airun-badge"]');
    await act(async () => {
      badge.click();
      await Promise.resolve();
    });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith("run-42");
  });

  test("exposes a default accessible label", async () => {
    const el = await mount(
      createElement(AiRunBadge, { aiRunId: "run-1", onReject: vi.fn() })
    );
    const badge = query(el, '[data-testid="ps-airun-badge"]');
    expect(badge.getAttribute("aria-label")).toBe("Reject this AI change");
  });

  test("honors a custom label override", async () => {
    const el = await mount(
      createElement(AiRunBadge, {
        aiRunId: "run-1",
        onReject: vi.fn(),
        label: "Undo blur"
      })
    );
    const badge = query(el, '[data-testid="ps-airun-badge"]');
    expect(badge.getAttribute("aria-label")).toBe("Undo blur");
  });
});
