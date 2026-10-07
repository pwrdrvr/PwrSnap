// Presenter editing state for the Library's video stage: the resolved
// style, the selection, an optimistic copy while a save is in flight, and
// the keyboard bindings. The stage, its toolbar, the transport button and
// the camera lane all read from here, so they can never disagree.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  defaultPresenterStyle,
  geometryFor,
  placeAt,
  resolvePresenterStyle,
  withFraming,
  withLook,
  withSize,
  withSyncNudge,
  type AvatarStyle,
  type CaptureRecord,
  type PresenterGeometry
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import type { CameraLaneModel } from "./CameraLane";
import type { PresenterEditing } from "./PresenterLayer";
import type { PresenterAction } from "./PresenterToolbar";
import { useCameraStrip } from "./useCameraStrip";

export function applyPresenterAction(
  style: AvatarStyle,
  action: PresenterAction,
  geometry: PresenterGeometry
): AvatarStyle | null {
  switch (action.type) {
    case "toggleVisible":
      return { ...style, visible: !style.visible };
    case "look":
      return withLook(style, action.look, geometry);
    case "framing":
      return withFraming(style, action.framing, geometry);
    case "mirror":
      return { ...style, mirror: !style.mirror };
    case "place":
      return placeAt(style, action.anchor, geometry);
    case "size":
      return withSize(style, action.size, geometry);
    case "sync":
      return withSyncNudge(style, action.frames);
    case "reset":
      return { ...defaultPresenterStyle(geometry), visible: style.visible };
    case "inherit":
      return null;
  }
}

/** Keys the stage hands to the presenter before its transport keymap.
 *  `H` works whenever the recording has a camera; the rest only while the
 *  presenter is selected. */
export function presenterKeyAction(
  event: { key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  selected: boolean
): PresenterAction | "deselect" | null {
  if (event.metaKey || event.ctrlKey) return null;
  if (!event.altKey && !event.shiftKey && event.key.toLowerCase() === "h") return { type: "toggleVisible" };
  if (!selected) return null;
  if (event.key === "Escape") return "deselect";
  if (event.altKey && event.key === "ArrowLeft") return { type: "sync", frames: event.shiftKey ? -10 : -1 };
  if (event.altKey && event.key === "ArrowRight") return { type: "sync", frames: event.shiftKey ? 10 : 1 };
  return null;
}

export type PresenterState = {
  readonly style: AvatarStyle;
  readonly geometry: PresenterGeometry;
  readonly selected: boolean;
  readonly setSelected: (selected: boolean) => void;
  readonly act: (action: PresenterAction) => void;
  readonly editing: PresenterEditing;
  readonly lane: CameraLaneModel;
  readonly error: string;
};

export function usePresenter(record: CaptureRecord): PresenterState | null {
  const camera = record.video?.camera ?? null;
  const stored = record.video?.avatar ?? null;
  const [pending, setPending] = useState<AvatarStyle | null>(null);
  const [selected, setSelected] = useState(false);
  const [error, setError] = useState("");
  const strip = useCameraStrip(record.id, camera);

  // A new capture starts unselected; the broadcast that follows a save
  // carries the saved style, which retires the optimistic copy.
  useEffect(() => {
    setSelected(false);
    setPending(null);
    setError("");
  }, [record.id]);
  useEffect(() => {
    setPending(null);
  }, [stored]);

  const geometry = useMemo(
    () =>
      camera === null
        ? null
        : geometryFor(camera, { width: record.width_px || 16, height: record.height_px || 9 }),
    [camera, record.width_px, record.height_px]
  );
  const style = useMemo(
    () => (geometry === null ? null : resolvePresenterStyle(pending ?? stored, geometry)),
    [geometry, pending, stored]
  );

  const save = useCallback(
    (next: AvatarStyle): void => {
      setPending(next);
      void dispatch("video:setAvatar", { captureId: record.id, avatar: next })
        .then((result) => {
          if (result.ok) {
            setError("");
            return;
          }
          setPending(null);
          setError(result.error.message);
        })
        .catch((cause: unknown) => {
          setPending(null);
          setError(cause instanceof Error ? cause.message : "The presenter could not be saved.");
        });
    },
    [record.id]
  );

  const act = useCallback(
    (action: PresenterAction): void => {
      if (style === null || geometry === null) return;
      const next = applyPresenterAction(style, action, geometry);
      if (next === null) return;
      if (action.type === "toggleVisible" && !next.visible) setSelected(false);
      save(next);
    },
    [geometry, save, style]
  );

  if (camera === null || style === null || geometry === null) return null;
  return {
    style,
    geometry,
    selected,
    setSelected,
    act,
    error,
    editing: {
      selected,
      onSelect: setSelected,
      onChange: save,
      onAction: act,
      posterUrl: strip.posterUrl ?? undefined
    },
    lane: {
      track: camera,
      style,
      selected,
      captureId: record.id,
      missing: strip.missing,
      onSelect: () => setSelected(true),
      onSyncChange: (syncOffsetSec) => save({ ...style, syncOffsetSec })
    }
  };
}
