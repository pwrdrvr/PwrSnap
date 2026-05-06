// Floating bottom-center edit toolbar for the Library's Stage
// component (Focus + Reel modes). Shares tool state with the
// chromeless Editor via lifted React state — Library's Library.tsx
// owns `tool` + `setTool` and passes them to both <Stage> (which
// forwards to <Editor chrome="chromeless" tool onToolChange />) and
// to this component.
//
// Different from Editor's internal `EditorToolbar` (full + embedded
// chrome modes): this one is bigger, label-visible, floats over the
// canvas. Different DOM, different positioning, different feature
// trajectory (color swatches, magic wand, undo will land here when
// they ship). Keeping the two separate avoids coupling.
//
// Plan reference:
//   docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md
//   Phase C.3.

import type { ReactElement } from "react";
import { TOOLS, type Tool } from "../editor/Editor";

export type EditToolbarProps = {
  readonly tool: Tool;
  readonly onChange: (next: Tool) => void;
};

export function EditToolbar({ tool, onChange }: EditToolbarProps): ReactElement {
  return (
    <div
      className="psl__edit-toolbar"
      role="toolbar"
      aria-label="Annotation tools"
      // Stop pointer-down from bubbling to the canvas behind. Without
      // this, clicking a tool button inside the canvas's pointer-down
      // area would also fire the canvas's drag-to-draw handler — the
      // "I clicked Rect and accidentally drew on the canvas" bug
      // class julik flagged. mousedown (not click) because the canvas
      // listens for pointerdown for drag-start. Plan §5
      // (in-canvas-toolbar pattern).
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={"psl__et-btn" + (tool === t.id ? " is-active" : "")}
          onClick={() => onChange(t.id)}
          title={`${t.label} (${t.key})`}
        >
          <span>{t.label}</span>
          <span className="psl__et-btn-key">{t.key}</span>
        </button>
      ))}
      {/* Crop, color swatches, magic wand, and the in-toolbar Undo
          are deliberately NOT rendered in this phase per Scope
          Boundaries. The features themselves haven't shipped yet;
          rendering placeholder buttons would be cargo-cult chrome. */}
    </div>
  );
}
