// The mark is a HARD STACK, not a blend (design/AGENTS.md §1): painted with
// plain strokeOpacity, the 0.3 back stroke composites through the 0.55 mid
// stroke and every crossing lights up as a brighter patch. Each tier is
// therefore masked by the stroke bands of the tiers in front of it. jsdom
// cannot rasterize, so this pins the structure that produces the knockout:
// which tier points at which mask, and which tiers each mask cuts out.

import { act, type ReactElement } from "react";
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

async function render(ui: ReactElement): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(ui));
  return host;
}

type Corner = `${string},${string}`;

const BACK: Corner = "43,27";
const MID: Corner = "35,41";
const FRONT: Corner = "27,55";

const corner = (rect: Element): Corner =>
  `${rect.getAttribute("x")},${rect.getAttribute("y")}`;

/** The painted tiers, keyed by their top-left corner. */
function tiers(svg: SVGSVGElement): Map<Corner, SVGRectElement> {
  const painted = svg.querySelectorAll<SVGRectElement>(":scope > g > rect");
  return new Map([...painted].map((rect) => [corner(rect), rect]));
}

/** The <mask> a tier's `mask="url(#id)"` resolves to within this svg. */
function maskFor(svg: SVGSVGElement, rect: SVGRectElement): SVGMaskElement {
  const ref = rect.getAttribute("mask");
  const id = /^url\(#(.+)\)$/.exec(ref ?? "")?.[1];
  expect(id, `tier ${corner(rect)} has no mask`).toBeDefined();
  const masks = [...svg.querySelectorAll("mask")].filter((m) => m.id === id);
  expect(masks).toHaveLength(1);
  return masks[0] as SVGMaskElement;
}

/** Corners of the tiers a mask paints black, i.e. knocks out. */
function cutOut(mask: SVGMaskElement): Corner[] {
  return [...mask.querySelectorAll("rect")]
    .filter((r) => r.getAttribute("stroke") === "#000")
    .map(corner)
    .sort();
}

describe("PwrSnapMark hard stack", () => {
  test("masks the back tier by mid + front and the mid tier by front", async () => {
    const el = await render(<PwrSnapMark size={20} />);
    const svg = el.querySelector("svg") as SVGSVGElement;
    const painted = tiers(svg);
    expect([...painted.keys()].sort()).toEqual([BACK, FRONT, MID].sort());

    const back = painted.get(BACK) as SVGRectElement;
    const mid = painted.get(MID) as SVGRectElement;
    const front = painted.get(FRONT) as SVGRectElement;

    expect(back.getAttribute("stroke-opacity")).toBe("0.3");
    expect(mid.getAttribute("stroke-opacity")).toBe("0.55");
    expect(front.hasAttribute("stroke-opacity")).toBe(false);

    expect(cutOut(maskFor(svg, back))).toEqual([FRONT, MID].sort());
    expect(cutOut(maskFor(svg, mid))).toEqual([FRONT]);
    expect(front.hasAttribute("mask")).toBe(false);

    // A cut band is the tier's own stroke band — same width and join —
    // and the mask lives in the 128 user space rather than the
    // objectBoundingBox default, which would clip the stroke overhang.
    for (const mask of svg.querySelectorAll("mask")) {
      expect(mask.getAttribute("maskUnits")).toBe("userSpaceOnUse");
      const cuts = [...mask.querySelectorAll('rect[stroke="#000"]')];
      for (const cut of cuts) {
        expect(cut.getAttribute("stroke-width")).toBe("9");
        expect(cut.getAttribute("stroke-linejoin")).toBe("round");
        expect(cut.getAttribute("fill")).toBe("none");
      }
    }
  });

  test("every instance in a document gets its own mask ids", async () => {
    const el = await render(
      <>
        <PwrSnapMark size={20} decorative />
        <PwrSnapMark size={16} />
        <PwrSnapMark size={12} decorative />
      </>
    );
    const svgs = [...el.querySelectorAll("svg")];
    expect(svgs).toHaveLength(3);

    const ids = svgs.flatMap((svg) => [...svg.querySelectorAll("mask")].map((m) => m.id));
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);

    // Each instance's tiers resolve to masks inside that same instance.
    for (const svg of svgs) {
      const painted = tiers(svg);
      for (const key of [BACK, MID]) {
        const mask = maskFor(svg, painted.get(key) as SVGRectElement);
        expect(svg.contains(mask)).toBe(true);
        expect(document.querySelectorAll(`[id="${mask.id}"]`)).toHaveLength(1);
      }
    }
  });

  test("keeps the accent pin and the aria contract", async () => {
    const el = await render(
      <>
        <PwrSnapMark />
        <PwrSnapMark decorative />
      </>
    );
    const [labelled, decorative] = [...el.querySelectorAll("svg")] as SVGSVGElement[];

    expect(labelled?.style.color).toBe("var(--accent)");
    expect(labelled?.getAttribute("role")).toBe("img");
    expect(labelled?.getAttribute("aria-label")).toBe("PwrSnap");
    expect(labelled?.hasAttribute("aria-hidden")).toBe(false);

    expect(decorative?.getAttribute("aria-hidden")).toBe("true");
    expect(decorative?.hasAttribute("role")).toBe(false);
    expect(decorative?.hasAttribute("aria-label")).toBe(false);
  });
});
