import { expect, test } from "vitest";
import { sizzleLibraryCutSummary } from "../sizzle-media-trim";
const segments = [{ start: 0, end: 3 }, { start: 10, end: 20 }];
test.each([
  [{ startSec: 5, endSec: 15 }, { keptSec: 5, removedSec: 5, cutCount: 1 }],
  [{ startSec: 0, endSec: 7 }, { keptSec: 3, removedSec: 4, cutCount: 1 }],
  [{ startSec: 0, endSec: 15 }, { keptSec: 8, removedSec: 7, cutCount: 1 }],
  [{ startSec: 10, endSec: 15 }, null],
  [{ startSec: 5, endSec: 7 }, null]
])("cut controls describe footage skipped inside %j", (trim, expected) => {
  expect(sizzleLibraryCutSummary(trim, segments)).toEqual(expected);
});
test("touching splits do not show cut controls", () => {
  expect(sizzleLibraryCutSummary({ startSec: 0, endSec: 20 }, [{ start: 0, end: 10 }, { start: 10, end: 20 }])).toBeNull();
});
