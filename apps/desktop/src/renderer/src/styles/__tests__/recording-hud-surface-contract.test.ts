// Lock the recording-HUD surface contract: the bar (`.rc` once the take
// is live), the failure card (`.rc-fail`), and the "Starting recorder…"
// label paint an OPAQUE, theme-stable black with no backdrop-filter or
// opacity.
//
// Why this needs a test rather than a code comment:
//
//   • The HUD is its own `transparent: true` BrowserWindow floating over
//     the app being recorded. A CSS backdrop-filter only samples what the
//     page itself painted — never the other windows behind it — so any
//     alpha in a fill lets the recorded app show through UNBLURRED and
//     sharp-edged. At the old 86% a white window edge behind the bar was
//     a ~#232323 stripe, and the app's own text ghosted under ours.
//
//   • It is not only cosmetic. macOS hides the HUD from the capture with
//     setContentProtection, but on Windows the recorder is gdigrab reading
//     the desktop DC, so on a full-display take the HUD — bleed-through
//     and all — is in the user's MP4.
//
//   • "Near-opaque black" reads as a harmless tweak in review, and so does
//     "use the theme's canvas token". The first reintroduces the leak; the
//     second flips to white in light theme under white on-scrim text. The
//     fill is pinned to the literal for both reasons.
//
// Same defect class as the float-over toast and the tray popover (see
// `.fo` in float-over.css). Reads the CSS as strings, like the other
// contract suites here — see ./css-block for why comments are stripped
// before any block lookup.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractBlock, stripCssComments } from "./css-block";

const LABEL = "recording-hud-surface-contract";
const RECORDING_DIR = join(__dirname, "..", "..", "features", "recording");

const css = stripCssComments(readFileSync(join(RECORDING_DIR, "RecordingController.css"), "utf8"));
const tsx = readFileSync(join(RECORDING_DIR, "RecordingController.tsx"), "utf8");

// Each surface: the block that paints it, the blocks that wrap or style
// it without painting (an `opacity` on any of them fades the fill just the
// same), and the class the component must actually render — without that
// last check, a renamed class would leave this suite pinning a dead rule.
// Selectors are anchored on `}` so `.rc` never matches `.rc-root` and
// `.rc-fail` never matches `.rc-fail-root` (extractBlock also requires the
// pattern to end at the opening brace).
const SURFACES = [
  {
    name: "recording bar",
    paints: '(?:^|\\})\\s*\\.rc\\[data-precapture="false"\\]',
    containers: [
      "(?:^|\\})\\s*\\.rc",
      "(?:^|\\})\\s*\\.rc-root",
      '(?:^|\\})\\s*\\.rc-root\\[data-precapture="false"\\]'
    ],
    className: "rc"
  },
  {
    name: "failure card",
    paints: "(?:^|\\})\\s*\\.rc-fail",
    containers: ["(?:^|\\})\\s*\\.rc-fail-root"],
    className: "rc-fail"
  },
  {
    name: "starting label",
    paints: "(?:^|\\})\\s*\\.rc-starting__label",
    containers: [],
    className: "rc-starting__label"
  }
] as const;

const TRANSLUCENCY = /(?:^|[\s;])(?:-webkit-)?backdrop-filter\s*:|\bopacity\s*:/;

function block(selector: string, name: string): string {
  return extractBlock(css, selector, { label: `${LABEL}: ${name}`, expectSingle: true });
}

describe(LABEL, () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it("paints opaque literal black, not an alpha fill or a themed token", () => {
        // Every background declaration, not just the first — a later one
        // in the same block wins the cascade.
        const backgrounds = [
          ...block(surface.paints, surface.name).matchAll(
            /(?:^|[\s;])background(?:-color)?\s*:\s*([^;]+);/g
          )
        ].map((m) => (m[1] ?? "").trim());
        expect(backgrounds).toEqual(["#000000"]);
      });

      it("declares no backdrop-filter or opacity on the surface or its wrappers", () => {
        for (const selector of [surface.paints, ...surface.containers]) {
          expect(block(selector, surface.name), selector).not.toMatch(TRANSLUCENCY);
        }
      });

      it("is the class the component renders, with no inline fill beside it", () => {
        // `className="rc"` exactly, and not followed by an inline style
        // that could paint over the rule this suite pins.
        const uses = [...tsx.matchAll(new RegExp(`className="${surface.className}"([^>]*)>`, "g"))];
        expect(uses.length).toBeGreaterThan(0);
        for (const use of uses) {
          expect(use[1] ?? "").not.toMatch(/\bstyle=/);
        }
      });
    });
  }
});
