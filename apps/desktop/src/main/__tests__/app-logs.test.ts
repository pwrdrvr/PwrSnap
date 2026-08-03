import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  MAX_BUFFERED_LOG_ENTRIES,
  _resetAppLogsForTests,
  appendAppLogEntry,
  readAppLogSnapshot,
  subscribeAppLogEntries
} from "../app-logs";

describe("app log session buffer", () => {
  beforeEach(() => _resetAppLogsForTests());

  test("returns ordered entries and snapshot metadata", () => {
    appendAppLogEntry({ timestamp: 10, level: "info", scope: "one", line: "first" });
    appendAppLogEntry({ timestamp: 20, level: "warn", line: "second" });

    const snapshot = readAppLogSnapshot({
      debugCollectionEnabled: true,
      logFilePath: "/tmp/library.log"
    });
    expect(snapshot.entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(snapshot.entries.map((entry) => entry.line)).toEqual(["first", "second"]);
    expect(snapshot.debugCollectionEnabled).toBe(true);
    expect(snapshot.logFilePath).toBe("/tmp/library.log");
    expect(snapshot.truncated).toBe(false);
  });

  test("fans out live entries and supports unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppLogEntries(listener);
    const entry = appendAppLogEntry({ timestamp: 10, level: "error", line: "boom" });
    expect(listener).toHaveBeenCalledWith(entry);
    unsubscribe();
    appendAppLogEntry({ timestamp: 20, level: "info", line: "later" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("keeps a bounded tail and marks snapshots truncated", () => {
    for (let index = 0; index <= MAX_BUFFERED_LOG_ENTRIES; index += 1) {
      appendAppLogEntry({ timestamp: index, level: "info", line: `line ${index}` });
    }
    const snapshot = readAppLogSnapshot({ debugCollectionEnabled: false });
    expect(snapshot.entries).toHaveLength(MAX_BUFFERED_LOG_ENTRIES);
    expect(snapshot.entries[0]?.sequence).toBe(2);
    expect(snapshot.entries.at(-1)?.sequence).toBe(MAX_BUFFERED_LOG_ENTRIES + 1);
    expect(snapshot.truncated).toBe(true);
  });
});
