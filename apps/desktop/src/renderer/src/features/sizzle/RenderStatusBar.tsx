// Render progress state + the footer status line that shows it.

import type { ReactElement } from "react";
import type { SizzleRenderProgressEvent } from "@pwrsnap/shared";

export type RenderStatus = {
  phase: SizzleRenderProgressEvent["phase"] | "idle";
  message: string;
  ratio: number;
  error: string | null;
};

export const IDLE_STATUS: RenderStatus = {
  phase: "idle",
  message: "",
  ratio: 0,
  error: null
};

export function isRendering(status: RenderStatus): boolean {
  return status.phase !== "idle" && status.phase !== "done" && status.phase !== "failed";
}

export function RenderStatusBar({ status }: { status: RenderStatus }): ReactElement {
  if (status.phase === "idle") {
    return (
      <span className="szl__status szl__status--idle">
        Add a scene, write a script line, then render.
      </span>
    );
  }
  if (status.phase === "failed") {
    // The footer truncates this to one line so it can't push the buttons
    // around, so carry the full text in `title` — an ffmpeg failure is
    // often long and is the whole point of the message.
    const detail = status.error ?? status.message;
    return (
      <span className="szl__status szl__status--err" title={detail}>
        Render failed: {detail}
      </span>
    );
  }
  if (status.phase === "done") {
    return (
      <span className="szl__status szl__status--ok">Render complete.</span>
    );
  }
  return (
    <span className="szl__status">
      <span className="szl__status-bar">
        <span
          className="szl__status-bar-fill"
          style={{ width: `${Math.round(status.ratio * 100)}%` }}
        />
      </span>
      <span title={status.message}>{status.message}</span>
    </span>
  );
}
