// Bus-boundary validation for `settings:open`. An unknown PAGE is an error —
// there is nothing sensible to open. An unknown SUB is not: a deep link to a
// renamed screen, or to a provider this build does not know, must still get
// the operator into Settings, so the sub is dropped (the page's hub opens)
// and reported through `droppedSub` for the handler to log.

import { describe, expect, test } from "vitest";
import { SETTINGS_PAGE_SUBS, type SettingsPage } from "@pwrsnap/shared";
import { validateSettingsOpen } from "../settings-validators";

function open(req: unknown) {
  return validateSettingsOpen(req as { page?: SettingsPage; sub?: string });
}

describe("validateSettingsOpen", () => {
  test("no page and no sub opens Settings where it was", () => {
    expect(open({})).toEqual({
      ok: true,
      value: { page: undefined, sub: undefined, droppedSub: false }
    });
  });

  test("a page alone is its hub", () => {
    expect(open({ page: "hotkeys" })).toEqual({
      ok: true,
      value: { page: "hotkeys", sub: undefined, droppedSub: false }
    });
  });

  test("every listed sub is accepted on the page that owns it", () => {
    for (const [page, subs] of Object.entries(SETTINGS_PAGE_SUBS) as Array<
      [SettingsPage, readonly string[]]
    >) {
      for (const sub of subs) {
        expect(open({ page, sub })).toEqual({
          ok: true,
          value: { page, sub, droppedSub: false }
        });
      }
    }
  });

  test("a sub belongs to one page: an AI Features section is not a provider screen", () => {
    expect(open({ page: "ai", sub: "usage" })).toEqual({
      ok: true,
      value: { page: "ai", sub: undefined, droppedSub: true }
    });
    expect(open({ page: "ai-features", sub: "codex" })).toEqual({
      ok: true,
      value: { page: "ai-features", sub: undefined, droppedSub: true }
    });
  });

  test.each([
    ["an unknown provider", { page: "ai", sub: "claude" }, "ai"],
    ["an empty sub", { page: "ai", sub: "" }, "ai"],
    ["a non-string sub", { page: "ai", sub: 42 }, "ai"],
    ["a hash-splicing sub", { page: "ai", sub: "codex&page=developer" }, "ai"],
    ["a sub on a page that has none", { page: "hotkeys", sub: "codex" }, "hotkeys"],
    ["a prototype key", { page: "ai", sub: "__proto__" }, "ai"]
  ])("drops %s and keeps the page", (_label, req, page) => {
    expect(open(req)).toEqual({
      ok: true,
      value: { page, sub: undefined, droppedSub: true }
    });
  });

  test("a sub with no page has nothing to belong to, and is dropped", () => {
    expect(open({ sub: "codex" })).toEqual({
      ok: true,
      value: { page: undefined, sub: undefined, droppedSub: true }
    });
  });

  test("an unknown page is still an error, sub or not", () => {
    for (const req of [{ page: "not-a-page" }, { page: "not-a-page", sub: "codex" }]) {
      const result = open(req);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toMatchObject({ kind: "validation", code: "invalid_page" });
    }
  });
});
