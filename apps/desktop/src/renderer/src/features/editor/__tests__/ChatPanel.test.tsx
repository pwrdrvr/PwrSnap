// Unit-level coverage for the ChatPanel placeholder surface. The
// component is deliberately stub-y until the Codex dynamic-tools
// IPC lands, so these tests pin down the surface contract that
// the IPC PR is supposed to plug into:
//
//   • Context chip reflects the capture's dims + layer count.
//   • Composer is wired: empty Enter is a no-op, content Enter
//     pushes a user message + a placeholder Codex response.
//   • Welcome card disappears as soon as a message exists.
//
// The actual Codex round-trip is not exercised here — the panel
// today appends a hard-coded placeholder response so the Send
// click has a visible effect.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi
} from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";
import { ChatPanel } from "../panels/ChatPanel";

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
});

const baseRecord: CaptureRecord = {
  id: "cap_chat_1",
  kind: "image",
  captured_at: "2026-05-25T10:00:00.000Z",
  legacy_src_path: "/tmp/cap_chat_1.png",
  bundle_path: null,
  flat_png_path: null,
  bundle_modified_at: null,
  bundle_format_version: 2,
  bundle_edits_version: 1,
  width_px: 2246,
  height_px: 1496,
  device_pixel_ratio: 2,
  byte_size: 412_344,
  sha256: "sha_chat",
  source_app_bundle_id: "com.google.Chrome",
  source_app_name: "Chrome",
  edits_version: 1,
  deleted_at: null
};

interface RenderArgs {
  record?: CaptureRecord | null;
  layerCount?: number;
  ocrText?: string | null;
}

async function renderPanel(
  args: RenderArgs = {}
): Promise<{ el: HTMLDivElement; dispatch: ReturnType<typeof vi.fn> }> {
  const record = args.record === undefined ? baseRecord : args.record;
  const layerCount = args.layerCount ?? 8;
  const ocrText = args.ocrText ?? null;
  const layers = new Array(layerCount).fill(null).map((_, i) => ({
    id: `lyr_${i}`
  }));

  const dispatch = vi.fn(async (name: string) => {
    if (name === "library:byId")
      return { ok: true, value: record };
    if (name === "layers:list") return { ok: true, value: layers };
    if (name === "codex:enrichment") {
      return {
        ok: true,
        value: ocrText !== null ? { captureId: "cap_chat_1", ocrText } : null
      };
    }
    return { ok: true, value: undefined };
  });
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on: () => () => undefined,
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ChatPanel, { captureId: "cap_chat_1" }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { el: container, dispatch };
}

describe("ChatPanel", () => {
  test("renders capture context chip with layer count + dimensions", async () => {
    const { el } = await renderPanel({ layerCount: 8 });
    const chip = el.querySelector('[data-testid="chat-context"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("8 layers");
    expect(chip?.textContent).toContain("2246×1496");
  });

  test("welcome card renders when there are no messages", async () => {
    const { el } = await renderPanel();
    expect(el.querySelector(".pse-chat-welcome")).not.toBeNull();
  });

  test("Send button is disabled when the composer is empty", async () => {
    const { el } = await renderPanel();
    const send = el.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send"]'
    );
    expect(send).not.toBeNull();
    expect(send?.disabled).toBe(true);
  });

  test("Submitting a non-empty draft appends a user message + placeholder Codex response", async () => {
    const { el } = await renderPanel();
    const textarea = el.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-input"]'
    );
    expect(textarea).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(textarea, "make the arrows orange");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    const send = el.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send"]'
    );
    expect(send?.disabled).toBe(false);

    await act(async () => {
      send?.click();
      await Promise.resolve();
    });

    // Welcome card is gone, two messages exist.
    expect(el.querySelector(".pse-chat-welcome")).toBeNull();
    const userMsg = el.querySelector('[data-testid="chat-msg-you"]');
    const codexMsg = el.querySelector('[data-testid="chat-msg-codex"]');
    expect(userMsg).not.toBeNull();
    expect(codexMsg).not.toBeNull();
    expect(userMsg?.textContent).toContain("make the arrows orange");
    // Textarea is cleared after submit.
    expect(textarea?.value).toBe("");
  });

  test("Enter without shift submits; Shift+Enter inserts newline", async () => {
    const { el } = await renderPanel();
    const textarea = el.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-input"]'
    );
    expect(textarea).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(textarea, "hello");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    // Shift+Enter does not submit; textarea keeps its text.
    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true
        })
      );
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="chat-msg-you"]')).toBeNull();

    // Plain Enter submits.
    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="chat-msg-you"]')?.textContent).toContain(
      "hello"
    );
  });

  test("Empty / whitespace-only submissions are ignored", async () => {
    const { el } = await renderPanel();
    const textarea = el.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-input"]'
    );
    const send = el.querySelector<HTMLButtonElement>(
      '[data-testid="chat-send"]'
    );

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(textarea, "   \n\t  ");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    expect(send?.disabled).toBe(true);
    await act(async () => {
      // Even forcing a click does nothing.
      send?.click();
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="chat-msg-you"]')).toBeNull();
  });

  test("error state when capture is missing", async () => {
    const { el } = await renderPanel({ record: null });
    expect(el.textContent).toContain("Couldn");
  });

  test("v1 captures report 0 layers without calling layers:list", async () => {
    const v1Record = { ...baseRecord, bundle_format_version: 1 };
    const { el, dispatch } = await renderPanel({ record: v1Record });
    const chip = el.querySelector('[data-testid="chat-context"]');
    expect(chip?.textContent).toContain("0 layers");
    const layerCalls = dispatch.mock.calls.filter(([n]) => n === "layers:list");
    expect(layerCalls.length).toBe(0);
  });

  test("OCR chip surfaces when enrichment has extracted text", async () => {
    const { el } = await renderPanel({ ocrText: "some extracted page text" });
    const ocrChip = el.querySelector('[data-testid="chat-context-ocr-chip"]');
    expect(ocrChip).not.toBeNull();
  });

  test("OCR chip is absent when enrichment has no text", async () => {
    const { el } = await renderPanel({ ocrText: null });
    expect(el.querySelector('[data-testid="chat-context-ocr-chip"]')).toBeNull();
  });

  test("Codex messages carry a model badge ('pending' until IPC lands)", async () => {
    const { el } = await renderPanel();
    const textarea = el.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-input"]'
    );
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(textarea, "hi");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')?.click();
      await Promise.resolve();
    });
    const codexMsg = el.querySelector('[data-testid="chat-msg-codex"]');
    expect(codexMsg?.querySelector(".pse-chat-msg-model")?.textContent).toBe(
      "pending"
    );
  });
});
