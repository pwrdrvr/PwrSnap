// Tests for the cart:* command bus handlers. Mocks the CartStore +
// SizzleStore so the SUT is the handler logic (validation gating,
// broadcast firing, commit orchestration), not the persistence layer
// (covered by cart-store.test.ts / sizzle-store.test.ts).

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftCart, SizzleProject } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown) => Promise<unknown>>(),
  cart: {
    get: vi.fn<() => Promise<DraftCart>>(),
    toggle: vi.fn<(id: string) => Promise<DraftCart>>(),
    remove: vi.fn<(id: string) => Promise<DraftCart>>(),
    reorder: vi.fn<(from: number, to: number) => Promise<DraftCart>>(),
    rename: vi.fn<(name: string) => Promise<DraftCart>>(),
    clear: vi.fn<() => Promise<DraftCart>>()
  },
  sizzle: {
    get: vi.fn<(id: string) => Promise<SizzleProject | null>>(),
    create: vi.fn<(name: string) => Promise<SizzleProject>>(),
    update: vi.fn(),
    list: vi.fn<() => Promise<SizzleProject[]>>()
  },
  send: vi.fn()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      { isDestroyed: () => false, webContents: { send: mocks.send } }
    ])
  }
}));

vi.mock("../../command-bus", () => ({
  bus: {
    register: vi.fn((name: string, handler: (req: unknown) => Promise<unknown>) => {
      mocks.handlers.set(name, handler);
    })
  }
}));

vi.mock("../../cart/cart-store", () => ({
  getCartStore: () => mocks.cart
}));

