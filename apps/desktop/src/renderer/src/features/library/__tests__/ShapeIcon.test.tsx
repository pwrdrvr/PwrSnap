import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { computeShapeStrokeDash } from "@pwrsnap/shared";
import { ShapeIcon } from "../ShapeIcon";

const UNIT = { dashed: 1, dotted: 1.4 };
const STROKE = { fill: "none", stroke: "#e5484d", strokeWidth: 2 };

function svg(node: ReturnType<typeof ShapeIcon>): string {
  return renderToStaticMarkup(<svg>{node}</svg>);
}

describe("ShapeIcon", () => {
  test("builds the primitive and its corner-aligned pattern from one box", () => {
    const html = svg(
      <ShapeIcon
        shape="rect"
        box={{ cx: 24, cy: 14, w: 32, h: 16 }}
        paint={STROKE}
        strokeStyle="dashed"
        patternUnit={UNIT}
      />
    );
    const expected = computeShapeStrokeDash("dashed", "rect", 32, 16, 0, 1)!;
    expect(html).toContain('x="8" y="6" width="32" height="16"');
    expect(html).toContain(`stroke-dasharray="${expected.dasharray}"`);
    expect(html).toContain(`stroke-dashoffset="${expected.dashoffset}"`);
    expect(html).toContain('stroke-linecap="round"');
  });

  test("a parallelogram's skew comes from the box's shear, vertices in canvas order", () => {
    const html = svg(
      <ShapeIcon
        shape="parallelogram"
        box={{ cx: 23.5, cy: 14, w: 26, h: 18, shear: 2.5 }}
        paint={STROKE}
        strokeStyle="dotted"
        patternUnit={UNIT}
      />
    );
    expect(html).toContain('points="13,5 39,5 34,23 8,23"');
    const skewDeg = (Math.atan2(2.5, 9) * 180) / Math.PI;
    const expected = computeShapeStrokeDash("dotted", "parallelogram", 26, 18, skewDeg, 1.4)!;
    expect(html).toContain(`stroke-dasharray="${expected.dasharray}"`);
  });

  test("solid keeps the rounded rect and draws no pattern", () => {
    const html = svg(
      <ShapeIcon
        shape="rect"
        box={{ cx: 24, cy: 14, w: 32, h: 16 }}
        paint={STROKE}
        strokeStyle="solid"
        patternUnit={UNIT}
      />
    );
    expect(html).toContain('rx="1"');
    expect(html).not.toContain("stroke-dasharray");
  });
});
