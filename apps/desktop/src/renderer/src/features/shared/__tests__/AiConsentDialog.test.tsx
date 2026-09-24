// Focus contract for the AI-enrichment consent dialog.
//
// `aria-modal` describes the accessibility tree; it does not move or
// hold focus. Before this, focus stayed on the switch that opened the
// dialog — under the backdrop — and Tab walked on through the page
// behind it with every ring hidden. Pins the three halves of the fix:
//
//   • opening moves focus to Cancel (the safe choice);
//   • focus that escapes the dialog is pulled back to Cancel;
//   • closing hands focus back to whatever had it before.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { AiConsentDialog } from "../AiConsentDialog";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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
  document.body.innerHTML = "";
});

async function openDialog(): Promise<{ opener: HTMLButtonElement; behind: HTMLButtonElement }> {
  const opener = document.createElement("button");
  opener.textContent = "AI";
  const behind = document.createElement("button");
  behind.textContent = "Behind the backdrop";
  document.body.append(opener, behind);
  opener.focus();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(AiConsentDialog, { onAccept: vi.fn(), onCancel: vi.fn() }));
  });
  return { opener, behind };
}

function cancelButton(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(".ps-ai-consent__btn:not(.is-primary)");
  if (el === null) throw new Error("Cancel not rendered");
  return el;
}

describe("AiConsentDialog focus", () => {
  test("opening moves focus to Cancel", async () => {
    await openDialog();
    expect(document.activeElement).toBe(cancelButton());
  });

  test("focus moving between the dialog's own buttons stays put", async () => {
    await openDialog();
    const enable = document.querySelector<HTMLButtonElement>(".ps-ai-consent__btn.is-primary");
    await act(async () => {
      enable?.focus();
    });
    expect(document.activeElement).toBe(enable);
  });

  test("focus escaping to the page behind is pulled back to Cancel", async () => {
    const { behind } = await openDialog();
    await act(async () => {
      behind.focus();
    });
    expect(document.activeElement).toBe(cancelButton());
  });

  test("closing hands focus back to the control that opened it", async () => {
    const { opener } = await openDialog();
    await act(async () => {
      root?.unmount();
    });
    root = null;
    expect(document.activeElement).toBe(opener);
  });
});
