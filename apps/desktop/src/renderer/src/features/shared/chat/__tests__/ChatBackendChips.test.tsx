// @vitest-environment jsdom
// Unit coverage for the editable Provider / Model / Reasoning chips.
// Uses the repo's raw react-dom/client + act convention; no testing-library.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { CODEX_CAPTION_MODELS } from "@pwrsnap/shared";
import {
  NewChatConfigChips,
  type ChatBackendChoice
} from "../ChatBackendChips";

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
  delete window.pwrsnapApi;
});

async function mountWithModels(models: unknown[]): Promise<HTMLDivElement> {
  window.pwrsnapApi = {
    dispatch: vi.fn(async (name: string) => {
      if (name === "codex:models") return { ok: true, value: { models } };
      return { ok: true, value: undefined };
    }),
    on: () => () => undefined,
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;

  const value: ChatBackendChoice = {
    provider: "codex",
    model: null,
    reasoning: "medium"
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(NewChatConfigChips, {
        providers: ["codex"],
        value,
        onChange: vi.fn()
      })
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

describe("NewChatConfigChips", () => {
  test("Codex model picker falls back when live model list is empty", async () => {
    const el = await mountWithModels([]);
    const modelSelect = el.querySelector<HTMLSelectElement>(
      'select[aria-label="New chat model"]'
    );
    expect(modelSelect).not.toBeNull();
    if (modelSelect === null) return;

    const options = Array.from(modelSelect.options).map((option) => ({
      value: option.value,
      disabled: option.disabled
    }));
    expect(options).toContainEqual({ value: "", disabled: true });
    for (const model of CODEX_CAPTION_MODELS) {
      expect(options).toContainEqual({ value: model, disabled: false });
    }
    expect(modelSelect.disabled).toBe(false);
  });
});
