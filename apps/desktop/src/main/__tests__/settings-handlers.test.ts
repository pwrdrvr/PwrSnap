import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let testDb: Database.Database;

vi.mock("../persistence/db", () => ({
  getDb: () => testDb
}));

const { readSettings, writeSettings } = await import("../settings/settings-store");

function migration(name: string): string {
  return readFileSync(new URL(`../persistence/migrations/${name}`, import.meta.url), "utf8");
}

describe("settings store", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    testDb.exec(migration("0004_settings.sql"));
  });

  afterEach(() => {
    testDb.close();
  });

  test("fresh settings are privacy-preserving", () => {
    expect(readSettings()).toEqual({
      codexCommand: "",
      aiEnabled: false,
      aiConsentAcceptedAt: null
    });
  });

  test("writes and reads AI consent settings", () => {
    const acceptedAt = "2026-05-12T12:00:00.000Z";

    expect(writeSettings({ aiEnabled: true, aiConsentAcceptedAt: acceptedAt })).toEqual({
      codexCommand: "",
      aiEnabled: true,
      aiConsentAcceptedAt: acceptedAt
    });
  });

  test("partial patch does not clear omitted fields", () => {
    writeSettings({
      codexCommand: "/Applications/Codex.app/Contents/Resources/codex",
      aiEnabled: true,
      aiConsentAcceptedAt: "2026-05-12T12:00:00.000Z"
    });

    expect(writeSettings({ aiEnabled: false })).toEqual({
      codexCommand: "/Applications/Codex.app/Contents/Resources/codex",
      aiEnabled: false,
      aiConsentAcceptedAt: "2026-05-12T12:00:00.000Z"
    });
  });
});
