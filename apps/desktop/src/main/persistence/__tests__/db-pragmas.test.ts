import { describe, expect, test, vi } from "vitest";

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn()
  })
}));

vi.mock("../native-binding", () => ({
  getNativeBinding: () => undefined
}));

describe("configureDatabaseConnection", () => {
  test("sets explicit WAL and SSD-retention bounds", async () => {
    const calls: string[] = [];
    const { configureDatabaseConnection, JOURNAL_SIZE_LIMIT_BYTES, WAL_AUTOCHECKPOINT_PAGES } =
      await import("../db");

    configureDatabaseConnection({
      pragma: (sql: string): void => {
        calls.push(sql);
      }
    } as never);

    expect(calls).toContain("journal_mode = WAL");
    expect(calls).toContain("synchronous = NORMAL");
    expect(calls).toContain(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    expect(calls).toContain(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`);
    expect(calls).toContain("foreign_keys = ON");
  });
});
