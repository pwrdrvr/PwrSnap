import type { AppLogEntry, AppLogSnapshot } from "@pwrsnap/shared";

/**
 * Main-process log tail kept for the in-app Logs window.
 *
 * The durable file remains the post-mortem source of truth. This bounded ring
 * is the live/session view: it captures boot messages before the window opens,
 * snapshots in one pass, and fans new entries out without polling the file.
 */
export const MAX_BUFFERED_LOG_ENTRIES = 5000;

type AppLogEntryListener = (entry: AppLogEntry) => void;

const entries = new Array<AppLogEntry | undefined>(MAX_BUFFERED_LOG_ENTRIES);
const listeners = new Set<AppLogEntryListener>();
let nextSequence = 1;
let oldestEntryIndex = 0;
let bufferedEntryCount = 0;
let droppedEntries = 0;

export function appendAppLogEntry(entry: Omit<AppLogEntry, "sequence">): AppLogEntry {
  const stored: AppLogEntry = {
    ...entry,
    sequence: nextSequence
  };
  nextSequence += 1;

  if (bufferedEntryCount < entries.length) {
    const writeIndex = (oldestEntryIndex + bufferedEntryCount) % entries.length;
    entries[writeIndex] = stored;
    bufferedEntryCount += 1;
  } else {
    entries[oldestEntryIndex] = stored;
    oldestEntryIndex = (oldestEntryIndex + 1) % entries.length;
    droppedEntries += 1;
  }

  for (const listener of listeners) listener(stored);
  return stored;
}

export function readAppLogSnapshot(options: {
  debugCollectionEnabled: boolean;
  logFilePath?: string | undefined;
}): AppLogSnapshot {
  return {
    entries: orderedEntries(),
    readAt: Date.now(),
    truncated: droppedEntries > 0,
    debugCollectionEnabled: options.debugCollectionEnabled,
    ...(options.logFilePath !== undefined ? { logFilePath: options.logFilePath } : {})
  };
}

export function subscribeAppLogEntries(listener: AppLogEntryListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function _resetAppLogsForTests(): void {
  entries.fill(undefined);
  listeners.clear();
  nextSequence = 1;
  oldestEntryIndex = 0;
  bufferedEntryCount = 0;
  droppedEntries = 0;
}

function orderedEntries(): AppLogEntry[] {
  const ordered: AppLogEntry[] = [];
  for (let offset = 0; offset < bufferedEntryCount; offset += 1) {
    const entry = entries[(oldestEntryIndex + offset) % entries.length];
    if (entry !== undefined) ordered.push(entry);
  }
  return ordered;
}
