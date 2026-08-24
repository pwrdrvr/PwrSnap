import { describe, expect, test, vi } from "vitest";
import { DEFAULT_HOTKEYS, type Settings } from "@pwrsnap/shared";
import {
  HotkeyRegistrationError,
  HotkeyRegistrationManager,
  HOTKEY_KINDS,
  type GlobalShortcutRegistrar,
  type HotkeyKind
} from "../hotkey-registration-manager";

function blankHotkeys(
  patch: Partial<Settings["hotkeys"]> = {}
): Settings["hotkeys"] {
  const blank = Object.fromEntries(
    Object.keys(DEFAULT_HOTKEYS).map((key) => [key, ""])
  ) as Settings["hotkeys"];
  return { ...blank, ...patch };
}

function makeRegistrar() {
  const live = new Map<string, () => void>();
  const unavailable = new Set<string>();
  const throws = new Set<string>();
  const registrar: GlobalShortcutRegistrar = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (throws.has(accelerator)) throw new Error("native registration exploded");
      if (unavailable.has(accelerator) || live.has(accelerator)) return false;
      live.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      live.delete(accelerator);
    })
  };
  return { registrar, live, unavailable, throws };
}

function makeManager(registrar: GlobalShortcutRegistrar): HotkeyRegistrationManager {
  return new HotkeyRegistrationManager({
    platform: "win32",
    registrar,
    callbackFor: (_kind: HotkeyKind) => vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() }
  });
}

