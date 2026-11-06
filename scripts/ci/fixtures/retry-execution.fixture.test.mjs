import { describe, test, expect } from "vitest";

const phase = process.env.PWRSNAP_UNIT_ORACLE_PHASE;
test("failed first", () => expect(phase).not.toBe("first"));
test("passing test must not run again", () => expect(phase).not.toBe("retry"));

describe("outer", () => {
  describe.skip("platform-skipped suite", () => {
    test("never executes", () => { throw new Error("skipped test executed"); });
  });
});
