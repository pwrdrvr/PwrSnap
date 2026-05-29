// Self-contained 6-card export grid (GIF L/M/H + MP4 L/M/H) for a
// single video capture. Owns the two hooks the library DetailRail
// originally wired by hand (`useVideoExportPresets` for the per-cell
// state machine + bus dispatch, `useVideoPresetMetrics` for the
// dim/byte labels) so the tray popover and float-over toast can drop
// the same chrome in with one line.
//
// The library DetailRail kept its hand-wired version because it
// composes the hooks with surrounding state (selection changes,
// per-cell render metrics for image fallback). The two surfaces
// here just want the cards — pass a captureId and you get the same
// behavior: click-to-copy a re-encoded file to clipboard, click FILE
// chip to copy the POSIX path, drag FILE chip for native drag-out.
//
// `captureId === null` renders an idle grid with no metric IPC fired
// — same shape as `useVideoExportPresets` accepting a null input, so
// the panel is safe to mount even before a video selection lands.

import type { ReactElement } from "react";
import { useVideoExportPresets } from "./useVideoExportPresets";
import { useVideoPresetMetrics } from "./useVideoPresetMetrics";
import { VideoExportPresetGrid } from "./VideoExportPresetGrid";

export type VideoExportPresetsPanelProps = {
  readonly captureId: string | null;
};

export function VideoExportPresetsPanel({
  captureId
}: VideoExportPresetsPanelProps): ReactElement {
  const { states, triggerCopy, triggerCopyPath, triggerDrag } =
    useVideoExportPresets(captureId === null ? null : { captureId });
  const metrics = useVideoPresetMetrics(captureId);
  return (
    <VideoExportPresetGrid
      metrics={metrics}
      states={states}
      onCopy={triggerCopy}
      onCopyPath={triggerCopyPath}
      onDrag={triggerDrag}
    />
  );
}
