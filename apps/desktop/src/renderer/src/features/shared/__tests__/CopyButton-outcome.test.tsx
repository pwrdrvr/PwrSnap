// A copy card may only say "Copied" when the copy happened. The toast,
// the tray and the Library all dispatch `clipboard:copy`, and main can
// refuse it (a render failure, a clipboard that does not answer). Before
// this, the card flashed "Copied" on every click and dropped the result,
// so a copy that never reached the clipboard looked identical to one
// that did, and the user was left pasting nothing.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { CopyButton, type CopyOutcome } from "../CopyButton";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

type Deferred = { promise: Promise<CopyOutcome>; resolve: (outcome: CopyOutcome) => void };

function deferred(): Deferred {
  let resolve!: (outcome: CopyOutcome) => void;
  const promise = new Promise<CopyOutcome>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function mount(props: {
  onCopy: () => Promise<CopyOutcome>;
  onCopyPath?: () => Promise<CopyOutcome>;
}): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(CopyButton, {
        preset: "high",
        label: "High",
        dim: "1931 × 1410",
        bytes: "270 KB",
        onCopy: props.onCopy,
        ...(props.onCopyPath !== undefined ? { onCopyPath: props.onCopyPath } : {})
      })
    );
  });
  return container;
}

function card(el: HTMLElement): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>(".fo__copy-btn")!;
}

describe("CopyButton copy outcome", () => {
  test("says Copied only after the copy succeeds", async () => {
    const pending = deferred();
    const el = await mount({ onCopy: () => pending.promise });

    await act(async () => card(el).click());
    expect(card(el).classList.contains("is-copied")).toBe(false);
    expect(card(el).getAttribute("aria-busy")).toBe("true");

    await act(async () => pending.resolve({ ok: true }));
    expect(card(el).classList.contains("is-copied")).toBe(true);
    expect(card(el).hasAttribute("aria-busy")).toBe(false);
  });

  test("a refused copy shows Failed with the reason, never Copied", async () => {
    const el = await mount({
      onCopy: async () => ({
        ok: false,
        error: { message: "The macOS clipboard did not respond. Please try copying again." }
      })
    });

    await act(async () => card(el).click());
    expect(card(el).classList.contains("is-copied")).toBe(false);
    expect(card(el).classList.contains("is-error")).toBe(true);
    expect(card(el).textContent).toContain("Failed");
    expect(card(el).getAttribute("data-tip")).toBe(
      "Couldn’t copy: The macOS clipboard did not respond. Please try copying again."
    );
  });

  test("a retry that succeeds clears the failure", async () => {
    let attempt = 0;
    const el = await mount({
      onCopy: async () => {
        attempt += 1;
        return attempt === 1 ? { ok: false, error: { message: "render failed" } } : { ok: true };
      }
    });

    await act(async () => card(el).click());
    expect(card(el).classList.contains("is-error")).toBe(true);
    await act(async () => card(el).click());
    expect(card(el).classList.contains("is-error")).toBe(false);
    expect(card(el).classList.contains("is-copied")).toBe(true);
  });

  test("a refused path copy marks the FILE chip, not Copied", async () => {
    const el = await mount({
      onCopy: async () => ({ ok: true }),
      onCopyPath: async () => ({ ok: false, error: { message: "render failed" } })
    });
    const chip = el.querySelector<HTMLAnchorElement>(".fo__copy-file")!;

    await act(async () => chip.click());
    expect(chip.textContent).toContain("Failed");
    expect(chip.classList.contains("is-error")).toBe(true);
    expect(chip.getAttribute("data-tip")).toBe("Couldn’t copy the path: render failed");
  });

  test("a later success replaces Failed, including a shortcut pulse", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (copyPulse: number): void =>
      root!.render(
        createElement(CopyButton, {
          preset: "high",
          label: "High",
          dim: "1931 × 1410",
          bytes: "270 KB",
          copyPulse,
          onCopy: async () => ({ ok: false, error: { message: "render failed" } })
        })
      );
    await act(async () => render(0));
    const el = container;
    await act(async () => card(el).click());
    expect(card(el).classList.contains("is-error")).toBe(true);

    // ⌘3 copied it from main; the pulse is the success signal.
    await act(async () => render(1));
    expect(card(el).classList.contains("is-copied")).toBe(true);
    expect(card(el).classList.contains("is-error")).toBe(false);
    expect(card(el).textContent).not.toContain("Failed");
  });
});