vi.mock("../../sizzle/sizzle-store", () => ({
  getSizzleStore: () => mocks.sizzle,
  SizzleProjectNotFoundError: class SizzleProjectNotFoundError extends Error {
    constructor(public readonly projectId: string) {
      super(`sizzle: project not found: ${projectId}`);
      this.name = "SizzleProjectNotFoundError";
    }
  }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

function makeCart(overrides: Partial<DraftCart> = {}): DraftCart {
  return {
    name: "Untitled draft",
    captureIds: [],
    createdAt: "2026-05-28T00:00:00.000Z",
    modifiedAt: "2026-05-28T00:00:00.000Z",
    ...overrides
  };
}

function makeProject(overrides: Partial<SizzleProject> = {}): SizzleProject {
  return {
    id: "proj-1",
    name: "Untitled",
    createdAt: "2026-05-28T00:00:00.000Z",
    modifiedAt: "2026-05-28T00:00:00.000Z",
    scenes: [],
    voice: "alloy",
    ttsModel: "tts-1",
    ttsProvider: "openai",
    resolution: "1080p",
    outputPath: null,
    lastRenderedAt: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.resetModules();
  mocks.handlers.clear();
  for (const fn of Object.values(mocks.cart)) fn.mockReset();
  for (const fn of Object.values(mocks.sizzle)) fn.mockReset();
  mocks.send.mockReset();
});

async function load(name: string): Promise<(req: unknown) => Promise<unknown>> {
  const { registerCartHandlers } = await import("../cart-handlers");
  registerCartHandlers();
  const h = mocks.handlers.get(name);
  expect(h).toBeDefined();
  return h!;
}

describe("cart:get", () => {
  test("returns the cart from the store", async () => {
    mocks.cart.get.mockResolvedValue(makeCart({ captureIds: ["a"] }));
    const h = await load("cart:get");
    const r = (await h({})) as { ok: true; value: DraftCart };
    expect(r.ok).toBe(true);
    expect(r.value.captureIds).toEqual(["a"]);
  });
});

describe("cart:toggle", () => {
  test("validates captureId", async () => {
    const h = await load("cart:toggle");
    const r = await h({});
    expect(r).toMatchObject({ ok: false, error: { code: "captureId_required" } });
    expect(mocks.cart.toggle).not.toHaveBeenCalled();
  });

  test("toggles + broadcasts cart:changed", async () => {
    mocks.cart.toggle.mockResolvedValue(makeCart({ captureIds: ["cap-1"] }));
    const h = await load("cart:toggle");
    const r = (await h({ captureId: "cap-1" })) as { ok: true; value: DraftCart };
    expect(r.value.captureIds).toEqual(["cap-1"]);
    expect(mocks.cart.toggle).toHaveBeenCalledWith("cap-1");
    expect(mocks.send).toHaveBeenCalledWith(
      "events:cart:changed",
      expect.objectContaining({ cart: expect.any(Object) })
    );
  });
});

describe("cart:reorder", () => {
  test("rejects negative / non-integer indices", async () => {
    const h = await load("cart:reorder");
    expect(await h({ from: -1, to: 0 })).toMatchObject({
      ok: false,
      error: { code: "from_invalid" }
    });
    expect(await h({ from: 0, to: 1.5 })).toMatchObject({
      ok: false,
      error: { code: "to_invalid" }
    });
  });

  test("forwards valid indices + broadcasts", async () => {
    mocks.cart.reorder.mockResolvedValue(makeCart({ captureIds: ["b", "a"] }));
    const h = await load("cart:reorder");
    await h({ from: 0, to: 1 });
    expect(mocks.cart.reorder).toHaveBeenCalledWith(0, 1);
    expect(mocks.send).toHaveBeenCalled();
  });
});

describe("cart:rename", () => {
  test("rejects non-string name", async () => {
    const h = await load("cart:rename");
    expect(await h({ name: 42 })).toMatchObject({
      ok: false,
      error: { code: "name_invalid" }
    });
  });

  test("accepts + forwards a valid name", async () => {
    mocks.cart.rename.mockResolvedValue(makeCart({ name: "Demo" }));
    const h = await load("cart:rename");
    const r = (await h({ name: "Demo" })) as { ok: true; value: DraftCart };
    expect(r.value.name).toBe("Demo");
    expect(mocks.cart.rename).toHaveBeenCalledWith("Demo");
  });
});

describe("cart:clear", () => {
  test("clears + broadcasts", async () => {
    mocks.cart.clear.mockResolvedValue(makeCart());
    const h = await load("cart:clear");
    await h({});
    expect(mocks.cart.clear).toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalled();
  });
});

describe("cart:commitToNewProject", () => {
  test("rejects an empty cart", async () => {
    mocks.cart.get.mockResolvedValue(makeCart({ captureIds: [] }));
    const h = await load("cart:commitToNewProject");
    const r = await h({});
    expect(r).toMatchObject({ ok: false, error: { code: "cart_empty" } });
    expect(mocks.sizzle.create).not.toHaveBeenCalled();
  });

  test("creates a project with scenes in cart order, then clears the cart", async () => {
    mocks.cart.get.mockResolvedValue(
      makeCart({ name: "My Reel", captureIds: ["cap-a", "cap-b", "cap-c"] })
    );
    const created = makeProject({ id: "new-proj", name: "My Reel" });
    mocks.sizzle.create.mockResolvedValue(created);
    mocks.sizzle.update.mockImplementation(async (id: string, patch: { scenes?: unknown }) => ({
      ...created,
      id,
      scenes: patch.scenes
    }));
    mocks.cart.clear.mockResolvedValue(makeCart());
    mocks.sizzle.list.mockResolvedValue([created]);

    const h = await load("cart:commitToNewProject");
    const r = (await h({})) as { ok: true; value: SizzleProject };
    expect(r.ok).toBe(true);

    // Project created with the cart's name.
    expect(mocks.sizzle.create).toHaveBeenCalledWith("My Reel");
    // Scenes set in cart order with the right captureIds.
    const updateArgs = mocks.sizzle.update.mock.calls[0]!;
    expect(updateArgs[0]).toBe("new-proj");
    const scenes = (updateArgs[1] as { scenes: Array<{ captureId: string }> }).scenes;
    expect(scenes.map((s) => s.captureId)).toEqual(["cap-a", "cap-b", "cap-c"]);
    // Each scene has the expected defaults.
    expect(scenes[0]).toMatchObject({
      scriptLine: "",
      durationOverrideSec: null,
      mediaTrim: null,
      audioSource: "auto",
      transition: "crossfade"
    });
    // Cart cleared after the commit.
    expect(mocks.cart.clear).toHaveBeenCalled();
    // Both broadcasts fired (cart + projects).
    const channels = mocks.send.mock.calls.map((c) => c[0]);
    expect(channels).toContain("events:cart:changed");
    expect(channels).toContain("events:sizzle:projects:changed");
  });

  test("name override beats the cart name", async () => {
    mocks.cart.get.mockResolvedValue(makeCart({ name: "Cart Name", captureIds: ["a"] }));
    const created = makeProject();
    mocks.sizzle.create.mockResolvedValue(created);
    mocks.sizzle.update.mockResolvedValue(created);
    mocks.cart.clear.mockResolvedValue(makeCart());
    mocks.sizzle.list.mockResolvedValue([created]);
    const h = await load("cart:commitToNewProject");
    await h({ name: "Override" });
    expect(mocks.sizzle.create).toHaveBeenCalledWith("Override");
  });

  test("does NOT clear the cart if project creation throws", async () => {
    mocks.cart.get.mockResolvedValue(makeCart({ captureIds: ["a"] }));
    mocks.sizzle.create.mockRejectedValue(new Error("disk full"));
    const h = await load("cart:commitToNewProject");
    const r = await h({});
    expect(r).toMatchObject({ ok: false, error: { code: "cart_commit_failed" } });
    expect(mocks.cart.clear).not.toHaveBeenCalled();
  });
});

describe("cart:commitToExisting", () => {
  test("rejects an empty cart", async () => {
    mocks.cart.get.mockResolvedValue(makeCart({ captureIds: [] }));
    const h = await load("cart:commitToExisting");
    const r = await h({ projectId: "proj-1" });
    expect(r).toMatchObject({ ok: false, error: { code: "cart_empty" } });
  });

  test("returns not_found for a missing project", async () => {
    mocks.cart.get.mockResolvedValue(makeCart({ captureIds: ["a"] }));
    mocks.sizzle.get.mockResolvedValue(null);
    const h = await load("cart:commitToExisting");
    const r = await h({ projectId: "ghost" });
    expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(mocks.sizzle.update).not.toHaveBeenCalled();
  });

  test("appends only captures not already in the project (de-dup)", async () => {
    mocks.cart.get.mockResolvedValue(
      makeCart({ captureIds: ["existing", "new-1", "new-2"] })
    );
    const project = makeProject({
      id: "proj-1",
      scenes: [
        {
          id: "sc-0",
          captureId: "existing",
          scriptLine: "",
          durationOverrideSec: null,
          mediaTrim: null,
          audioSource: "auto",
          transition: "crossfade"
        }
      ]
    });
    mocks.sizzle.get.mockResolvedValue(project);
    mocks.sizzle.update.mockImplementation(async (id: string, patch: { scenes?: unknown }) => ({
      ...project,
      id,
      scenes: patch.scenes
    }));
    mocks.cart.clear.mockResolvedValue(makeCart());
    mocks.sizzle.list.mockResolvedValue([project]);

    const h = await load("cart:commitToExisting");
    await h({ projectId: "proj-1" });

    const scenes = (mocks.sizzle.update.mock.calls[0]![1] as {
      scenes: Array<{ captureId: string }>;
    }).scenes;
    // Existing scene preserved at the front; only the two NEW captures
    // appended (the duplicate "existing" is skipped).
    expect(scenes.map((s) => s.captureId)).toEqual(["existing", "new-1", "new-2"]);
    expect(mocks.cart.clear).toHaveBeenCalled();
  });

  test("does NOT clear the cart if the project update throws", async () => {
    mocks.cart.get.mockResolvedValue(makeCart({ captureIds: ["a"] }));
    mocks.sizzle.get.mockResolvedValue(makeProject());
    mocks.sizzle.update.mockRejectedValue(new Error("write failed"));
    const h = await load("cart:commitToExisting");
    const r = await h({ projectId: "proj-1" });
    expect(r).toMatchObject({ ok: false, error: { code: "cart_commit_failed" } });
    expect(mocks.cart.clear).not.toHaveBeenCalled();
  });
});
