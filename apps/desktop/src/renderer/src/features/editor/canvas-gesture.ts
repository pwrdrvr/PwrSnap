import type { AffineTransform, OverlayRow, StrokeEraseSession } from "@pwrsnap/shared";
import type { Draft, DraftStroke } from "./editor-types";
import type { InteractionToken } from "./useUndoRedo";

/** Only the pointer that acquired the canvas can move or finish its gesture.
 * The render draft is a snapshot; terminal events read this live payload. */
export type CanvasGesture =
  | {
      kind: "draw";
      pointerId: number;
      token: InteractionToken | null;
      stroke: DraftStroke;
      session: StrokeEraseSession | null;
      startedAt: number;
    }
  | {
      kind: "draft";
      pointerId: number;
      token: InteractionToken | null;
      draft: Extract<Draft, { kind: "arrow" | "shape-drag" }>;
    }
  | {
      kind: "selection";
      pointerId: number;
      startXn: number;
      startYn: number;
      snapshots: { id: string; data: OverlayRow["data"] }[];
      rasterSnapshots: { id: string; transform: AffineTransform }[];
    }
  | {
      kind: "raster";
      pointerId: number;
      id: string;
      startXn: number;
      startYn: number;
      startTransform: AffineTransform;
      current: AffineTransform;
      moved: boolean;
      homeTransform: AffineTransform | null;
      canvasScreenW: number;
      canvasScreenH: number;
    };
