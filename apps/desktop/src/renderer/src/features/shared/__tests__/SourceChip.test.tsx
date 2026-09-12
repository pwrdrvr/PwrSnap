// Coverage for the source chip's two presentation contracts:
//
//   • What `aria-pressed` and `disabled` mean. They describe the user's
//     arm/disarm choice and whether the chip can be acted on — NOT the
//     device's health. Conflating the two disabled the chip in exactly the
//     state where switching the source off is the only way out.
//   • When a meter is drawn, and what it is allowed to claim. A meter asserts
//     "a level is being measured"; for a post-capture receipt it asserts
//     "this source captured something".
//   • That the chip's controls are SIBLINGS. The grant action and the device
//     caret were `role="button"` spans nested inside the chip's own <button>,
//     which put them outside the accessibility tree entirely — the Allow
//     control that fires the macOS TCC grant was unreachable by keyboard and
//     by screen reader.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { SourceChip, type SourceChipState } from "../SourceChip";

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

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

/** The toggle. `testId` names the GROUP; the chip's controls live inside it. */
function toggle(el: HTMLElement): HTMLButtonElement {
  const body = el.querySelector<HTMLButtonElement>(".ps-chip__body");
  if (body === null) throw new Error("no .ps-chip__body");
  return body;
}

describe("SourceChip", () => {
  // `microphoneChipState` only returns `nodevice` when the source is ON, so
  // disabling the chip there removed the one control that could switch off a
  // microphone the machine does not have — and the recorder then aborts the
  // whole take with `microphone_unavailable`. The `M` key stayed live, so
  // mouse and keyboard disagreed about the same control.
  test("a missing device leaves the chip clickable so it can be switched off", () => {
    const el = mount(<SourceChip source="microphone" state="nodevice" testId="chip" />);
    const chip = toggle(el.querySelector<HTMLElement>("[data-testid='chip']")!);
    expect(chip.disabled).toBe(false);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });

  test("only a source with no subsystem at all is inert", () => {
    const el = mount(<SourceChip source="microphone" state="unsupported" testId="chip" />);
    expect(toggle(el.querySelector<HTMLElement>("[data-testid='chip']")!).disabled).toBe(true);
  });

  // `aria-pressed` is the user's arm/disarm choice, not the device's health.
  // Every state below describes a source that IS armed and WILL ride the
  // commit payload, so reporting `false` told a screen-reader user the
  // opposite of what the take was about to do.
  test("armed-but-faulted states report themselves as pressed", () => {
    for (const state of ["live", "silent", "ask", "denied", "nodevice"] as const) {
      const el = mount(<SourceChip source="microphone" state={state} testId="chip" />);
      expect(toggle(el).getAttribute("aria-pressed")).toBe("true");
      act(() => root!.unmount());
      el.remove();
    }
    container = null;
    root = null;
  });

  test("off is not pressed", () => {
    const el = mount(<SourceChip source="microphone" state="off" testId="chip" />);
    expect(toggle(el).getAttribute("aria-pressed")).toBe("false");
  });

  // A meter claims a level is being measured, which is only true where a
  // stream is open. An armed source that could not be opened has nothing to
  // measure, so widening `aria-pressed` must not widen the meter with it.
  test("states with no open stream draw no meter", () => {
    for (const state of ["ask", "denied", "nodevice", "off"] as const satisfies readonly SourceChipState[]) {
      const el = mount(<SourceChip source="microphone" state={state} />);
      expect(el.querySelector(".ps-meter")).toBeNull();
      act(() => root!.unmount());
      el.remove();
    }
    container = null;
    root = null;
  });

  test("an open stream draws one", () => {
    const el = mount(<SourceChip source="microphone" state="live" level={0.5} />);
    expect(el.querySelector(".ps-meter")).not.toBeNull();
  });

  // The receipt row's whole job is telling a source that captured something
  // apart from one that did not. `meterTone="recorded"` is passed for the
  // entire row, so letting it win painted both identically — the accent
  // border alone only means "requested".
  test("a silent receipt stays flat even when the row asks for a full meter", () => {
    const el = mount(
      <SourceChip source="microphone" state="silent" density="static" meterTone="recorded" />
    );
    const meter = el.querySelector(".ps-meter")!;
    expect(meter.getAttribute("data-tone")).toBe("flat");
    expect(meter.getAttribute("data-level")).toBe("0");
  });

  test("a landed receipt still fills", () => {
    const el = mount(
      <SourceChip source="microphone" state="live" density="static" meterTone="recorded" />
    );
    expect(el.querySelector(".ps-meter")!.getAttribute("data-tone")).toBe("recorded");
  });

  // The Allow control is the only in-chip affordance that fires the macOS TCC
  // grant. As a `role="button"` span nested in the chip's <button> it was
  // pruned from the accessibility tree — `role="button"` has presentational
  // children — so a VoiceOver user heard one button named "Microphone needs
  // access Allow M" with no way to press Allow. Interactive content inside
  // <button> is invalid HTML too, so no engine owed us the behavior.
  test("no control is nested inside another control", () => {
    const el = mount(
      <SourceChip
        source="microphone"
        state="ask"
        why="needs access"
        act="Allow"
        onAct={() => undefined}
        kbd="M"
        hasDevices
        onOpenDevices={() => undefined}
        testId="chip"
      />
    );
    const chip = el.querySelector<HTMLElement>("[data-testid='chip']")!;
    expect(chip.tagName).toBe("SPAN");
    for (const button of chip.querySelectorAll("button")) {
      expect(button.closest("button")).toBe(button);
    }
    // Three peers: the toggle, the grant action, the device picker.
    expect(chip.querySelectorAll(":scope > button")).toHaveLength(3);
  });

  test("the grant action and the device caret are reachable controls", () => {
    let acted = 0;
    let opened = 0;
    let toggled = 0;
    const el = mount(
      <SourceChip
        source="microphone"
        state="ask"
        act="Allow"
        onAct={() => { acted += 1; }}
        hasDevices
        onOpenDevices={() => { opened += 1; }}
        onToggle={() => { toggled += 1; }}
        testId="chip"
      />
    );
    const allow = el.querySelector<HTMLButtonElement>(".ps-chip__act")!;
    const devices = el.querySelector<HTMLButtonElement>(".ps-chip__devices")!;
    expect(allow.tagName).toBe("BUTTON");
    expect(allow.textContent).toBe("Allow");
    expect(devices.getAttribute("aria-label")).toBe("Choose microphone device");
    allow.click();
    devices.click();
    expect([acted, opened]).toEqual([1, 1]);
    // Siblings, so neither click can reach the toggle — there is no
    // enclosing button left for one to bubble into.
    expect(toggled).toBe(0);
    toggle(el).click();
    expect(toggled).toBe(1);
  });

  // The enclosing <button> used to be `disabled` for an inert chip, which
  // Chromium made swallow clicks on everything inside it. As siblings the
  // action is only as inert as it says it is, and "Allow" on a source with
  // no device subsystem to arm is a control that cannot do anything.
  test("an inert chip exposes no live action", () => {
    let acted = 0;
    const el = mount(
      <SourceChip
        source="microphone"
        state="unsupported"
        act="Allow"
        onAct={() => { acted += 1; }}
        hasDevices
        testId="chip"
      />
    );
    expect(el.querySelector(".ps-chip__act")).toBeNull();
    expect(el.querySelector(".ps-chip__devices")).toBeNull();
    expect(el.querySelector("[data-testid='chip']")!.getAttribute("role")).toBeNull();
    expect(acted).toBe(0);
  });

  // The callbacks are typed `() => void`, so TypeScript accepts any
  // narrower arity; passing them straight to `onClick` would hand the
  // SyntheticEvent to a caller whose function takes an optional first
  // parameter and have it read as a truthy argument.
  test("the action callbacks are called with no arguments", () => {
    const seen: unknown[][] = [];
    const el = mount(
      <SourceChip
        source="microphone"
        state="ask"
        act="Allow"
        onAct={(...args: unknown[]) => { seen.push(args); }}
        hasDevices
        onOpenDevices={(...args: unknown[]) => { seen.push(args); }}
        testId="chip"
      />
    );
    el.querySelector<HTMLButtonElement>(".ps-chip__act")!.click();
    el.querySelector<HTMLButtonElement>(".ps-chip__devices")!.click();
    expect(seen).toEqual([[], []]);
  });

  // Wrapping a lone toggle in a group would make every chip announce
  // "group" for nothing — including each of the three dense chips already
  // inside the recording HUD's own "Recording sources" group.
  test("only a chip with more than one control announces as a group", () => {
    const bare = mount(<SourceChip source="microphone" state="off" testId="chip" />);
    expect(bare.querySelector("[data-testid='chip']")!.getAttribute("role")).toBeNull();
    act(() => root!.unmount());
    bare.remove();
    container = null;
    root = null;

    const grouped = mount(
      <SourceChip source="microphone" state="ask" act="Allow" testId="chip" />
    );
    const chip = grouped.querySelector("[data-testid='chip']")!;
    expect(chip.getAttribute("role")).toBe("group");
    expect(chip.getAttribute("aria-label")).toBe("Microphone");
  });

  // The hotkey rode in as a trailing "M" on the button's accessible name,
  // which said nothing about what it was. `aria-keyshortcuts` is the
  // attribute for exactly this, so the visible badge is decorative.
  test("the hotkey is announced as a shortcut, not as part of the name", () => {
    const el = mount(<SourceChip source="microphone" state="off" kbd="M" testId="chip" />);
    expect(toggle(el).getAttribute("aria-keyshortcuts")).toBe("M");
    expect(el.querySelector(".ps-chip__kbd")!.getAttribute("aria-hidden")).toBe("true");
  });

  // One predicate for the badge and the announcement. Only the control
  // density draws the badge AND has a key handler behind it — announcing
  // a shortcut the surface neither draws nor binds is the same
  // two-predicates-that-must-agree bug as the hint legend's.
  test("a density that draws no badge announces no shortcut", () => {
    const el = mount(
      <SourceChip source="microphone" state="live" density="dense" kbd="M" testId="chip" />
    );
    expect(el.querySelector(".ps-chip__kbd")).toBeNull();
    expect(toggle(el).getAttribute("aria-keyshortcuts")).toBeNull();
  });

  // Dense drops the visible label, which left the toggle with an aria-hidden
  // glyph, an aria-hidden meter, and so no accessible name at all.
  test("a dense chip still has a name", () => {
    const el = mount(
      <SourceChip source="systemAudio" state="live" density="dense" testId="chip" />
    );
    expect(el.querySelector(".ps-chip__name")).toBeNull();
    expect(toggle(el).getAttribute("aria-label")).toBe("System audio");
  });
});
