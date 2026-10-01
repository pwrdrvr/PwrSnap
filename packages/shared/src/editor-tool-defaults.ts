// Factory-default editor tool styles — THE single source. Consumed by
// main's `defaultSettings()` (what a fresh install persists), by the
// renderer's tool-state hook as the pre-`settings:read` fallback (so
// `activeStyle` never degrades to a style-less placeholder while
// settings load), and by the editor's selection→style projection
// fallbacks. A factory (not a shared constant) so no caller can mutate
// another's copy. Retuning a default here changes what a first-run
// user gets everywhere at once — deliberate.
//
// Lives in its own module (NOT protocol.ts) on purpose: protocol.ts
// must stay free of runtime imports of overlay-schemas, because the
// sandboxed PRELOAD reaches protocol at runtime via appearance-arg —
// and overlay-schemas drags in zod, which a sandboxed preload cannot
// `require`. Putting the factory in protocol.ts broke every preload
// (`pwrsnapApi is not exposed`).

import type { EditorToolBag, EditorToolStyles } from "./protocol";
import { TOOL_BAG_SIZE } from "./protocol";
import {
  DEFAULT_PARALLELOGRAM_SKEW_DEG,
  DEFAULT_SHAPE_KIND,
  MAX_HIGHLIGHT_OPACITY
} from "./overlay-schemas";

/** Factory tool bag, seeded from how annotations actually get used
 *  (the 2026-09 read of one heavy user's library: 81% arrows; red, green
 *  and yellow arrows the overwhelming majority, red + green the most
 *  common mix in one snap; yellow the most common highlight tint; blur
 *  the other half of redaction). Slot 4 is a range — an arrow with a
 *  bar at both ends. Slot 9 starts empty so the first "save to bag" has
 *  somewhere to land. */
export function defaultEditorToolBag(): EditorToolBag {
  const arrow = (color: string) =>
    ({
      tool: "arrow",
      style: {
        color,
        thickness: "small",
        endStyle: "filled-triangle",
        stemStyle: "solid",
        doubleEnded: false,
        outline: "auto"
      }
    }) as const;
  const slots: EditorToolBag["slots"] = [
    arrow("red"),
    arrow("green"),
    arrow("yellow"),
    {
      tool: "arrow",
      style: {
        color: "yellow",
        thickness: "small",
        endStyle: "bar",
        stemStyle: "solid",
        doubleEnded: true,
        outline: "auto"
      }
    },
    {
      tool: "highlight",
      style: { color: "yellow", opacity: MAX_HIGHLIGHT_OPACITY, blend: "multiply" }
    },
    { tool: "blur", style: { mode: "gaussian", radius: { mode: "auto" } } },
    {
      tool: "shape",
      style: {
        color: "red",
        thickness: "small",
        filled: false,
        shape: DEFAULT_SHAPE_KIND,
        skewDeg: DEFAULT_PARALLELOGRAM_SKEW_DEG,
        outline: "auto"
      }
    },
    {
      tool: "text",
      style: { color: "red", fontSize: "medium", weight: "regular", outline: "auto" }
    }
  ];
  while (slots.length < TOOL_BAG_SIZE) slots.push(null);
  return { slots };
}

export function defaultEditorToolStyles(): EditorToolStyles {
  return {
    // Default to the brand accent (tangerine) rather than picking a
    // stoplight color — neutral choice for a first-time user who
    // hasn't established a personal pattern yet. Each tool keeps its
    // own color; the tool bag is where favorite combinations live.
    arrow: {
      color: "accent",
      thickness: "auto",
      endStyle: "filled-triangle",
      stemStyle: "solid",
      doubleEnded: false,
      // Contrast border defaults to Auto (sample the background,
      // pick black on light pages / white elsewhere) — the fixed
      // always-white halo is exactly what Auto fixes.
      outline: "auto"
    },
    text: {
      color: "accent",
      fontSize: "auto",
      weight: "regular",
      outline: "auto"
    },
    shape: {
      color: "accent",
      thickness: "auto",
      filled: false,
      shape: DEFAULT_SHAPE_KIND,
      skewDeg: DEFAULT_PARALLELOGRAM_SKEW_DEG,
      outline: "auto"
    },
    blur: {
      mode: "gaussian",
      radius: { mode: "auto" }
    },
    highlight: {
      // Yellow is the canonical highlight color (same as a yellow
      // marker on paper) — highlight's color means "visual emphasis",
      // not the severity the stoplight colors carry on other tools.
      color: "yellow",
      opacity: 0.3,
      blend: "multiply"
    }
  };
}
