import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  location: "documents" as "documents" | "home",
  overridden: false,
  homeReferences: 0,
  setLocation: vi.fn()
}));

vi.mock("../../persistence/captures-repo", () => ({
  countCapturePathReferencesUnder: vi.fn(() => mocks.homeReferences)
}));

vi.mock("../../persistence/paths", () => ({
  getCapturesLocation: () => mocks.location,
  getHomeCapturesRoot: () => "/Users/test/PwrSnap",
  isOverriddenDataRoot: () => mocks.overridden,
  setCapturesLocation: (location: "documents" | "home") => {
    mocks.location = location;
    mocks.setLocation(location);
  }
}));

beforeEach(() => {
  vi.resetModules();
  mocks.location = "documents";
  mocks.overridden = false;
  mocks.homeReferences = 0;
  mocks.setLocation.mockReset();
});

describe("reconcileCapturesLocationOnBoot", () => {
  test("recovers the sticky home root from durable database paths", async () => {
    mocks.homeReferences = 3;
    const write = vi.fn(async () => undefined);
    const { reconcileCapturesLocationOnBoot } = await import(
      "../capture-location-reconciliation"
    );

    const result = await reconcileCapturesLocationOnBoot({ write } as never);

    expect(result).toEqual({ changed: true, homeCaptureReferences: 3, persisted: true });
    expect(mocks.location).toBe("home");
    expect(write).toHaveBeenCalledWith({ storage: { capturesLocation: "home" } });
  });

  test("keeps this boot on home even when repairing settings fails", async () => {
    mocks.homeReferences = 1;
    const failure = new Error("settings unreadable");
    const write = vi.fn(async () => Promise.reject(failure));
    const { reconcileCapturesLocationOnBoot } = await import(
      "../capture-location-reconciliation"
    );

    const result = await reconcileCapturesLocationOnBoot({ write } as never);

    expect(result).toEqual({
      changed: true,
      homeCaptureReferences: 1,
      persisted: false,
      error: failure
    });
    expect(mocks.location).toBe("home");
  });

  test("leaves an intentional Documents selection alone without home references", async () => {
    const write = vi.fn(async () => undefined);
    const { reconcileCapturesLocationOnBoot } = await import(
      "../capture-location-reconciliation"
    );

    const result = await reconcileCapturesLocationOnBoot({ write } as never);

    expect(result).toEqual({ changed: false, homeCaptureReferences: 0 });
    expect(write).not.toHaveBeenCalled();
    expect(mocks.setLocation).not.toHaveBeenCalled();
  });
});
