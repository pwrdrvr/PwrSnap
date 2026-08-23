import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  capturePathReferencePredicate,
  capturePathReferencePrefix
} from "../capture-path-references";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE path_rows (id TEXT PRIMARY KEY, stored_path TEXT NOT NULL)");
});

afterEach(() => {
  db.close();
});

function matchingIds(root: string, platform: string): string[] {
  const predicate = capturePathReferencePredicate("stored_path", platform);
  return (
    db
      .prepare(`SELECT id FROM path_rows WHERE ${predicate} ORDER BY id`)
      .all({ prefix: capturePathReferencePrefix(root, platform) }) as Array<{
      id: string;
    }>
  ).map((row) => row.id);
}

describe("capture path reference queries", () => {
  test("matches Windows drive roots across slash style and case", () => {
    const insert = db.prepare("INSERT INTO path_rows (id, stored_path) VALUES (?, ?)");
    insert.run("backslash", String.raw`C:\Users\ME\AppData\Roaming\PwrSnap\captures\a.png`);
    insert.run("mixed", String.raw`C:\Users\Me/AppData/Roaming/PwrSnap/captures/b.png`);
    insert.run("collision", String.raw`C:\Users\Me\AppData\Roaming\PwrSnap-old\c.png`);

    expect(
      matchingIds(
        String.raw`c:\users\me\appdata\roaming\pwrsnap\captures`,
        "win32"
      )
    ).toEqual(["backslash", "mixed"]);
  });

  test("matches UNC roots without accepting a textual prefix collision", () => {
    const insert = db.prepare("INSERT INTO path_rows (id, stored_path) VALUES (?, ?)");
    insert.run("unc", String.raw`\\Capture-Server\Users\Me\PwrSnap\a.png`);
    insert.run("collision", String.raw`\\capture-server\Users\Me\PwrSnap-old\b.png`);

    expect(
      matchingIds(String.raw`\\capture-server\users\me\pwrsnap`, "win32")
    ).toEqual(["unc"]);
  });

  test("preserves case-sensitive POSIX path boundaries on Darwin", () => {
    const insert = db.prepare("INSERT INTO path_rows (id, stored_path) VALUES (?, ?)");
    insert.run("inside", "/Users/me/Library/Application Support/PwrSnap/a.png");
    insert.run("case", "/Users/ME/Library/Application Support/PwrSnap/b.png");
    insert.run("collision", "/Users/me/Library/Application Support/PwrSnap-old/c.png");

    expect(
      matchingIds("/Users/me/Library/Application Support/PwrSnap", "darwin")
    ).toEqual(["inside"]);
  });
});
