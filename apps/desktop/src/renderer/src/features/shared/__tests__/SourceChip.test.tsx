// Coverage for the source chip's two presentation contracts:
//
//   • What `aria-pressed` and `disabled` mean. They describe the user's
//     arm/disarm choice and whether the chip can be acted on — NOT the
//     device's health. Conflating the two disabled the chip in exactly the
//     state where switching the source off is the only way out.
//   • When a meter is drawn, and what it is allowed to claim. A meter asserts
//     "a level is being measured"; for a post-capture receipt it asserts
//     "this source captured something".

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

describe("SourceChip", () => {
  // `microphoneChipState` only returns `nodevice` when the source is ON, so
  // disabling the chip there removed the one control that could switch off a
  // microphone the machine does not have — and the recorder then aborts the
  // whole take with `microphone_unavailable`. The `M` key stayed live, so
  // mouse and keyboard disagreed about the same control.
  test("a missing device leaves the chip clickable so it can be switched off", () => {
    const el = mount(<SourceChip source="microphone" state="nodevice" testId="chip" />);
    const chip = el.querySelector<HTMLButtonElement>("[data-testid='chip']")!;
    expect(chip.disabled).toBe(false);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });

  test("only a source with no subsystem at all is inert", () => {
    const el = mount(<SourceChip source="microphone" state="unsupported" testId="chip" />);
    expect(el.querySelector<HTMLButtonElement>("[data-testid='chip']")!.disabled).toBe(true);
  });

  // `aria-pressed` is the user's arm/disarm choice, not the device's health.
  // Every state below describes a source that IS armed and WILL ride the
  // commit payload, so reporting `false` told a screen-reader user the
  // opposite of what the take was about to do.
  test("armed-but-faulted states report themselves as pressed", () => {
    for (const state of ["live", "silent", "ask", "denied", "nodevice"] as const) {
      const el = mount(<SourceChip source="microphone" state={state} testId="chip" />);
      expect(el.querySelector("[data-testid='chip']")!.getAttribute("aria-pressed")).toBe("true");
      act(() => root!.unmount());
      el.remove();
    }
    container = null;
    root = null;
  });

  test("off is not pressed", () => {
    const el = mount(<SourceChip source="microphone" state="off" testId="chip" />);
    expect(el.querySelector("[data-testid='chip']")!.getAttribute("aria-pressed")).toBe("false");
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
});
