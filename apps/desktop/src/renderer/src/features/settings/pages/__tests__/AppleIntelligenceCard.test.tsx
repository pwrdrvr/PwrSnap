// @vitest-environment jsdom

// Settings → AI Providers → Apple Intelligence, in each state macOS can
// report. The rules: say what macOS said, offer the agent prompt exactly
// when a step is missing, and never present a not-ready model as usable.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  APPLE_FM_LICENSE_COMMAND,
  APPLE_FM_LINKS,
  APPLE_FM_STATES,
  appleFmAgentPrompt,
  appleFmStateCopy,
  type AppleFmState,
  type AppleFmStatus
} from "@pwrsnap/shared";
import { AppleIntelligenceCard, type AppleIntelligenceCardProps } from "../AppleIntelligenceCard";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type Dispatched = { name: string; req: unknown };
const dispatched: Dispatched[] = [];
let testAnswer: unknown = { ok: true, value: { ms: 1712, modelLabel: "AFM 3 Core" } };
let terminalAnswer: unknown = { ok: true, value: undefined };

beforeEach(() => {
  dispatched.length = 0;
  testAnswer = { ok: true, value: { ms: 1712, modelLabel: "AFM 3 Core" } };
  terminalAnswer = { ok: true, value: undefined };
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: "darwin",
      dispatch: async (name: string, req: unknown) => {
        dispatched.push({ name, req });
        if (name === "appleFm:test") return testAnswer;
        if (name === "appleFm:openTerminal") return terminalAnswer;
        return { ok: true, value: undefined };
      },
      on: () => () => undefined
    }
  });
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
  Reflect.deleteProperty(window, "pwrsnapApi");
});

function status(state: AppleFmState, extra: Partial<AppleFmStatus> = {}): AppleFmStatus {
  return { state, modelLabel: null, detail: null, macosVersion: "26.5", checkedAt: 1_794_945_000_000, ...extra };
}

const onRecheck = vi.fn();
const onUseForCaptions = vi.fn();

async function render(props: Partial<AppleIntelligenceCardProps>): Promise<HTMLDivElement> {
  onRecheck.mockClear();
  onUseForCaptions.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(AppleIntelligenceCard, {
        status: status("ready", { modelLabel: "AFM 3 Core" }),
        loading: false,
        inUse: false,
        captionsRouted: false,
        onRecheck,
        onUseForCaptions,
        ...props
      })
    );
  });
  return container;
}

function button(el: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
}

describe("every state macOS can report", () => {
  test.each(APPLE_FM_STATES.filter((state) => state !== "unsupported-platform"))(
    "%s: says what it is, and offers the prompt exactly when one exists",
    async (state) => {
      const current = status(state, { detail: state === "ready" ? null : "macOS fixture sentence." });
      const el = await render({ status: current });
      const copy = appleFmStateCopy(current);
      expect(el.querySelector(".pss__afm-status-title")?.textContent).toBe(copy.title);
      expect(el.querySelector(".pss__afm-status .pss__badge")?.textContent).toBe(copy.badge);

      const prompt = appleFmAgentPrompt(current);
      const shown = el.querySelector(".pss__afm-prompt-text")?.textContent ?? null;
      expect(shown).toBe(prompt);
      expect(button(el, "Copy prompt") !== undefined).toBe(prompt !== null);

      // Only a ready model can be adopted or tested.
      expect(button(el, "Use for captions") !== undefined).toBe(state === "ready");
      expect(button(el, "Test") !== undefined).toBe(state === "ready");

      // What macOS said is shown verbatim, for every state that has it.
      if (state !== "ready") expect(el.querySelector(".pss__afm-status-said")?.textContent).toBe("macOS said: macOS fixture sentence.");

      // Each official link is a real anchor to an exact Apple URL.
      const hrefs = [...el.querySelectorAll<HTMLAnchorElement>(".pss__afm-links a")].map((a) => a.getAttribute("href"));
      expect(hrefs).toEqual(state === "ready" ? [] : copy.links.map((id) => APPLE_FM_LINKS[id].url));
    }
  );
});

describe("status block", () => {
  test("before macOS has answered there is nothing to adopt, test or copy", async () => {
    const el = await render({ status: null, loading: true });
    expect(el.textContent).toContain("Asking macOS…");
    expect(button(el, "Checking…")?.disabled).toBe(true);
    expect(button(el, "Use for captions")).toBeUndefined();
    expect(el.querySelector(".pss__afm-prompt")).toBeNull();
  });

  test("tone: grey when this Mac simply cannot run it, red once captions depend on it", async () => {
    const idle = await render({ status: status("needs-macos") });
    expect(idle.querySelector(".pss__afm-status")?.className).toContain("is-off");
    expect(idle.textContent).toContain("Nothing here needs fixing unless you want this model");
    await act(async () => { root?.unmount(); });
    container?.remove();

    const used = await render({ status: status("needs-macos"), inUse: true, captionsRouted: true });
    expect(used.querySelector(".pss__afm-status")?.className).toContain("is-bad");
    expect(used.querySelector(".pss__afm-status .pss__badge")?.className).toContain("is-danger");
    expect(used.textContent).toContain("new captures won't get one until it is ready");
    expect(used.textContent).not.toContain("Nothing here needs fixing");
  });

  test("Check again asks, and is the only thing that does", async () => {
    const el = await render({ status: status("model-not-ready") });
    expect(dispatched).toEqual([]);
    await click(button(el, "Check again")!);
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([]);
  });

  test("the status is announced to assistive technology", async () => {
    const el = await render({ status: status("license-required") });
    expect(el.querySelector(".pss__afm-status")?.getAttribute("role")).toBe("status");
  });
});

