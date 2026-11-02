// Which duplicate families just changed — the source of
// `events:families:changed`.
//
// The captures repo raises it at the only writes that can change a
// family: inserting a member, rooting a family, and trashing, restoring
// or purging a member. Raising it at the writes rather than in each
// handler means a new trash or purge path cannot forget it.
//
// It is raised inside the write's transaction. That is safe because
// better-sqlite3 commits synchronously, before any renderer can act on
// the IPC message; a transaction that rolls back costs only one
// unnecessary refetch.
//
// This module stays free of Electron so the repo (and its tests) can
// import it; events.ts installs the broadcaster.

type FamiliesChangedListener = (familyIds: string[]) => void;

let listener: FamiliesChangedListener | null = null;

export function setFamiliesChangedListener(next: FamiliesChangedListener | null): void {
  listener = next;
}

/** Report families that changed. Nulls (captures outside any family) are
 *  dropped, so callers can pass a row's `family_id` as read. */
export function notifyFamiliesChanged(familyIds: ReadonlyArray<string | null | undefined>): void {
  if (listener === null) return;
  const ids = [...new Set(familyIds.filter((id): id is string => typeof id === "string"))];
  if (ids.length > 0) listener(ids);
}
