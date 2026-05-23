// ToolConfigPanel — right-sidebar panel that mirrors the inline
// ToolStylePopover body for the currently-selected tool. Mounted in
// EditorChrome's `panels.toolConfig` slot (task #9 wires the prop).
//
// Implementation notes:
//
//   • Re-uses the SAME <ToolStyleBody> component the popover renders.
//     One source of truth for the per-tool control layouts so any
//     future swatch / preset change lands for both surfaces in a
//     single edit.
//
//   • Does NOT instantiate `useEditorToolState` — that hook owns the
//     editor's source-of-truth tool state. A second hook instance
//     would create a divergent shadow state. Instead, the parent
//     (Editor.tsx, wired in task #9) reads from the hook once and
//     threads `activeTool`, `activeStyle`, and the field-change
//     callback in via props.
//
//   • For pointer / crop (the two non-styled tools), shows an empty
//     state — there's nothing to configure. The header still renders
//     so the panel doesn't blank out mid-session when the user
//     switches to pointer for a moment.

import type { ReactElement } from "react";
import { ToolStyleBody } from "../ToolStylePopover";
import type {
  ActiveStyle,
  StyledTool,
  StyleFor
} from "../useEditorToolState";
import type { Tool } from "../editor-tools";

export interface ToolConfigPanelProps {
  /** Forwarded for future per-capture style memory hooks (e.g., a
   *  "reset this capture's overrides" affordance). Today the panel
   *  body itself doesn't depend on it, but accepting it keeps the
   *  prop surface symmetric with InfoPanel + future panels. */
  captureId: string;
  /** Owned by the parent — see file header. */
  activeTool: Tool;
  /** Discriminated union from `useEditorToolState`. Carries the
   *  resolved per-tool style block (settings defaults layered with
   *  any local session overrides). */
  activeStyle: ActiveStyle;
  /** Forwarded to <ToolStyleBody>. Generic over the tool kind +
   *  field so a setStyleField('arrow', 'thickness', 'medium') call
   *  typechecks both arms. */
  onStyleFieldChange<T extends StyledTool, K extends keyof StyleFor<T>>(
    tool: T,
    field: K,
    value: StyleFor<T>[K]
  ): void;
}

const TOOL_TITLES: Record<StyledTool, string> = {
  arrow: "Arrow style",
  text: "Text style",
  rect: "Rect style",
  blur: "Blur style",
  highlight: "Highlight style"
};

export function ToolConfigPanel({
  activeTool,
  activeStyle,
  onStyleFieldChange
}: ToolConfigPanelProps): ReactElement {
  // `activeTool` is intentionally not the discriminant — see the
  // footer note. Reference it once so noUnusedParameters never
  // flags the prop if a stricter tsconfig lands later.
  void activeTool;

  if (activeStyle.tool === "pointer" || activeStyle.tool === "crop") {
    return (
      <div className="pse-tool-config" data-testid="tool-config-panel">
        <h3 className="pse-tool-config-title">Tool</h3>
        <div className="pse-tool-config-empty" role="status">
          Select a tool to configure its style.
        </div>
      </div>
    );
  }

  const tool: StyledTool = activeStyle.tool;
  const title = TOOL_TITLES[tool];

  // The body's `onStyleFieldChange` signature is non-generic
  // (field/value as plain strings/unknowns) because the popover's
  // parent flattens the tool dimension out — `(field, value) =>
  // setStyleField(tool, field, value)`. We adapt the panel's
  // generic prop to the body's flat shape here so the body remains
  // identical between popover + panel call sites.
  const bodyOnChange = (field: string, value: unknown): void => {
    // Cast through unknown to bridge the generic boundary. Runtime
    // is sound: `tool` is the discriminant, and the body only emits
    // fields valid for that tool.
    (onStyleFieldChange as unknown as (
      t: StyledTool,
      f: string,
      v: unknown
    ) => void)(tool, field, value);
  };

  return (
    <div className="pse-tool-config" data-testid="tool-config-panel">
      <h3 className="pse-tool-config-title">{title}</h3>
      <div className="pse-tool-config-body">
        <ToolStyleBody
          tool={tool}
          style={activeStyle.style}
          onStyleFieldChange={bodyOnChange}
        />
      </div>
    </div>
  );
}

// Note: `activeTool` is accepted on the props surface but not
// directly read in the body switch — `activeStyle.tool` is the
// authoritative discriminant (a string-only `activeTool` could
// drift out of sync with the discriminated style block during a
// transition tick). Keep it on the prop surface so future
// affordances (e.g., a "this tool's shortcut: A" hint, or a
// per-capture "reset overrides" button) have a place to dock
// without breaking callers.