describe("adopting it", () => {
  test("Use for captions is offered only while captions run elsewhere", async () => {
    const el = await render({});
    await click(button(el, "Use for captions")!);
    expect(onUseForCaptions).toHaveBeenCalledTimes(1);
    await act(async () => { root?.unmount(); });
    container?.remove();
    const routed = await render({ inUse: true, captionsRouted: true });
    expect(button(routed, "Use for captions")).toBeUndefined();
  });

  test("the limits are stated where the choice is made", async () => {
    const el = await render({});
    const facts = el.querySelector(".pss__afm-facts")?.textContent ?? "";
    expect(facts).toContain("Captions only.");
    expect(facts).toContain("can misread small text");
    expect(facts).toContain("never sent to another provider");
  });
});

describe("the agent prompt", () => {
  test("Copy puts exactly the shown prompt on the clipboard and says so", async () => {
    const current = status("license-required", { detail: "Not agreed. Run 'sudo fm license' to review and agree." });
    const el = await render({ status: current });
    const copyButton = button(el, "Copy prompt")!;
    expect(copyButton.getAttribute("aria-label")).toBe("Copy the prompt for your agent");
    await click(copyButton);
    expect(dispatched).toEqual([{ name: "clipboard:copyText", req: { text: appleFmAgentPrompt(current) } }]);
    expect(button(el, "Copied")?.getAttribute("aria-label")).toBe("Copied the prompt for your agent");
  });

  test("a link opens through the allowlisted verb, not by navigating the window", async () => {
    const el = await render({ status: status("model-not-ready") });
    const link = el.querySelector<HTMLAnchorElement>(".pss__afm-links a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(dispatched).toEqual([{ name: "app:openExternal", req: { url: APPLE_FM_LINKS.requirements.url } }]);
  });
});

describe("the Terminal step", () => {
  const TERMS = status("license-required", { detail: "Not agreed. Run 'sudo fm license' to review and agree." });

  test("property: only missing terms show it, for every state macOS can report", async () => {
    for (const state of APPLE_FM_STATES) {
      if (state === "unsupported-platform") continue;
      const el = await render({ status: status(state) });
      expect(el.querySelector(".pss__afm-term") !== null).toBe(state === "license-required");
      expect(button(el, "Open Terminal") !== undefined).toBe(state === "license-required");
      await act(async () => {
        root?.unmount();
      });
      container?.remove();
    }
  });

  test("shows the command inside the status block, under what macOS said", async () => {
    const el = await render({ status: TERMS });
    const block = el.querySelector(".pss__afm-status")!;
    expect(block.querySelector(".pss__afm-term-cmd")?.textContent).toBe(APPLE_FM_LICENSE_COMMAND);
    const said = block.querySelector(".pss__afm-status-said")!;
    const step = block.querySelector(".pss__afm-term")!;
    expect(said.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("Copy puts exactly the command on the clipboard, and nothing is opened", async () => {
    const el = await render({ status: TERMS });
    const copyButton = button(el, "Copy")!;
    expect(copyButton.getAttribute("aria-label")).toBe("Copy the Terminal command");
    await click(copyButton);
    expect(dispatched).toEqual([{ name: "clipboard:copyText", req: { text: APPLE_FM_LICENSE_COMMAND } }]);
    expect(button(el, "Copied")?.getAttribute("aria-label")).toBe("Copied the Terminal command");
  });

  test("Open Terminal asks main to launch it and sends no command", async () => {
    const el = await render({ status: TERMS });
    await click(button(el, "Open Terminal")!);
    expect(dispatched).toEqual([{ name: "appleFm:openTerminal", req: {} }]);
    expect(el.querySelector(".pss__afm-term-foot")?.textContent).toContain("press Check again");
  });

  test("links Apple's acceptable-use requirements through the browser path", async () => {
    const el = await render({ status: TERMS });
    const link = el.querySelector<HTMLAnchorElement>(".pss__afm-term a.pss__text-link")!;
    expect(link.getAttribute("href")).toBe(APPLE_FM_LINKS.acceptableUse.url);
    await click(link);
    expect(dispatched).toEqual([{ name: "app:openExternal", req: { url: APPLE_FM_LINKS.acceptableUse.url } }]);
  });

  test("a launch failure says where to find Terminal instead", async () => {
    terminalAnswer = { ok: false, error: { kind: "unknown", code: "apple_fm_terminal_failed", message: "x" } };
    const el = await render({ status: TERMS });
    await click(button(el, "Open Terminal")!);
    expect(el.querySelector(".pss__afm-term-foot")?.textContent).toContain("Applications › Utilities");
    expect(button(el, "Open Terminal")?.disabled).toBe(false);
  });
});

describe("Try it", () => {
  test("a pass shows how long the model took", async () => {
    const el = await render({});
    await click(button(el, "Test")!);
    expect(dispatched).toEqual([{ name: "appleFm:test", req: {} }]);
    expect(el.querySelector(".pss__test-cmd")?.textContent).toBe("Answered in 1.7 s");
    expect(el.querySelector(".pss__test .pss__badge")?.textContent).toBe("PASS");
    expect(onRecheck).not.toHaveBeenCalled();
  });

  test("a failure shows main's words and re-reads the state", async () => {
    testAnswer = { ok: false, error: { kind: "settings", code: "apple_fm_test_failed", message: "The on-device model didn't answer in time." } };
    const el = await render({});
    await click(button(el, "Test")!);
    expect(el.querySelector(".pss__test-sub")?.textContent).toBe("The on-device model didn't answer in time.");
    expect(el.querySelector(".pss__test .pss__badge")?.textContent).toBe("FAIL");
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});
