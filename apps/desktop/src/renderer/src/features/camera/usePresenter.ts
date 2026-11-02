// Presenter editing state for the Library's video stage: the resolved
// style, the selection, an optimistic copy while a save is in flight, and
// the keyboard bindings. The stage, its toolbar, the transport button and
// the camera lane all read from here, so they can never disagree.
//
// Every saved change is undoable. The stack joins the stage's EditHistory
// (the trim's), so ⌘Z walks presenter and cut edits in the order they
// happened.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultPresenterStyle,
  geometryFor,
  mapPresenterSpans,
  placeAt,
  resolvePresenterStyle,
  videoPieceAt,
  videoPieces,
  withEdge,
  withFraming,
  withLook,
  withPresenterSpan,
  withSize,
  withSyncNudge,
  type AvatarStyle,
  type CaptureRecord,
  type PresenterGeometry,
  type PresenterSpan,
  type VideoRange
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import type { EditHistory, EditHistorySource } from "../shared/edit-history";
import type { CameraLaneModel } from "./CameraLane";
import type { PresenterEditing } from "./PresenterLayer";
import type { PresenterAction } from "./PresenterToolbar";
import { useActivePresenterSpan, type TimeSubscribe } from "./useActivePresenterSpan";
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
    case "edge":
      return withEdge(style, action.edge);
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

/** Undo depth, as for the trim. */
const PRESENTER_HISTORY_LIMIT = 100;
type PresenterSnapshot = { readonly avatar: AvatarStyle; readonly spans: PresenterSpan[] };
type PresenterEntry = { readonly stamp: number; readonly snapshot: PresenterSnapshot };

/** What an edit on the stage changes once the clip has pieces: the piece
 *  under the playhead, or every piece at once. */
export type PresenterScope = "piece" | "all";

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

/** The fields `next` changed from `shown` — what a drag carries to every
 *  piece when the scope is all of them. */
function changedFields(shown: AvatarStyle, next: AvatarStyle): Partial<AvatarStyle> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof AvatarStyle>) {
    if (JSON.stringify(next[key]) !== JSON.stringify(shown[key])) patch[key] = next[key];
  }
  return patch as Partial<AvatarStyle>;
}

