// Pure-logic tests for the hash → page parser. The React hook is a
// thin wrapper around this function and a `hashchange` listener, so
// we test the function directly and skip the DOM-bound hook entirely.

import { describe, expect, test } from "vitest";
import { pageFromHash } from "../useActivePage";

describe("pageFromHash", () => {
  test("defaults to 'general' when no hash is set", () => {
    expect(pageFromHash("")).toBe("general");
    expect(pageFromHash("#")).toBe("general");
  });

  test("defaults to 'general' when 'page' param is missing", () => {
    expect(pageFromHash("#stage=settings")).toBe("general");
  });

  test("returns the page id when valid", () => {
    expect(pageFromHash("#stage=settings&page=hotkeys")).toBe("hotkeys");
    expect(pageFromHash("#page=about")).toBe("about");
    expect(pageFromHash("#stage=settings&page=ai")).toBe("ai");
  });

  test("falls back to 'general' on unknown page values", () => {
    expect(pageFromHash("#stage=settings&page=bogus")).toBe("general");
    expect(pageFromHash("#page=")).toBe("general");
    expect(pageFromHash("#page=__proto__")).toBe("general");
  });

  test("ignores other params in the hash", () => {
    expect(pageFromHash("#foo=bar&stage=settings&page=general&baz=qux")).toBe("general");
  });

  test("strips a leading '#' regardless of placement", () => {
    expect(pageFromHash("stage=settings&page=storage")).toBe("storage");
    expect(pageFromHash("#stage=settings&page=storage")).toBe("storage");
  });
});
