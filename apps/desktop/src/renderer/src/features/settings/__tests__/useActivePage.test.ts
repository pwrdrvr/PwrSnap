// Pure-logic tests for the hash → page parser. The React hook is a
// thin wrapper around this function and a `hashchange` listener, so
// we test the function directly and skip the DOM-bound hook entirely.

import { describe, expect, test } from "vitest";
import { pageFromHash } from "../useActivePage";

describe("pageFromHash", () => {
  test("defaults to 'ai' when no hash is set", () => {
    expect(pageFromHash("")).toBe("ai");
    expect(pageFromHash("#")).toBe("ai");
  });

  test("defaults to 'ai' when 'page' param is missing", () => {
    expect(pageFromHash("#stage=settings")).toBe("ai");
  });

  test("returns the page id when valid", () => {
    expect(pageFromHash("#stage=settings&page=hotkeys")).toBe("hotkeys");
    expect(pageFromHash("#page=about")).toBe("about");
    expect(pageFromHash("#stage=settings&page=experimental")).toBe("experimental");
  });

  test("falls back to 'ai' on unknown page values", () => {
    expect(pageFromHash("#stage=settings&page=bogus")).toBe("ai");
    expect(pageFromHash("#page=")).toBe("ai");
    expect(pageFromHash("#page=__proto__")).toBe("ai");
  });

  test("ignores other params in the hash", () => {
    expect(pageFromHash("#foo=bar&stage=settings&page=output&baz=qux")).toBe("output");
  });

  test("strips a leading '#' regardless of placement", () => {
    expect(pageFromHash("stage=settings&page=storage")).toBe("storage");
    expect(pageFromHash("#stage=settings&page=storage")).toBe("storage");
  });
});
