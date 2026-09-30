// PwrSnapMark is the app icon's glyph, redrawn in SVG. Two things about it are
// invisible in review and easy to lose:
//
// - The geometry is COPIED from scripts/generate-app-icon.swift. Nothing ties
//   the two together, so these tests re-derive every rect from the Swift
//   constants and fail if either side moves alone.
// - The tiers are a hard stack (design/AGENTS.md §1): each is masked by the
//   stroke bands of the tiers in front of it. A mask id shared between two
//   marks on one page would point every instance at the first one's mask.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { PwrSnapMark } from "../BrandMark";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

// __tests__ → shared → features → src → renderer → src → apps/desktop
const DESKTOP = join(__dirname, "..", "..", "..", "..", "..", "..");
const swift = readFileSync(join(DESKTOP, "scripts", "generate-app-icon.swift"), "utf8");

/** `let <name> = <n> * scale` from the icon generator. */
function swiftConstant(name: string): number {
  const match = new RegExp(`let ${name} = (\\d+) \\* scale`).exec(swift);
  if (match === null) throw new Error(`generate-app-icon.swift declares no \`${name}\``);
  return Number(match[1]);
}

/** `static let <name>: CGFloat = <n>` — the tier alphas. */
function swiftAlpha(name: string): string {
  const match = new RegExp(`static let ${name}: CGFloat = ([\\d.]+)`).exec(swift);
  if (match === null) throw new Error(`generate-app-icon.swift declares no \`${name}\``);
  return String(Number(match[1]));
}

/** Corners of the three painted tiers, back to front, in the order painted. */
function paintedTiers(svg: SVGSVGElement) {
  return [...svg.querySelectorAll(":scope > g > rect")].map((r) => ({
    x: Number(r.getAttribute("x")),
    y: Number(r.getAttribute("y")),
    width: Number(r.getAttribute("width")),
    height: Number(r.getAttribute("height")),
    rx: Number(r.getAttribute("rx")),
    opacity: r.getAttribute("stroke-opacity"),
    mask: r.getAttribute("mask")
  }));
}

/** Corners of the stroke bands cut into the mask a tier references. */
function cutsIn(svg: SVGSVGElement, maskRef: string | null) {
  const id = /^url\(#(.+)\)$/.exec(maskRef ?? "")?.[1];
  if (id === undefined) throw new Error(`not a mask reference: ${maskRef}`);
  const mask = svg.querySelector(`mask[id="${id}"]`);
  if (mask === null) throw new Error(`no mask #${id} in this svg`);
  return [...mask.querySelectorAll('rect[stroke="#000"]')].map(
    (r) => `${r.getAttribute("x")},${r.getAttribute("y")}`
  );
}

describe("PwrSnapMark", () => {
  test("is the icon glyph: every tier and alpha derived from generate-app-icon.swift", async () => {
    const svg = (await render(<PwrSnapMark size={20} />)).querySelector("svg")!;
    const w = swiftConstant("rectWidth");
    const h = swiftConstant("rectHeight");
    const rx = swiftConstant("rx");
    const dx = swiftConstant("offsetX");
    const dy = swiftConstant("offsetY");
    const stroke = swiftConstant("strokeWidth");

    // Centred in the 1024 canvas; AppKit is y-up, so the icon's "+dy" (back,
    // top-right) is a SMALLER y here.
    const at = (sx: number, sy: number) => ({ x: 512 - w / 2 + sx * dx, y: 512 - h / 2 - sy * dy });
    const [back, mid, front] = paintedTiers(svg);
    expect(back).toMatchObject({ ...at(1, 1), width: w, height: h, rx, opacity: swiftAlpha("backAlpha") });
    expect(mid).toMatchObject({ ...at(0, 0), width: w, height: h, rx, opacity: swiftAlpha("midAlpha") });
    // The front tier is painted at the icon's full strength, so it carries no
    // stroke-opacity at all.
    expect(swiftAlpha("frontAlpha")).toBe("1");
    expect(front).toMatchObject({ ...at(-1, -1), width: w, height: h, rx, opacity: null });
    expect(svg.querySelector(":scope > g")!.getAttribute("stroke-width")).toBe(String(stroke));
  });

  test("the viewBox is the glyph's own bounds, squared about their centre", async () => {
    const svg = (await render(<PwrSnapMark />)).querySelector("svg")!;
    const tiers = paintedTiers(svg);
    const half = swiftConstant("strokeWidth") / 2;
    const left = Math.min(...tiers.map((t) => t.x)) - half;
    const right = Math.max(...tiers.map((t) => t.x + t.width)) + half;
    const top = Math.min(...tiers.map((t) => t.y)) - half;
    const bottom = Math.max(...tiers.map((t) => t.y + t.height)) + half;
    const side = Math.max(right - left, bottom - top);
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    // The ink is centred in the box, which is what puts the drawn mark on a
    // title strip's centreline when flex centres the box.
    expect(svg.getAttribute("viewBox")).toBe(`${cx - side / 2} ${cy - side / 2} ${side} ${side}`);
  });

  test("is a hard stack: back masked by mid + front, mid by front, front unmasked", async () => {
    const svg = (await render(<PwrSnapMark />)).querySelector("svg")!;
    const [back, mid, front] = paintedTiers(svg);
    const corner = (t: { x: number; y: number }) => `${t.x},${t.y}`;
    expect(cutsIn(svg, back!.mask)).toEqual([corner(mid!), corner(front!)]);
    expect(cutsIn(svg, mid!.mask)).toEqual([corner(front!)]);
    expect(front!.mask).toBeNull();
  });

  test("every instance on a page references its own masks", async () => {
    const page = await render(
      <>
        <PwrSnapMark size={20} decorative />
        <PwrSnapMark size={12} />
      </>
    );
    const ids = [...page.querySelectorAll("mask")].map((m) => m.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    for (const svg of page.querySelectorAll("svg")) {
      for (const tier of paintedTiers(svg as SVGSVGElement)) {
        if (tier.mask !== null) expect(() => cutsIn(svg as SVGSVGElement, tier.mask)).not.toThrow();
      }
    }
  });

  test("decorative hides it; alone it is a named image", async () => {
    const page = await render(
      <>
        <PwrSnapMark decorative />
        <PwrSnapMark />
      </>
    );
    const [decorative, named] = page.querySelectorAll("svg");
    expect(decorative!.getAttribute("aria-hidden")).toBe("true");
    expect(decorative!.getAttribute("role")).toBeNull();
    expect(named!.getAttribute("role")).toBe("img");
    expect(named!.getAttribute("aria-label")).toBe("PwrSnap");
  });
});
