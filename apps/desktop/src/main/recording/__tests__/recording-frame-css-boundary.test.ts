// Executable policy for the one property that keeps tangerine out of
// the user's MP4: on a platform that cannot hide a window from its own
// recorder, NOTHING the frame draws may be inside the recorded rect.
//
// It reads the renderer's shipped stylesheet from the MAIN project on
// purpose. The invariant spans both halves — `planRecordingFrame` picks
// the mode and reserves the band, the CSS decides what that mode paints
// — and a jsdom render could not catch it either way: jsdom does not
// resolve `box-shadow`, and the failure is a paint, not a DOM shape. So
// the check is on the bytes, the way `local-agent-minting-boundary.test.ts`
// greps the production sources.
//
// If this fails, do not relax it. The Windows recorder is FFmpeg
// `gdigrab` reading the desktop DC; `setContentProtection(true)` is
// defence in depth there, not a guarantee.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { RECORDING_FRAME_BAND_PX } from "../recording-frame-geometry";

const css = readFileSync(
  fileURLToPath(
    new URL("../../../renderer/src/styles/recording-frame.css", import.meta.url)
  ),
  "utf8"
);

/** Strip comments so prose about `inset` never trips the scan. */
const source = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule block, as `{ selector, body }`. */
function rules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out.push({ selector: match[1]?.trim() ?? "", body: match[2] ?? "" });
  }
  return out;
}

/** `box-shadow` declarations only — `inset: 0` positioning is not a shadow. */
function boxShadowsIn(body: string): string[] {
  return [...body.matchAll(/box-shadow\s*:([^;]*)/g)].map((m) => m[1] ?? "");
}

/** One property's value out of a rule body, or `undefined`. */
function declaration(
  rule: { selector: string; body: string } | undefined,
  property: string
): string | undefined {
  if (rule === undefined) return undefined;
  const match = new RegExp(`${property}\\s*:([^;]*)`).exec(rule.body);
  return match?.[1]?.trim();
}

/** A `px` length as a number. Throws rather than silently reading NaN. */
function px(value: string | undefined): number {
  const parsed = Number(String(value).replace(/px\s*$/, ""));
  if (!Number.isFinite(parsed)) throw new Error(`not a px length: ${String(value)}`);
  return parsed;
}

describe("outset posture never paints inside the recorded rect", () => {
  test("the stylesheet was actually found", () => {
    // Guards the rest of this file: a bad path would make every scan
    // below pass vacuously, which is the worst possible outcome for a
    // test whose whole job is to refuse something.
    expect(css).toContain(".psrf__glow");
    expect(rules().length).toBeGreaterThan(10);
  });

  test("the base glow has no inset shadow", () => {
    // The base is the SAFE shape on purpose: macOS adds its inset kiss
    // in a `[data-mode="straddle"]` override. If that override is ever
    // dropped, what survives must be the posture that cannot reach a
    // capture — not the other way round.
    const base = rules().filter(
      (r) => r.selector === ".psrf__glow" || r.selector.endsWith(" .psrf__glow")
    );
    expect(base.length).toBeGreaterThan(0);

    for (const rule of base) {
      if (rule.selector.includes('data-mode="straddle"')) continue;
      for (const shadow of boxShadowsIn(rule.body)) {
        expect(
          shadow.includes("inset"),
          `inward shadow on a non-straddle rule: ${rule.selector}`
        ).toBe(false);
      }
    }
  });

  test("no rule scoped to outset declares an inward shadow", () => {
    for (const rule of rules()) {
      if (!rule.selector.includes('data-mode="outset"')) continue;
      for (const shadow of boxShadowsIn(rule.body)) {
        expect(shadow.includes("inset"), `inward shadow in: ${rule.selector}`).toBe(false);
      }
    }
  });

  test("the inset kiss exists, and only under straddle", () => {
    // The other half of the contract: the macOS affordance is real, and
    // it is reachable only through the attribute main sets from
    // `planRecordingFrame`.
    const withInsetShadow = rules().filter((r) =>
      boxShadowsIn(r.body).some((shadow) => shadow.includes("inset"))
    );
    expect(withInsetShadow.length).toBeGreaterThan(0);
    for (const rule of withInsetShadow) {
      expect(rule.selector).toContain('data-mode="straddle"');
    }
  });

  test("the outset hairline is drawn outside the box, not on it", () => {
    // `inset: -1px` + a 1px border puts the line in the ring just
    // outside the rect. An `inset: 0` here would put it on the outermost
    // recorded pixel, which gdigrab would capture.
    const hairline = rules().find(
      (r) => r.selector === '.psrf[data-mode="outset"] .psrf__edge'
    );
    expect(hairline).toBeDefined();
    expect(hairline?.body).toMatch(/inset\s*:\s*-1px/);
    expect(hairline?.body).toMatch(/border\s*:\s*1px solid/);
  });

  test("corner ticks clear the rect by at least their own border width", () => {
    // The trap this test exists for: a border is painted INWARD from the
    // element's own edge (`box-sizing: border-box`, app.css), so an
    // offset SMALLER than the border width leaves the difference lit
    // inside the rect. -1px against a 2px border put one tangerine
    // column at rect-relative 0 on all four corners — outside macOS,
    // straight into the gdigrab capture on Windows and Linux.
    const weight = declaration(
      rules().find((r) => r.selector === ".psrf__corner"),
      "--psrf-corner-weight"
    );
    expect(weight, "corner border width is declared as a variable").not.toBeUndefined();

    const offset = declaration(
      rules().find((r) => r.selector === '.psrf[data-mode="outset"] .psrf__corner'),
      "--psrf-corner-offset"
    );
    expect(offset, "outset corners declare an offset").not.toBeUndefined();

    // Outward is negative, so the offset must be at most -weight.
    expect(px(offset)).toBeLessThanOrEqual(-px(weight));
  });

  test("every corner border width comes from that one variable", () => {
    // Otherwise the check above is measuring a number nothing paints.
    for (const rule of rules()) {
      if (!rule.selector.includes(".psrf__corner[data-corner=")) continue;
      for (const [, value] of rule.body.matchAll(/border-[a-z]+-width\s*:([^;]*)/g)) {
        expect(value, `hardcoded border width in ${rule.selector}`).toContain(
          "var(--psrf-corner-weight)"
        );
      }
    }
  });
});

describe("the glow stays inside the band main reserves", () => {
  test("no outer shadow reaches past RECORDING_FRAME_BAND_PX", () => {
    // The window is inflated by this much on each side; a falloff wider
    // than the band gets a hard edge where the window stops, which reads
    // as a bug rather than a glow.
    //
    // `0 0 <blur> <spread>` — outward reach is spread + blur / 2.
    const shadows = [...source.matchAll(/0 0 ([\d.]+)px(?: ([\d.]+)px)?/g)];
    expect(shadows.length).toBeGreaterThan(0);

    for (const [, first, second] of shadows) {
      const blur = Number(first);
      // Two-number form is `0 0 <spread>` with no blur; three-number is
      // `0 0 <blur> <spread>`.
      const reach = second === undefined ? blur : Number(second) + blur / 2;
      expect(reach).toBeLessThanOrEqual(RECORDING_FRAME_BAND_PX);
    }
  });
});
