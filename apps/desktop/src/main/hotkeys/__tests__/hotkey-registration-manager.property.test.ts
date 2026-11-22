import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { defaultHotkeysForPlatform, type Settings } from "@pwrsnap/shared";
import { HotkeyRegistrationManager } from "../hotkey-registration-manager";

const shortcutKeys = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");

function harness(platform: "win32" | "linux") {
  const live = new Map<string, () => void>();
  const register = vi.fn((accelerator: string, callback: () => void) => {
    // Electron's externally handled path can replace a process-local callback.
    live.set(accelerator, callback);
    return true;
  });
  const manager = new HotkeyRegistrationManager({
    platform,
    registrar: {
      register,
      isRegistered: (accelerator: string) => live.has(accelerator),
      unregister: (accelerator: string) => { live.delete(accelerator); }
    },
    callbackFor: () => vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() }
  });
  return { live, manager, register };
}

function settings(region = "", window = ""): Settings["hotkeys"] {
  return { ...defaultHotkeysForPlatform("linux"), quickCapture: "", region, window };
}

test("AltGr and Ctrl+Alt cannot be assigned to different PwrSnap actions", () => {
  fc.assert(fc.property(
    shortcutKeys,
    fc.constantFrom("win32", "linux"),
    fc.boolean(),
    (key, platform, altGrFirst) => {
      const pair = [`AltGr+${key}`, `Control+Alt+${key}`] as const;
      const [first, second] = altGrFirst ? pair : [pair[1], pair[0]];
      const { manager, register, live } = harness(platform);
      const current = settings(first);
      const duplicated = settings(first, second);
      manager.initialize(current);

      expect(() => manager.prepare(current, duplicated)).toThrowError(
        expect.objectContaining({ code: "hotkey_duplicate" })
      );
      expect(register).toHaveBeenCalledTimes(1);

      const restarted = harness(platform);
      restarted.manager.initialize(duplicated);
      const status = restarted.manager.retry("window");
      expect(status.window.failure?.code).toBe("duplicate");
      expect(restarted.register).toHaveBeenCalledTimes(1);
      expect([...restarted.live.keys()]).toEqual([...live.keys()]);
    }
  ));
});

test("Settings cannot displace a process-local owner during boot, retry, or save", () => {
  fc.assert(fc.property(
    shortcutKeys,
    fc.constantFrom("boot and retry", "save", "recorder save"),
    (key, operation) => {
      const chord = `Control+${key}`;
      const { manager, register, live } = harness("linux");
      const existingCallback = vi.fn();
      live.set(chord, existingCallback);
      if (operation === "boot and retry") {
        manager.initialize(settings(chord));
        expect(manager.retry("region").region.failure?.code).toBe("duplicate");
      } else {
        manager.initialize(settings());
        if (operation === "recorder save") manager.suspendNative();
        expect(() => manager.prepare(settings(), settings(chord))).toThrowError(
          expect.objectContaining({ code: "hotkey_duplicate" })
        );
      }
      expect(register).not.toHaveBeenCalled();
      expect(live.get(chord)).toBe(existingCallback);
    }
  ));
});

function checkAliasTransfer(key: string, swap: boolean, rollback: boolean): void {
  // The native reservation uses a physical key. Its unregister API needs
  // the spelling used when the callback was acquired.
  const identity = (chord: string): string => chord.replace(/^AltGr\+/, "Control+Alt+");
  const live = new Map<string, { chord: string; callback: () => void }>();
  const register = vi.fn((chord: string, callback: () => void) => {
    const key = identity(chord);
    if (live.has(key)) return false;
    live.set(key, { chord, callback });
    return true;
  });
  const unregister = vi.fn((chord: string) => {
    const key = identity(chord);
    expect(live.get(key)?.chord).toBe(chord);
    live.delete(key);
  });
  const callbacks = { region: vi.fn(), window: vi.fn() };
  const manager = new HotkeyRegistrationManager({
    platform: "win32",
    registrar: { register, unregister, isRegistered: (chord) => live.has(identity(chord)) },
    callbackFor: (kind) => kind === "region" || kind === "window" ? callbacks[kind] : vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() }
  });
  const original = `AltGr+${key}`;
  const alias = `Control+Alt+${key}`;
  const other = "Control+Alt+F9";
  const current = settings(original, swap ? other : "");
  const next = settings(swap ? other : "", alias);
  manager.initialize(current);
  const before = new Map(live);

  const transfer = manager.prepare(current, next);
  expect(unregister).toHaveBeenCalledWith(original);
  expect(live.get(alias)).toEqual({ chord: alias, callback: callbacks.window });

  if (rollback) {
    transfer.rollback();
    expect(unregister).toHaveBeenCalledWith(alias);
    expect(live).toEqual(before);
    expect(manager.snapshot().get("region")).toBe(original);
    expect(manager.statusSnapshot().region.accelerator).toBe(original);
  } else {
    transfer.commit();
    expect(manager.snapshot().get("window")).toBe(alias);
    expect(manager.statusSnapshot().window.accelerator).toBe(alias);
    expect(live.get(alias)).toEqual({ chord: alias, callback: callbacks.window });
    expect(live.get(other)).toEqual(swap ? { chord: other, callback: callbacks.region } : undefined);
  }
}

test("atomic transfers and swaps release and restore the original native spelling", () => {
  fc.assert(fc.property(shortcutKeys, fc.boolean(), fc.boolean(), checkAliasTransfer));
});

test("transfers AltGr+K from Region to Window as Ctrl+Alt+K", () => {
  checkAliasTransfer("K", false, false);
});
