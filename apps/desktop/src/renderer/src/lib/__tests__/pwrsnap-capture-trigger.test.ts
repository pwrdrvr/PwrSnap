import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isCaptureInvocation } from "@pwrsnap/shared";
import { dispatchInteractiveCapture } from "../pwrsnap";

const dispatch = vi.fn();

beforeEach(() => {
  dispatch.mockReset();
  dispatch.mockResolvedValue({ ok: false, error: { code: "cancelled" } });
  window.pwrsnapApi = {
    dispatch
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderer interactive capture trigger", () => {
  test("constructs the required invocation synchronously in the UI callback", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001"
    );
    vi.spyOn(performance, "now").mockReturnValueOnce(20).mockReturnValueOnce(21);

    await dispatchInteractiveCapture("library.quick_capture", "auto");

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [command, request] = dispatch.mock.calls[0] as [
      string,
      { mode: string; invocation: unknown }
    ];
    expect(command).toBe("capture:interactive");
    expect(request.mode).toBe("auto");
    expect(isCaptureInvocation(request.invocation)).toBe(true);
    expect(request.invocation).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      origin: "library.quick_capture",
      dispatchMonotonicMs: performance.timeOrigin + 21
    });
  });
});
