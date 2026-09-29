// The float-over's bus verbs take renderer-supplied ids and menu labels.
// A malformed request is refused at the boundary rather than handed to
// the window code.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown) => Promise<unknown>>(),
  dismissFloatOver: vi.fn(),
  floatOverCapabilities: vi.fn(() => ({ dock: true })),
  openFloatOverCapture: vi.fn(),
  popFloatOverOverflowMenu: vi.fn(async () => null),
  tuckFloatOver: vi.fn(() => ({ docked: true }))
}));

vi.mock("../../command-bus", () => ({
  bus: {
    register: vi.fn((name: string, handler: (req: unknown) => Promise<unknown>) => {
      mocks.handlers.set(name, handler);
    })
  }
}));

vi.mock("../../float-over", () => ({
  dismissFloatOver: mocks.dismissFloatOver,
  floatOverCapabilities: mocks.floatOverCapabilities,
  openFloatOverCapture: mocks.openFloatOverCapture,
  popFloatOverOverflowMenu: mocks.popFloatOverOverflowMenu,
  tuckFloatOver: mocks.tuckFloatOver
}));

import { registerFloatOverHandlers } from "../float-over-handlers";

function call(name: string, req: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(name);
  if (handler === undefined) throw new Error(`${name} is not registered`);
  return handler(req);
}

describe("float-over handlers", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
    registerFloatOverHandlers();
  });

  it("passes markOnly through only when it is exactly true", async () => {
    await call("float-over:tuck", {});
    await call("float-over:tuck", { markOnly: true });
    await call("float-over:tuck", { markOnly: "yes" });
    expect(mocks.tuckFloatOver.mock.calls).toEqual([
      [{ markOnly: false }],
      [{ markOnly: true }],
      [{ markOnly: false }]
    ]);
  });

  it("opens a snap by id and refuses anything that is not one", async () => {
    await expect(call("float-over:open", { captureId: "cap_1" })).resolves.toEqual({
      ok: true,
      value: undefined
    });
    expect(mocks.openFloatOverCapture).toHaveBeenCalledWith("cap_1");

    for (const req of [{}, { captureId: "" }, { captureId: 7 }, { captureId: "x".repeat(201) }, null]) {
      const result = (await call("float-over:open", req)) as { ok: boolean; error?: { kind: string } };
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("validation");
    }
    expect(mocks.openFloatOverCapture).toHaveBeenCalledTimes(1);
  });

  it("trims overflow labels and refuses a malformed or oversized list", async () => {
    await call("float-over:overflowMenu", {
      items: [{ captureId: "cap_1", label: "y".repeat(300) }],
      canClearFinished: true
    });
    expect(mocks.popFloatOverOverflowMenu).toHaveBeenCalledWith(
      [{ captureId: "cap_1", label: "y".repeat(120) }],
      true
    );

    const tooMany = Array.from({ length: 51 }, (_, i) => ({ captureId: `cap_${i}`, label: "Snap" }));
    for (const items of [tooMany, [{ captureId: "cap_1" }], [null], "cap_1"]) {
      const result = (await call("float-over:overflowMenu", { items, canClearFinished: false })) as {
        ok: boolean;
      };
      expect(result.ok).toBe(false);
    }
    expect(mocks.popFloatOverOverflowMenu).toHaveBeenCalledTimes(1);
  });

  it("only a literal true offers Clear finished", async () => {
    await call("float-over:overflowMenu", { items: [], canClearFinished: "true" });
    expect(mocks.popFloatOverOverflowMenu).toHaveBeenLastCalledWith([], false);
  });
});
