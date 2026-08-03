// Policy gate: every Playwright spec must take `test` (and `expect`)
// from the e2e fixture, never from `@playwright/test` directly.
//
// The fixture's exported `test` carries the leaked-app guard — an auto
// fixture whose teardown force-closes any Electron app a test left
// running (a test that times out mid-await is ABANDONED, so its
// `finally { app.close() }` never runs). A spec that imports `test`
// from `@playwright/test` silently opts out of the guard: one hung
// test then leaks a resident Electron app, Playwright's worker
// teardown hangs 30s gracefully closing a process that never exits,
// and the job fails with "1 error was not a part of any test" even
// when the retry passed. Seen live on the macOS VM lane (PR #353).
//
// Type-only imports (`type Page`, `type Locator`, …) from
// `@playwright/test` are fine — the guard only rides the `test` object.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const e2eDir = join(__dirname, "..", "..", "..", "e2e");

describe("e2e spec imports", () => {
  const specFiles = readdirSync(e2eDir).filter((name) => name.endsWith(".spec.ts"));

  it("finds the e2e specs (glob sanity)", () => {
    expect(specFiles.length).toBeGreaterThan(0);
  });

  it.each(specFiles)(
    "%s imports test/expect from ./fixtures/electron-app, not @playwright/test",
    (name) => {
      const source = readFileSync(join(e2eDir, name), "utf8");
      const offenders: string[] = [];
      const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@playwright\/test"/g;
      for (const match of source.matchAll(importRe)) {
        const wholeImportIsTypeOnly = match[0].startsWith("import type");
        const names = match[1]!
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        for (const entry of names) {
          const isTypeOnly = wholeImportIsTypeOnly || entry.startsWith("type ");
          const bare = entry.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!;
          if (!isTypeOnly && (bare === "test" || bare === "expect")) {
            offenders.push(entry);
          }
        }
      }
      expect(
        offenders,
        `${name} imports [${offenders.join(", ")}] from "@playwright/test" — ` +
          `import them from "./fixtures/electron-app" instead so the ` +
          `leaked-app guard applies (see fixtures/electron-app.ts header)`
      ).toEqual([]);
    }
  );
});
