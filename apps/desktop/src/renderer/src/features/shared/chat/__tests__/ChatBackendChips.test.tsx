// @vitest-environment jsdom
// Unit coverage for the editable Provider / Model / Reasoning chips.
// Uses the repo's raw react-dom/client + act convention; no testing-library.

import { act, createElement, useState, type ReactElement } from "react";
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

  const initialValue: ChatBackendChoice = {
    provider: "codex",
    model: null,
    reasoning: "medium"
  };
  function Harness(): ReactElement {
    const [value, setValue] = useState<ChatBackendChoice>(initialValue);
    return createElement(NewChatConfigChips, {
      providers: ["codex"],
      value,
      onChange: setValue
    });
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness));
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

  test("Codex model picker selects the live image-capable default model", async () => {
    const el = await mountWithModels([
      {
        id: "gpt-5.3-codex-spark",
        model: "gpt-5.3-codex-spark",
        displayName: "GPT-5.3-Codex-Spark",
        description: "",
        hidden: false,
        inputModalities: ["text"],
        defaultServiceTier: null,
        isDefault: false
      },
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "",
        hidden: false,
        inputModalities: ["text", "image"],
        defaultServiceTier: null,
        isDefault: true
      }
    ]);
    const modelSelect = el.querySelector<HTMLSelectElement>(
      'select[aria-label="New chat model"]'
    );
    expect(modelSelect).not.toBeNull();
    if (modelSelect === null) return;

    expect(modelSelect.value).toBe("gpt-5.5");
    expect(
      Array.from(modelSelect.options).some((option) => option.value === "gpt-5.3-codex-spark")
    ).toBe(false);
  });

  test("Codex reasoning picker follows the selected model's advertised efforts", async () => {
    const el = await mountWithModels([
      {
        id: "gpt-5.6-terra",
        model: "gpt-5.6-terra",
        displayName: "GPT-5.6-Terra",
        description: "",
        hidden: false,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        defaultServiceTier: null,
        isDefault: true
      }
    ]);

    const reasoningSelect = el.querySelector<HTMLSelectElement>(
      'select[aria-label="New chat reasoning"]'
    );
    expect(reasoningSelect).not.toBeNull();
    if (reasoningSelect === null) return;

    expect(Array.from(reasoningSelect.options).map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ]);
  });
});
