// Boot-time sync peek at experimental.processSplit. The contract that
// matters: every failure mode returns TRUE (the shipped default) —
// a missing or corrupt settings file must not silently flip a Mac
// back to single-process mode.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { peekExperimentalProcessSplit } from "../process-split/settings-peek";

function userDataWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pwrsnap-peek-"));
  const path = join(dir, "pwrsnap-settings.json");
  writeFileSync(path, content);
  return dir;
}

describe("peekExperimentalProcessSplit", () => {
  test("reads an explicit false (the user's opt-out)", () => {
    expect(
      peekExperimentalProcessSplit(
        userDataWith(JSON.stringify({ schemaVersion: 1, experimental: { processSplit: false } }))
      )
    ).toBe(false);
  });

  test("reads an explicit true", () => {
    expect(
      peekExperimentalProcessSplit(
        userDataWith(JSON.stringify({ experimental: { processSplit: true } }))
      )
    ).toBe(true);
  });

  test("missing file → default OFF (single-process)", () => {
    expect(
      peekExperimentalProcessSplit(join(tmpdir(), "pwrsnap-peek-nonexistent"))
    ).toBe(false);
  });

  test("pre-experimental settings file → default OFF", () => {
    expect(
      peekExperimentalProcessSplit(
        userDataWith(JSON.stringify({ schemaVersion: 1, general: { developerMode: true } }))
      )
    ).toBe(false);
  });

  test("corrupt JSON and wrong-typed values → default OFF", () => {
    expect(peekExperimentalProcessSplit(userDataWith("{not json"))).toBe(false);
    expect(
      peekExperimentalProcessSplit(
        userDataWith(JSON.stringify({ experimental: { processSplit: "yes" } }))
      )
    ).toBe(false);
    expect(peekExperimentalProcessSplit(userDataWith(JSON.stringify(null)))).toBe(false);
  });
});
