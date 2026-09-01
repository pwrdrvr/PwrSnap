import { beforeEach, describe, expect, test, vi } from "vitest";
import { isCaptureInvocation } from "@pwrsnap/shared";

const commandBus = vi.hoisted(() => ({
  dispatch: vi.fn()
}));

vi.mock("../../command-bus", () => ({
  bus: { dispatch: commandBus.dispatch }
}));

describe("main interactive capture trigger", () => {
  beforeEach(() => {
    commandBus.dispatch.mockReset();
    commandBus.dispatch.mockResolvedValue({ ok: false, error: { code: "cancelled" } });
  });

  test("constructs the required invocation before dispatch", async () => {
    const { dispatchInteractiveCapture } = await import("../capture-trigger");
    await dispatchInteractiveCapture("native_tray_menu.quick_capture", "auto");

    expect(commandBus.dispatch).toHaveBeenCalledTimes(1);
    const [command, request, options] = commandBus.dispatch.mock.calls[0] as [
      string,
      { mode: string; invocation: unknown },
      unknown
    ];
    expect(command).toBe("capture:interactive");
    expect(request.mode).toBe("auto");
    expect(isCaptureInvocation(request.invocation)).toBe(true);
    expect(request.invocation).toMatchObject({
      origin: "native_tray_menu.quick_capture"
    });
    expect(options).toEqual({ principal: "ipc" });
  });
});