describe("HotkeyRegistrationManager", () => {
  test("retains exhaustive actionable status for every boot failure without clearing settings", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const persisted = blankHotkeys({
      quickCapture: "Command+Shift+C",
      region: "Control+Alt+R",
      window: "CommandOrControl+Alt+R",
      fullScreen: "Control+Shift+F",
      allScreens: "Control+Shift+A",
      videoCapture: "Control+Alt+V"
    });
    fake.unavailable.add("Control+Shift+F");
    fake.throws.add("Control+Shift+A");

    manager.initialize(persisted);
    const status = manager.statusSnapshot();

    expect([...HOTKEY_KINDS].sort()).toEqual(Object.keys(DEFAULT_HOTKEYS).sort());
    expect(Object.keys(status).sort()).toEqual(Object.keys(DEFAULT_HOTKEYS).sort());
    expect(status.quickCapture).toMatchObject({
      accelerator: "Command+Shift+C",
      state: "inactive",
      failure: { code: "unsupported" }
    });
    expect(status.window).toMatchObject({
      accelerator: "CommandOrControl+Alt+R",
      state: "inactive",
      failure: { code: "duplicate" }
    });
    expect(status.fullScreen).toMatchObject({
      accelerator: "Control+Shift+F",
      state: "inactive",
      failure: { code: "unavailable" }
    });
    expect(status.allScreens).toMatchObject({
      accelerator: "Control+Shift+A",
      state: "inactive",
      failure: { code: "registration_error" }
    });
    expect(status.videoCapture).toMatchObject({
      accelerator: "Control+Alt+V",
      state: "active",
      failure: null
    });
    expect(status.timed).toMatchObject({
      accelerator: "",
      state: "unbound",
      failure: null
    });
  });

  test("retry activates only the failed boot binding after its owner is freed", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const persisted = blankHotkeys({
      quickCapture: "Control+Shift+C",
      region: "Control+Alt+R"
    });
    fake.unavailable.add("Control+Shift+C");
    manager.initialize(persisted);
    const unrelatedCallback = fake.live.get("Control+Alt+R");

    expect(manager.statusSnapshot().quickCapture).toMatchObject({
      accelerator: "Control+Shift+C",
      state: "inactive",
      failure: { code: "unavailable" }
    });

    fake.unavailable.delete("Control+Shift+C");
    const status = manager.retry("quickCapture");

    expect(status.quickCapture).toMatchObject({
      accelerator: "Control+Shift+C",
      state: "active",
      failure: null
    });
    expect(status.region).toMatchObject({
      accelerator: "Control+Alt+R",
      state: "active",
      failure: null
    });
    expect(fake.live.get("Control+Alt+R")).toBe(unrelatedCallback);
    expect([...fake.live.keys()].sort()).toEqual([
      "Control+Alt+R",
      "Control+Shift+C"
    ]);
    expect(fake.registrar.unregister).not.toHaveBeenCalled();
  });

  test("an edit that races boot initializes the prior bindings before staging", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Ctrl+Shift+C" });

    const transaction = manager.prepare(
      current,
      blankHotkeys({ quickCapture: "Ctrl+Alt+C" })
    );

    expect([...fake.live.keys()].sort()).toEqual([
      "Control+Alt+C",
      "Control+Shift+C"
    ]);
    transaction.commit();
    expect([...fake.live.keys()]).toEqual(["Control+Alt+C"]);
  });

  test("stages a replacement before commit, then releases the prior binding", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Ctrl+Shift+C" });
    manager.initialize(current);

    const transaction = manager.prepare(
      current,
      blankHotkeys({ quickCapture: "Ctrl+Alt+C" })
    );

    expect([...fake.live.keys()].sort()).toEqual([
      "Control+Alt+C",
      "Control+Shift+C"
    ]);
    transaction.commit();
    expect([...fake.live.keys()]).toEqual(["Control+Alt+C"]);
    expect(manager.snapshot().get("quickCapture")).toBe("Control+Alt+C");
  });

  test("false from Electron preserves the prior live binding", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Ctrl+Shift+C" });
    manager.initialize(current);
    fake.unavailable.add("Control+Alt+C");

    let failure: unknown;
    try {
      manager.prepare(current, blankHotkeys({ quickCapture: "Ctrl+Alt+C" }));
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toEqual(
      expect.objectContaining<Partial<HotkeyRegistrationError>>({
        code: "hotkey_unavailable"
      })
    );
    expect((failure as Error).message).toContain("Windows or another app");
    expect((failure as Error).message).not.toContain("win32");
    expect([...fake.live.keys()]).toEqual(["Control+Shift+C"]);
    expect(manager.snapshot().get("quickCapture")).toBe("Control+Shift+C");
  });

  test("a thrown native registration preserves the prior live binding", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Ctrl+Shift+C" });
    manager.initialize(current);
    fake.throws.add("Control+Alt+C");

    expect(() =>
      manager.prepare(current, blankHotkeys({ quickCapture: "Ctrl+Alt+C" }))
    ).toThrowError(
      expect.objectContaining<Partial<HotkeyRegistrationError>>({
        code: "hotkey_unavailable"
      })
    );
    expect([...fake.live.keys()]).toEqual(["Control+Shift+C"]);
  });

  test("rollback releases the staged binding and restores the prior snapshot", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Ctrl+Shift+C" });
    manager.initialize(current);

    const transaction = manager.prepare(
      current,
      blankHotkeys({ quickCapture: "Ctrl+Alt+C" })
    );
    transaction.rollback();

    expect([...fake.live.keys()]).toEqual(["Control+Shift+C"]);
    expect(manager.snapshot().get("quickCapture")).toBe("Control+Shift+C");
  });

  test("explicit clear keeps the binding until commit, then unregisters it", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Ctrl+Shift+C" });
    manager.initialize(current);

    const transaction = manager.prepare(current, blankHotkeys());
    expect(fake.live.has("Control+Shift+C")).toBe(true);
    transaction.commit();

    expect(fake.live.size).toBe(0);
    expect(manager.snapshot().has("quickCapture")).toBe(false);
    expect(manager.statusSnapshot().quickCapture).toEqual({
      key: "quickCapture",
      accelerator: "",
      state: "unbound",
      failure: null
    });
  });

  test("rejects aliases that normalize to a duplicate before touching live state", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Ctrl+Shift+C" });
    manager.initialize(current);
    const callsBefore = vi.mocked(fake.registrar.register).mock.calls.length;

    expect(() =>
      manager.prepare(
        current,
        blankHotkeys({
          quickCapture: "CommandOrControl+Alt+C",
          region: "Control+Alt+C"
        })
      )
    ).toThrowError(
      expect.objectContaining<Partial<HotkeyRegistrationError>>({
        code: "hotkey_duplicate"
      })
    );
    expect(vi.mocked(fake.registrar.register)).toHaveBeenCalledTimes(callsBefore);
    expect([...fake.live.keys()]).toEqual(["Control+Shift+C"]);
  });

  test("rejects a Command-only Windows accelerator before registration", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Ctrl+Shift+C" });
    manager.initialize(current);

    expect(() =>
      manager.prepare(
        current,
        blankHotkeys({ quickCapture: "Command+Shift+C" })
      )
    ).toThrowError(
      expect.objectContaining<Partial<HotkeyRegistrationError>>({
        code: "hotkey_unsupported"
      })
    );
    expect([...fake.live.keys()]).toEqual(["Control+Shift+C"]);
  });

  test("atomically swaps callbacks for two PwrSnap-owned accelerators", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({
      quickCapture: "Ctrl+Shift+C",
      region: "Ctrl+Alt+C"
    });
    manager.initialize(current);

    const transaction = manager.prepare(
      current,
      blankHotkeys({
        quickCapture: "Ctrl+Alt+C",
        region: "Ctrl+Shift+C"
      })
    );
    transaction.commit();

    expect([...fake.live.keys()].sort()).toEqual([
      "Control+Alt+C",
      "Control+Shift+C"
    ]);
    expect(manager.snapshot()).toEqual(
      new Map([
        ["quickCapture", "Control+Alt+C"],
        ["region", "Control+Shift+C"]
      ])
    );
  });

  test("rollback marks a prior binding inactive when Electron cannot restore it", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({
      quickCapture: "Ctrl+Shift+C",
      region: "Ctrl+Alt+C"
    });
    manager.initialize(current);

    const transaction = manager.prepare(
      current,
      blankHotkeys({
        quickCapture: "Ctrl+Alt+C",
        region: "Ctrl+Shift+C"
      })
    );
    fake.unavailable.add("Control+Shift+C");
    transaction.rollback();

    expect([...fake.live.keys()]).toEqual(["Control+Alt+C"]);
    expect(manager.snapshot()).toEqual(
      new Map([["region", "Control+Alt+C"]])
    );
    expect(manager.statusSnapshot().quickCapture).toMatchObject({
      accelerator: "Ctrl+Shift+C",
      state: "inactive",
      failure: { code: "unavailable" }
    });
    expect(manager.statusSnapshot().region).toMatchObject({
      state: "active",
      failure: null
    });
  });

  test("rollback records a thrown prior restoration without inventing ownership", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({
      quickCapture: "Ctrl+Shift+C",
      region: "Ctrl+Alt+C"
    });
    manager.initialize(current);

    const transaction = manager.prepare(
      current,
      blankHotkeys({
        quickCapture: "Ctrl+Alt+C",
        region: "Ctrl+Shift+C"
      })
    );
    fake.throws.add("Control+Shift+C");
    transaction.rollback();

    expect([...fake.live.keys()]).toEqual(["Control+Alt+C"]);
    expect(manager.snapshot()).toEqual(
      new Map([["region", "Control+Alt+C"]])
    );
    expect(manager.statusSnapshot().quickCapture).toMatchObject({
      accelerator: "Ctrl+Shift+C",
      state: "inactive",
      failure: { code: "registration_error" }
    });
  });

  test("an unrelated edit does not retry or adopt a persisted binding that failed at boot", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({
      quickCapture: "Ctrl+Shift+C",
      region: "Ctrl+Alt+R"
    });
    fake.unavailable.add("Control+Shift+C");
    manager.initialize(current);
    expect([...fake.live.keys()]).toEqual(["Control+Alt+R"]);
    expect(vi.mocked(fake.registrar.register)).toHaveBeenCalledTimes(2);

    const transaction = manager.prepare(
      current,
      blankHotkeys({
        quickCapture: "Ctrl+Shift+C",
        region: "Ctrl+Alt+X"
      })
    );
    expect(vi.mocked(fake.registrar.register)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fake.registrar.register)).not.toHaveBeenLastCalledWith(
      "Control+Shift+C",
      expect.any(Function)
    );

    transaction.commit();
    expect([...fake.live.keys()]).toEqual(["Control+Alt+X"]);
    expect(manager.snapshot()).toEqual(
      new Map([["region", "Control+Alt+X"]])
    );
    expect(manager.statusSnapshot().quickCapture).toMatchObject({
      accelerator: "Ctrl+Shift+C",
      state: "inactive",
      failure: { code: "unavailable" }
    });
  });

  test("native suspension restores only prior ownership, never an untouched boot failure", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({
      quickCapture: "Control+Shift+C",
      region: "Control+Alt+R"
    });
    fake.unavailable.add("Control+Shift+C");
    manager.initialize(current);
    expect(vi.mocked(fake.registrar.register)).toHaveBeenCalledTimes(2);
    expect([...fake.live.keys()]).toEqual(["Control+Alt+R"]);

    fake.unavailable.delete("Control+Shift+C");
    manager.suspendNative();
    expect(fake.live.size).toBe(0);
    manager.restoreNative();

    expect([...fake.live.keys()]).toEqual(["Control+Alt+R"]);
    expect(vi.mocked(fake.registrar.register)).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(fake.registrar.register).mock.calls.filter(
        ([accelerator]) => accelerator === "Control+Shift+C"
      )
    ).toHaveLength(1);
    expect(manager.statusSnapshot().quickCapture).toMatchObject({
      state: "inactive",
      failure: { code: "unavailable" }
    });
  });

  test("a committed write during suspension changes desired ownership without arming early", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Control+Shift+C" });
    const next = blankHotkeys({ quickCapture: "Super+Shift+C" });
    manager.initialize(current);
    manager.suspendNative();

    const transaction = manager.prepare(current, next);
    expect([...fake.live.keys()]).toEqual(["Super+Shift+C"]);
    transaction.commit();
    expect(fake.live.size).toBe(0);
    expect(manager.statusSnapshot().quickCapture).toMatchObject({
      accelerator: "Super+Shift+C",
      state: "suspended",
      failure: null
    });

    manager.restoreNative();
    expect([...fake.live.keys()]).toEqual(["Super+Shift+C"]);
    expect(manager.statusSnapshot().quickCapture.state).toBe("active");
  });

  test("a rolled-back write during suspension restores the exact prior chord", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Control+Shift+C" });
    manager.initialize(current);
    manager.suspendNative();

    const transaction = manager.prepare(
      current,
      blankHotkeys({ quickCapture: "Super+Shift+C" })
    );
    transaction.rollback();
    expect(fake.live.size).toBe(0);
    manager.restoreNative();

    expect([...fake.live.keys()]).toEqual(["Control+Shift+C"]);
    expect(manager.statusSnapshot().quickCapture).toMatchObject({
      accelerator: "Control+Shift+C",
      state: "active",
      failure: null
    });
  });

  test("restore failure is typed, preserves unrelated ownership, and uses Windows labels", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({
      quickCapture: "Super+Shift+C",
      region: "Control+Alt+R"
    });
    manager.initialize(current);
    manager.suspendNative();
    fake.unavailable.add("Super+Shift+C");

    const status = manager.restoreNative();

    expect(status.quickCapture).toMatchObject({
      state: "inactive",
      failure: { code: "unavailable" }
    });
    expect(status.quickCapture.failure?.message).toContain("Win+Shift+C");
    expect(status.quickCapture.failure?.message).not.toMatch(
      /Cmd|Command|⌘|Super/
    );
    expect(status.region.state).toBe("active");
    expect([...fake.live.keys()]).toEqual(["Control+Alt+R"]);
  });

  test("all Windows bus-facing validation and registration messages hide raw modifier tokens", () => {
    const fake = makeRegistrar();
    const manager = makeManager(fake.registrar);
    const current = blankHotkeys({ quickCapture: "Control+Shift+C" });
    manager.initialize(current);

    let error: unknown;
    try {
      manager.prepare(
        current,
        blankHotkeys({ quickCapture: "Command+Super+C" })
      );
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(HotkeyRegistrationError);
    expect((error as Error).message).not.toMatch(/Cmd|Command|⌘|Super/);
  });
});
