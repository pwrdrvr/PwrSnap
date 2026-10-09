// The selector HUD's two fixed-width chip shapes: the Shutter's orb and the
// Clapperboard's slate cell. What they must never do is let a device name
// size them. The caption is cut short in CSS (SourceChip.css.test.ts pins
// that), and the whole name rides the fast tooltip, so nothing is lost.
// Contrived devices.

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { CursorChip, SourceChip } from "../SourceChip";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

async function mount(node: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

const LONG = "Granola Interface Pro Studio Edition (USB Audio Class 2.0)";

describe.each(["orb", "cell"] as const)("SourceChip at %s density", (density) => {
  test("a long device name is a caption, and whole in the tooltip", async () => {
    const el = await mount(
      <SourceChip density={density} source="microphone" state="live" level={0.5} device={LONG} kbd="M" />
    );
    const chip = el.querySelector<HTMLElement>(".ps-chip")!;
    expect(chip.classList.contains(`ps-chip--${density}`)).toBe(true);
    expect(chip.dataset.source).toBe("microphone");
    // The caption holds the short label; the tooltip holds the whole one.
    expect(el.querySelector(".ps-chip__cap .ps-chip__dev")?.textContent).toBe("Granola Interface Pro Studio Edition");
    const body = el.querySelector<HTMLButtonElement>(".ps-chip__body")!;
    expect(body.dataset.tip).toBe(`Microphone · ${LONG}`);
    expect(body.dataset.tipKeys).toBe("M");
    expect(body.getAttribute("aria-label")).toBe("Microphone");
    expect(body.getAttribute("aria-keyshortcuts")).toBe("M");
    // The fast tooltip only: never `title`, on the group or the toggle.
    expect(el.querySelector("[title]")).toBeNull();
  });

  test("a reason takes the caption's place, and says it in the tooltip too", async () => {
    const el = await mount(
      <SourceChip density={density} source="microphone" state="silent" device={LONG} why="no signal" />
    );
    expect(el.querySelector(".ps-chip__cap")?.textContent).toBe("No signal");
    expect(el.querySelector<HTMLElement>(".ps-chip__body")!.dataset.tipDetail).toBe("No signal");
  });

  test("the grant action and the caret are sibling buttons", async () => {
    const onAct = vi.fn();
    const onOpenDevices = vi.fn();
    const el = await mount(
      <SourceChip
        density={density}
        source="microphone"
        state="ask"
        why="needs access"
        act="Allow"
        onAct={onAct}
        hasDevices
        onOpenDevices={onOpenDevices}
      />
    );
    const group = el.querySelector<HTMLElement>(".ps-chip")!;
    expect(group.getAttribute("role")).toBe("group");
    await act(async () => el.querySelector<HTMLButtonElement>(".ps-chip__act")!.click());
    await act(async () => el.querySelector<HTMLButtonElement>(".ps-chip__devices")!.click());
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onOpenDevices).toHaveBeenCalledTimes(1);
  });

  test("the camera's picture is drawn in the chip", async () => {
    const el = await mount(
      <SourceChip density={density} source="camera" state="live" media={<i data-testid="pic" />} />
    );
    expect(el.querySelector('[data-testid="pic"]')).not.toBeNull();
  });

  test("the cursor bake is a peer of the sources", async () => {
    const onToggle = vi.fn();
    const el = await mount(<CursorChip density={density} on onToggle={onToggle} testId="cursor" />);
    const body = el.querySelector<HTMLButtonElement>('[data-testid="cursor"]')!;
    expect(body.getAttribute("aria-pressed")).toBe("true");
    expect(body.getAttribute("aria-keyshortcuts")).toBe("C");
    expect(el.querySelector<HTMLElement>(".ps-chip")!.dataset.source).toBe("cursor");
    await act(async () => body.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("the orb's level ring", () => {
  test("follows the level, and goes flat when nothing arrives", async () => {
    const el = await mount(<SourceChip density="orb" source="microphone" state="live" level={0.42} />);
    const ring = el.querySelector<HTMLElement>(".ps-orb__ring")!;
    expect(ring.dataset.level).toBe("42");
    expect(ring.style.getPropertyValue("--lvl")).toBe("42%");
    await act(async () => {
      root!.render(<SourceChip density="orb" source="microphone" state="silent" level={0.42} why="no signal" />);
    });
    expect(el.querySelector<HTMLElement>(".ps-orb__ring")!.dataset.tone).toBe("flat");
  });

  test("an armed microphone that is not measured draws no ring", async () => {
    const el = await mount(<SourceChip density="orb" source="microphone" state="live" noMeter />);
    expect(el.querySelector(".ps-orb__ring")).toBeNull();
  });

  test("the orb's grant action takes the caption's line", async () => {
    const el = await mount(
      <SourceChip density="orb" source="microphone" state="ask" why="needs access" act="Allow" onAct={() => undefined} />
    );
    expect(el.querySelector(".ps-chip__cap")).toBeNull();
    expect(el.querySelector(".ps-chip__body")?.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("the cell's signal", () => {
  test("an off source says OFF, and its name line says Off", async () => {
    const el = await mount(<SourceChip density="cell" source="systemAudio" state="off" noMeter />);
    expect(el.querySelector(".ps-cell__eye")?.textContent).toBe("SYSTEM");
    expect(el.querySelector(".ps-cell__off")?.textContent).toBe("OFF");
    expect(el.querySelector(".ps-chip__cap")?.textContent).toBe("Off");
  });

  test("a live microphone draws its meter", async () => {
    const el = await mount(<SourceChip density="cell" source="microphone" state="live" level={1} />);
    expect(el.querySelector(".ps-cell__vis .ps-meter")).not.toBeNull();
  });
});