export function usePresenter(
  record: CaptureRecord,
  timeline?: {
    readonly segments: readonly VideoRange[];
    readonly durationSec: number;
    /** The stage's playhead; edits land on the piece it is in. */
    readonly subscribe: TimeSubscribe;
    readonly now: () => number;
    /** The stage's shared undo order. */
    readonly history?: EditHistory;
  }
): PresenterState | null {
  const camera = record.video?.camera ?? null;
  const stored = record.video?.avatar ?? null;
  const storedSpans = record.video?.avatarSpans;
  const [pending, setPending] = useState<AvatarStyle | null>(null);
  const [pendingSpans, setPendingSpans] = useState<PresenterSpan[] | null>(null);
  const [selected, setSelected] = useState(false);
  const [scope, setScope] = useState<PresenterScope>("piece");
  const [error, setError] = useState("");
  const strip = useCameraStrip(record.id, camera);
  const pastRef = useRef<PresenterEntry[]>([]);
  const futureRef = useRef<PresenterEntry[]>([]);

  // A new capture starts unselected; the broadcast that follows a save
  // carries the saved style, which retires the optimistic copy.
  useEffect(() => {
    setSelected(false);
    setPending(null);
    setPendingSpans(null);
    setScope("piece");
    setError("");
    pastRef.current = [];
    futureRef.current = [];
  }, [record.id]);
  useEffect(() => {
    setPending(null);
  }, [stored]);
  useEffect(() => {
    setPendingSpans(null);
  }, [storedSpans]);

  const spans = useMemo(() => pendingSpans ?? storedSpans ?? [], [pendingSpans, storedSpans]);
  const activeIndex = useActivePresenterSpan(spans, timeline?.subscribe ?? null);
  const active = activeIndex >= 0 ? (spans[activeIndex] ?? null) : null;
  const durationSec = timeline?.durationSec ?? record.video?.durationSec ?? 0;
  const keptPieces = timeline
    ? videoPieces(timeline.segments, durationSec).filter((piece) => piece.kind === "kept").length
    : 1;
  // Scope only means something once there is more than one piece, or a
  // piece already has its own presenter.
  const scoped = keptPieces > 1 || spans.length > 0;
  const effectiveScope: PresenterScope = scoped ? scope : "all";

  const geometry = useMemo(
    () =>
      camera === null
        ? null
        : geometryFor(camera, { width: record.width_px || 16, height: record.height_px || 9 }),
    [camera, record.width_px, record.height_px]
  );
  const base = useMemo(
    () => (geometry === null ? null : resolvePresenterStyle(pending ?? stored, geometry)),
    [geometry, pending, stored]
  );
  const style = useMemo(
    () => (geometry === null || base === null ? null : active ? resolvePresenterStyle(active.avatar, geometry) : base),
    [active, base, geometry]
  );

  /** Send a change. `onFailed` runs when it was refused or never
   *  arrived, after the optimistic copy is dropped. */
  const write = useCallback(
    (next: { avatar?: AvatarStyle; spans?: PresenterSpan[] }, onFailed?: () => void): void => {
      if (next.avatar) setPending(next.avatar);
      if (next.spans) setPendingSpans(next.spans);
      const fail = (message: string): void => {
        setPending(null);
        setPendingSpans(null);
        setError(message);
        onFailed?.();
      };
      void dispatch("video:setAvatar", { captureId: record.id, ...next })
        .then((result) => {
          if (result.ok) {
            setError("");
            return;
          }
          fail(result.error.message);
        })
        .catch((cause: unknown) => {
          fail(cause instanceof Error ? cause.message : "The presenter could not be saved.");
        });
    },
    [record.id]
  );

  // What an undo puts back: the recording's presenter and every piece's.
  // Read through a ref so a stack step always snapshots what shows now.
  const snapshotRef = useRef<PresenterSnapshot | null>(null);
  snapshotRef.current = base === null ? null : { avatar: base, spans };
  const history = timeline?.history;
  const sourceRef = useRef<EditHistorySource | null>(null);

  /** Save a change, keeping what it replaced one undo away. */
  const save = useCallback(
    (next: { avatar?: AvatarStyle; spans?: PresenterSpan[] }): void => {
      const before = snapshotRef.current;
      if (before === null) {
        write(next);
        return;
      }
      const source = sourceRef.current;
      const stamp = history && source ? history.stamp(source) : 0;
      const entry: PresenterEntry = { stamp, snapshot: before };
      const future = futureRef.current;
      pastRef.current.push(entry);
      if (pastRef.current.length > PRESENTER_HISTORY_LIMIT) pastRef.current.shift();
      futureRef.current = [];
      // A refused save changed nothing, so it must not leave a step that
      // would "undo" to what already shows. Its own redo comes back too;
      // other stacks' redo, dropped by the stamp, stays dropped.
      write(next, () => {
        const at = pastRef.current.indexOf(entry);
        if (at === -1) return;
        pastRef.current.splice(at, 1);
        if (futureRef.current.length === 0) futureRef.current = future;
      });
    },
    [history, write]
  );

  useEffect(() => {
    if (!history) return;
    const step = (from: { current: PresenterEntry[] }, to: { current: PresenterEntry[] }): void => {
      const entry = from.current.at(-1);
      const now = snapshotRef.current;
      if (entry === undefined || now === null) return;
      from.current.pop();
      const crossed: PresenterEntry = { stamp: entry.stamp, snapshot: now };
      to.current.push(crossed);
      // A refused undo or redo left the presenter where it was: put the
      // step back where it came from, so the next ⌘Z tries it again.
      write({ avatar: entry.snapshot.avatar, spans: entry.snapshot.spans }, () => {
        const at = to.current.indexOf(crossed);
        if (at === -1) return;
        to.current.splice(at, 1);
        from.current.push(entry);
      });
    };
    const source: EditHistorySource = {
      pastStamp: () => pastRef.current.at(-1)?.stamp,
      futureStamp: () => futureRef.current.at(-1)?.stamp,
      undo: () => step(pastRef, futureRef),
      redo: () => step(futureRef, pastRef),
      dropFuture: () => {
        futureRef.current = [];
      }
    };
    sourceRef.current = source;
    const unregister = history.register(source);
    return () => {
      unregister();
      sourceRef.current = null;
    };
  }, [history, write]);

  // Read at edit time, not render time: the playhead moves without
  // re-rendering this hook.
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const pieceRange = useCallback((): VideoRange | null => {
    const t = timelineRef.current;
    if (!t) return null;
    const piece = videoPieceAt(t.segments, durationSec, t.now());
    return piece === null ? null : { start: piece.start, end: piece.end };
  }, [durationSec]);

  /** Apply one change in the current scope. `edit` maps a presenter to
   *  its new value; `null` from it means "give this piece back". */
  const apply = useCallback(
    (edit: (style: AvatarStyle) => AvatarStyle | null, wholeReset = false): void => {
      if (style === null || base === null || geometry === null) return;
      if (effectiveScope === "piece") {
        const range = pieceRange();
        if (range === null) return;
        save({ spans: withPresenterSpan(spans, range, edit(style), durationSec) });
        return;
      }
      const nextBase = edit(base) ?? base;
      save(
        wholeReset
          ? { avatar: nextBase, spans: [] }
          : {
              avatar: nextBase,
              ...(spans.length > 0
                ? { spans: mapPresenterSpans(spans, (a) => edit(resolvePresenterStyle(a, geometry)) ?? a) }
                : {})
            }
      );
    },
    [base, durationSec, effectiveScope, geometry, pieceRange, save, spans, style]
  );

  const act = useCallback(
    (action: PresenterAction): void => {
      if (style === null || geometry === null) return;
      if (action.type === "inherit") {
        // Only offered in piece scope, over a piece with its own presenter.
        apply(() => null);
        return;
      }
      const next = applyPresenterAction(style, action, geometry);
      if (next === null) return;
      if (action.type === "toggleVisible" && !next.visible) setSelected(false);
      apply((current) => applyPresenterAction(current, action, geometry), action.type === "reset");
    },
    [apply, geometry, style]
  );

  /** A drag, a resize or a lane drag: the full new style of what shows. */
  const change = useCallback(
    (next: AvatarStyle): void => {
      if (style === null) return;
      const patch = changedFields(style, next);
      apply((current) => ({ ...current, ...patch }));
    },
    [apply, style]
  );

  if (camera === null || style === null || geometry === null) return null;
  const pieceHasOwn = effectiveScope === "piece" && active !== null;
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
      onChange: change,
      onAction: act,
      posterUrl: strip.posterUrl ?? undefined,
      inheritable: pieceHasOwn,
      inheritLabel: "Use the recording’s presenter here",
      tag: !scoped ? "Presenter" : effectiveScope === "all" ? "Presenter · all pieces" : "Presenter · this piece",
      ...(scoped ? { scope: { value: scope, onChange: setScope } } : {})
    },
    lane: {
      track: camera,
      style,
      selected,
      captureId: record.id,
      missing: strip.missing,
      spans,
      onSelect: () => setSelected(true),
      onSyncChange: (syncOffsetSec) => change({ ...style, syncOffsetSec })
    }
  };
}
