// CartStore round-trip + persistence semantics. Mirrors the shape of
// sizzle-store.test.ts — real temp files, no mocks, exercising the
// atomic-write + in-memory-cache + parse-fail-quarantine machinery.

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CartStore } from "../cart-store";

let tmpDir = "";
let filePath = "";

function makeStore(): CartStore {
  return new CartStore({ filePath });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pwrsnap-cart-store-"));
  filePath = join(tmpDir, "draft-cart.json");
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("CartStore — basics", () => {
  it("get() on a fresh store returns an empty default cart", async () => {
    const store = makeStore();
    const cart = await store.get();
    expect(cart.name).toBe("Untitled draft");
    expect(cart.captureIds).toEqual([]);
    expect(typeof cart.createdAt).toBe("string");
    expect(typeof cart.modifiedAt).toBe("string");
  });

  it("toggle() adds an absent id and removes a present one", async () => {
    const store = makeStore();
    let cart = await store.toggle("cap-1");
    expect(cart.captureIds).toEqual(["cap-1"]);
    cart = await store.toggle("cap-2");
    expect(cart.captureIds).toEqual(["cap-1", "cap-2"]);
    // Toggling cap-1 again removes it.
    cart = await store.toggle("cap-1");
    expect(cart.captureIds).toEqual(["cap-2"]);
  });

  it("toggle() appends new ids to the END (check order)", async () => {
    const store = makeStore();
    await store.toggle("a");
    await store.toggle("b");
    const cart = await store.toggle("c");
    expect(cart.captureIds).toEqual(["a", "b", "c"]);
  });

  it("remove() drops an id; no-op for absent id", async () => {
    const store = makeStore();
    await store.toggle("a");
    await store.toggle("b");
    let cart = await store.remove("a");
    expect(cart.captureIds).toEqual(["b"]);
    cart = await store.remove("nonexistent");
    expect(cart.captureIds).toEqual(["b"]);
  });

  it("rename() sets the name; blank collapses to the default", async () => {
    const store = makeStore();
    let cart = await store.rename("My Reel");
    expect(cart.name).toBe("My Reel");
    cart = await store.rename("   ");
    expect(cart.name).toBe("Untitled draft");
  });

  it("clear() empties ids + resets name but keeps createdAt", async () => {
    const store = makeStore();
    await store.rename("Something");
    await store.toggle("a");
    const before = await store.get();
    const cart = await store.clear();
    expect(cart.captureIds).toEqual([]);
    expect(cart.name).toBe("Untitled draft");
    expect(cart.createdAt).toBe(before.createdAt);
  });

  it("bumps modifiedAt on mutation", async () => {
    const store = makeStore();
    const before = await store.get();
    // Force a measurable clock tick.
    await new Promise((r) => setTimeout(r, 5));
    const after = await store.toggle("a");
    expect(new Date(after.modifiedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.modifiedAt).getTime()
    );
  });
});

describe("CartStore — reorder", () => {
  it("moves an item from one index to another", async () => {
    const store = makeStore();
    for (const id of ["a", "b", "c", "d"]) await store.toggle(id);
    const cart = await store.reorder(0, 2);
    expect(cart.captureIds).toEqual(["b", "c", "a", "d"]);
  });

  it("clamps an out-of-range `to`", async () => {
    const store = makeStore();
    for (const id of ["a", "b", "c"]) await store.toggle(id);
    const cart = await store.reorder(0, 99);
    expect(cart.captureIds).toEqual(["b", "c", "a"]);
  });

  it("no-ops an out-of-range `from`", async () => {
    const store = makeStore();
    for (const id of ["a", "b"]) await store.toggle(id);
    const cart = await store.reorder(5, 0);
    expect(cart.captureIds).toEqual(["a", "b"]);
  });

  it("no-ops when from === clamped to", async () => {
    const store = makeStore();
    for (const id of ["a", "b"]) await store.toggle(id);
    const cart = await store.reorder(1, 1);
    expect(cart.captureIds).toEqual(["a", "b"]);
  });
});

describe("CartStore — persistence", () => {
  it("persists across store instances (survives 'restart')", async () => {
    const store1 = makeStore();
    await store1.rename("Persisted");
    await store1.toggle("a");
    await store1.toggle("b");

    // A fresh store reading the same file = simulated app restart.
    const store2 = makeStore();
    const cart = await store2.get();
    expect(cart.name).toBe("Persisted");
    expect(cart.captureIds).toEqual(["a", "b"]);
  });

  it("missing file returns the default cart", async () => {
    const store = makeStore();
    expect((await store.get()).captureIds).toEqual([]);
  });

  it("parse-fail quarantines the corrupt file and returns default", async () => {
    await writeFile(filePath, "this is not json", "utf8");
    const store = makeStore();
    const cart = await store.get();
    expect(cart.captureIds).toEqual([]);
    const entries = await readdir(tmpDir);
    expect(entries.filter((e) => e.includes(".corrupt-"))).toHaveLength(1);
  });

  it("sanitizes a malformed-but-parseable cart (drops non-string ids)", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        cart: {
          name: "Mixed",
          captureIds: ["good", 42, "", null, "alsogood"],
          createdAt: "2026-05-28T00:00:00.000Z",
          modifiedAt: "2026-05-28T00:00:00.000Z"
        }
      }),
      "utf8"
    );
    const store = makeStore();
    const cart = await store.get();
    expect(cart.name).toBe("Mixed");
    expect(cart.captureIds).toEqual(["good", "alsogood"]);
  });

  it("write does not leave a .tmp sibling — atomic rename", async () => {
    const store = makeStore();
    await store.toggle("a");
    const entries = await readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries.filter((e) => e === "draft-cart.json")).toHaveLength(1);
  });

  it("serializes concurrent mutations (no lost writes)", async () => {
    const store = makeStore();
    // Fire several toggles without awaiting between them — the
    // internal write queue must serialize them so every id lands.
    await Promise.all([
      store.toggle("a"),
      store.toggle("b"),
      store.toggle("c"),
      store.toggle("d")
    ]);
    const cart = await store.get();
    expect([...cart.captureIds].sort()).toEqual(["a", "b", "c", "d"]);
  });
});
