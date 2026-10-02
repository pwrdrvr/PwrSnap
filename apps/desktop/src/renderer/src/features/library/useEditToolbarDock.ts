// Where the Library's edit toolbar lives: floating over the canvas, or
// docked to one edge of the stage (`library.editToolbarDock`).
//
// One module-level store per window, not per mount. EditToolbar remounts
// whenever Stage does (Focus ↔ Reel, Grid → Focus), and a per-mount read
// would paint the floating toolbar for a frame and then dock it, re-fitting
// the snap twice. Library primes the store from its own boot-time
// `settings:read`, so by the time a Stage mounts the value is already here.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  EVENT_CHANNELS,
  isEditToolbarDock,
  type EditToolbarDock,
  type SettingsChangedEvent
} from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";

let current: EditToolbarDock = "float";
let hydrated = false;
let reading = false;
const listeners = new Set<() => void>();

function set(next: EditToolbarDock): void {
  hydrated = true;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Seed the store from a settings snapshot the caller already has. */
export function primeEditToolbarDock(value: unknown): void {
  if (isEditToolbarDock(value)) set(value);
}

/** Test seam: back to a fresh window's state. */
export function resetEditToolbarDockForTests(): void {
  current = "float";
  hydrated = false;
  reading = false;
  listeners.clear();
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditToolbarDock(): {
  readonly dock: EditToolbarDock;
  readonly setDock: (next: EditToolbarDock) => void;
} {
  const dock = useSyncExternalStore(subscribeStore, () => current);

  useEffect(() => {
    if (hydrated || reading) return;
    reading = true;
    void dispatch("settings:read", {}).then((result) => {
      reading = false;
      if (result.ok && !hydrated) primeEditToolbarDock(result.value?.library?.editToolbarDock);
    });
  }, []);

  useEffect(
    () =>
      subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
        // A partial broadcast (no snapshot) leaves the store alone.
        primeEditToolbarDock((payload as Partial<SettingsChangedEvent> | null)?.settings?.library?.editToolbarDock);
      }),
    []
  );

  const setDock = useCallback((next: EditToolbarDock): void => {
    // Local first, so the layout answers the click without a round trip;
    // the broadcast that follows the write carries the same value.
    set(next);
    void dispatch("settings:write", { library: { editToolbarDock: next } });
  }, []);

  return { dock, setDock };
}

export type DockEdge = Exclude<EditToolbarDock, "float">;

/** How close to an edge of the stage the pointer must be, while the grip
 *  is held, for that edge to take the toolbar on release. */
export const DOCK_ZONE_PX = 56;

/** The edge a grip drag would dock to with the pointer at (x, y), or null
 *  to keep floating. Decided by the POINTER, never by the toolbar's box: a
 *  toolbar nearly as wide as the stage cannot reach the right edge, but the
 *  hand can. Inside two zones at once (a corner), the nearer edge wins. */
export function dockZoneAt(x: number, y: number, stage: DOMRect | null): DockEdge | null {
  if (stage === null) return null;
  // Past an edge counts as at it: the grip holds pointer capture, so a
  // pointer that overshoots onto the detail rail is still aiming right.
  const distance: Record<DockEdge, number> = {
    top: y - stage.top,
    bottom: stage.bottom - y,
    left: x - stage.left,
    right: stage.right - x
  };
  let best: DockEdge | null = null;
  let nearest = DOCK_ZONE_PX;
  for (const edge of ["top", "bottom", "left", "right"] as const) {
    if (distance[edge] < nearest) {
      nearest = distance[edge];
      best = edge;
    }
  }
  return best;
}
