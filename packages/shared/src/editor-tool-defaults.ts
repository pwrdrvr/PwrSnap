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

import type { EditorToolStyles } from "./protocol";
import {
  DEFAULT_PARALLELOGRAM_SKEW_DEG,
  DEFAULT_SHAPE_KIND
} from "./overlay-schemas";

export function defaultEditorToolStyles(): EditorToolStyles {
  return {
    // Default to the brand accent (tangerine) rather than picking a
    // stoplight color — neutral choice for a first-time user who
    // hasn't established a personal pattern yet. The shared-COLOR-
    // slot pattern means the first swatch they pick will propagate
    // across all tools.
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
      // marker on paper); not part of the cross-tool shared COLOR
      // slot because highlight is the one tool whose semantic is
      // "color = visual emphasis" rather than "color = severity".
      color: "yellow",
      opacity: 0.3,
      blend: "multiply"
    }
  };
}
