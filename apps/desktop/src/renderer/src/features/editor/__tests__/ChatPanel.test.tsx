// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ChatPanel } from "../panels/ChatPanel";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderPanel(captureId = "cap_chat_1"): Promise<{
  el: HTMLDivElement;
  dispatch: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}> {
  const dispatch = vi.fn();
  const on = vi.fn(() => () => undefined);
  window.pwrsnapApi = {
    dispatch,
    on,
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ChatPanel, { captureId }));
  });
  return { el: container, dispatch, on };
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  delete window.pwrsnapApi;
});

describe("Editor ChatPanel", () => {
  test("truthfully labels the dedicated per-capture surface unavailable", async () => {
    const { el } = await renderPanel();
    const panel = el.querySelector('[data-testid="chat-panel"]');

    expect(panel?.getAttribute("data-capture-id")).toBe("cap_chat_1");
    expect(panel?.textContent).toContain("Editor chat is unavailable");
    expect(panel?.textContent).toContain(
      "Per-capture Editor chat is not available in this standalone editor yet."
    );
    expect(panel?.textContent).toContain("Library chat has broader access");
  });

  test("does not expose a composer or fabricate assistant output", async () => {
    const { el } = await renderPanel();

    expect(el.querySelector("textarea")).toBeNull();
    expect(el.querySelector('[data-testid="composer-send"]')).toBeNull();
    expect(el.querySelector('[data-role="assistant"]')).toBeNull();
    expect(el.textContent).not.toContain("Dynamic tools aren't wired to AI yet");
  });

  test("does not dispatch Library commands or install chat subscriptions", async () => {
    const { dispatch, on } = await renderPanel();

    expect(dispatch).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });
});
