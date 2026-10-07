import { describe, expect, test } from "vitest";
import { EditHistory, type EditHistorySource } from "../edit-history";

/** A toy stack: each edit replaces `value`, and undo/redo swap entries
 *  the way the real hooks do (an entry keeps its stamp as it crosses). */
function stack(history: EditHistory, log: string[], name: string) {
  let value = 0;
  let past: Array<{ stamp: number; value: number }> = [];
  let future: Array<{ stamp: number; value: number }> = [];
  const step = (from: typeof past, to: typeof past, verb: string): void => {
    const entry = from.pop()!;
    to.push({ stamp: entry.stamp, value });
    value = entry.value;
    log.push(`${verb} ${name}`);
  };
  const source: EditHistorySource = {
    pastStamp: () => past.at(-1)?.stamp,
    futureStamp: () => future.at(-1)?.stamp,
    undo: () => step(past, future, "undo"),
    redo: () => step(future, past, "redo"),
    dropFuture: () => {
      future = [];
    }
  };
  history.register(source);
  return {
    edit(next: number): void {
      past.push({ stamp: history.stamp(source), value });
      future = [];
      value = next;
    },
    get value() {
      return value;
    },
    reset(): void {
      past = [];
      future = [];
    }
  };
}

describe("EditHistory", () => {
  test("undo walks two stacks newest first, redo replays oldest first", () => {
    const history = new EditHistory();
    const log: string[] = [];
    const trim = stack(history, log, "trim");
    const presenter = stack(history, log, "presenter");
    trim.edit(1);
    presenter.edit(1);
    trim.edit(2);
    expect(history.canRedo()).toBe(false);
    history.undo();
    history.undo();
    history.undo();
    expect(history.canUndo()).toBe(false);
    expect(log).toEqual(["undo trim", "undo presenter", "undo trim"]);
    history.redo();
    history.redo();
    expect(log.slice(3)).toEqual(["redo trim", "redo presenter"]);
    expect([trim.value, presenter.value]).toEqual([1, 1]);
  });

  test("a fresh edit in one stack drops the other stack's redo", () => {
    const history = new EditHistory();
    const log: string[] = [];
    const trim = stack(history, log, "trim");
    const presenter = stack(history, log, "presenter");
    trim.edit(1);
    history.undo();
    expect(history.canRedo()).toBe(true);
    presenter.edit(5);
    expect(history.canRedo()).toBe(false);
    history.undo();
    expect(log).toEqual(["undo trim", "undo presenter"]);
  });
});
