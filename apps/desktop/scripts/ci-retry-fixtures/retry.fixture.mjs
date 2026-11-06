import { test, expect } from "@playwright/test";

const first = process.env.PWRSNAP_RETRY_FIXTURE_PHASE === "first";
test("first failed case", () => expect(first).toBe(false));
test("passing case is never retried", () => expect(first).toBe(true));
test("second failed case", () => expect(first).toBe(false));
