import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAppUpdateInstallAttemptStore } from "../update-install-attempt-store";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-update-attempt-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("createAppUpdateInstallAttemptStore", () => {
  test("writes, reads, and clears a pending update install attempt", () => {
    const store = createAppUpdateInstallAttemptStore(tempRoot());

    const written = store.write({
      expectedVersion: "1.0.0-beta.23",
      fromVersion: "1.0.0-beta.22",
      channel: "prerelease",
      attemptedAt: "2026-06-29T12:00:00.000Z"
    });

    expect(written).toEqual({
      schemaVersion: 1,
      expectedVersion: "1.0.0-beta.23",
      fromVersion: "1.0.0-beta.22",
      channel: "prerelease",
      attemptedAt: "2026-06-29T12:00:00.000Z"
    });
    expect(store.read()).toEqual(written);

    store.clear();
    expect(store.read()).toBeUndefined();
  });

  test("ignores malformed state", () => {
    const store = createAppUpdateInstallAttemptStore(tempRoot());
    writeFileSync(store.filePath(), "not-json", "utf8");

    expect(store.read()).toBeUndefined();
  });
});
