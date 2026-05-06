// DetailRail — right-side panel showing capture metadata, Codex
// caption, and the L/M/H copy row. Visible in Focus + Reel modes,
// returns null in Grid mode.
//
// Phase B (this file's initial state): SHELL ONLY. Returns null in
// every mode. The grid template column 3 (360px in focus/reel via
// .psl[data-mode="focus"|"reel"]) collapses to its content since
// nothing renders.
//
// Phase C populates the body: tab strip, metadata, Codex caption,
// three <CopyButton> instances using presetMetrics(), action row
// (Share / Editor / trash). Plan reference:
// docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md
// Phase B.2 + Phase C.5.

import type { ReactElement } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import type { LibraryView } from "./library-view";

export type DetailRailProps = {
  readonly view: LibraryView;
  readonly record: CaptureRecord | null;
};

export function DetailRail({ view, record }: DetailRailProps): ReactElement | null {
  // Grid mode: rail not rendered. Mode-conditional lives INSIDE the
  // component (not in Library.tsx's JSX tree) so future surfaces that
  // want a rail in Grid (bulk-select, etc.) only change one component.
  if (view.kind === "grid") return null;

  // Phase B placeholder: even in focus/reel, the rail body is empty.
  // Phase C wires the actual content.
  if (record === null) return null;

  return (
    <aside className="psl__right" aria-label="Capture details">
      {/* Phase B placeholder — Phase C will render tabs + metadata +
          Codex caption + L/M/H copy row + action row here. */}
    </aside>
  );
}
