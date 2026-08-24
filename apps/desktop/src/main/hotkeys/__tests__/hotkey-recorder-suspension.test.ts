import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_HOTKEYS, type Settings } from "@pwrsnap/shared";
import { defaultSettings } from "../../settings/desktop-settings-service";
import {
  HotkeyRecorderSuspension,
  type HotkeyRecorderOwnershipCoordinator
} from "../hotkey-recorder-suspension";
import {
  HotkeyRegistrationManager,
  type GlobalShortcutRegistrar
} from "../hotkey-registration-manager";

const DOCUMENT_A = "documentepoch0001";
const DOCUMENT_B = "documentepoch0002";

function hotkeys(
  patch: Partial<Settings["hotkeys"]> = {}
): Settings["hotkeys"] {
  const blank = Object.fromEntries(
    Object.keys(DEFAULT_HOTKEYS).map((key) => [key, ""])
  ) as Settings["hotkeys"];
  return { ...blank, ...patch };
}

function makeNativeHarness(options: { timeoutMs?: number } = {}) {
  const live = new Map<string, () => void>();
  const ignoredMenuShortcutWindows = new Set<number>();
  const unavailable = new Set<string>();
  const registrar: GlobalShortcutRegistrar = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (unavailable.has(accelerator) || live.has(accelerator)) return false;
      live.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      live.delete(accelerator);
    })
  };
  const actions = new Map<string, ReturnType<typeof vi.fn>>();
  const manager = new HotkeyRegistrationManager({
    platform: "win32",
    registrar,
    callbackFor: (kind) => {
      const action = vi.fn();
      actions.set(kind, action);
      return action;
    },
    logger: { warn: vi.fn(), error: vi.fn() }
  });
  const settings = defaultSettings();
  settings.hotkeys = hotkeys({
    quickCapture: "Control+Shift+C",
    region: "Control+Alt+R"
  });
  const coordinator: HotkeyRecorderOwnershipCoordinator = {
    registrationManager: manager,
    withSerializedSettings: async (operation) => operation(settings)
  };
  const suspension = new HotkeyRecorderSuspension({
    timeoutMs: options.timeoutMs ?? 1_000,
    coordinator,
    inputScope: {
      suspend: vi.fn((ownerWindowId: number) => {
        ignoredMenuShortcutWindows.add(ownerWindowId);
      }),
      restore: vi.fn((ownerWindowId: number) => {
        ignoredMenuShortcutWindows.delete(ownerWindowId);
      })
    },
    logger: { info: vi.fn(), warn: vi.fn() }
  });
  manager.initialize(settings.hotkeys);
  return {
    actions,
    coordinator,
    ignoredMenuShortcutWindows,
    live,
    manager,
    registrar,
    settings,
    suspension,
    unavailable
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HotkeyRecorderSuspension", () => {
  test("releases manager-owned native chords before accepting DOM recording and restores them on end", async () => {
    const h = makeNativeHarness();
    expect([...h.live.keys()].sort()).toEqual([
      "Control+Alt+R",
      "Control+Shift+C"
    ]);

    const begun = await h.suspension.begin("settings_recorder", 1, 41, DOCUMENT_A);

    expect(begun.accepted).toBe(true);
    expect(h.live.size).toBe(0);
    expect(h.ignoredMenuShortcutWindows).toEqual(new Set([41]));
    expect(h.manager.statusSnapshot().quickCapture).toMatchObject({
      accelerator: "Control+Shift+C",
      state: "suspended",
      failure: null
    });

    expect(await h.suspension.end("settings_recorder", 1, 41, DOCUMENT_A)).toBe(true);
    expect([...h.live.keys()].sort()).toEqual([
      "Control+Alt+R",
      "Control+Shift+C"
    ]);
    expect(h.ignoredMenuShortcutWindows.size).toBe(0);
    h.live.get("Control+Shift+C")?.();
    expect(h.actions.get("quickCapture")).toHaveBeenCalledOnce();
  });

  test("a newer row supersedes the lease and stale session/generation ends are harmless", async () => {
    const h = makeNativeHarness();
    await h.suspension.begin("row_a_session", 1, 41, DOCUMENT_A);
    await h.suspension.begin("row_b_session", 2, 41, DOCUMENT_A);

    expect(await h.suspension.end("row_a_session", 1, 41, DOCUMENT_A)).toBe(false);
    expect(await h.suspension.end("row_b_session", 1, 41, DOCUMENT_A)).toBe(false);
    expect(h.live.size).toBe(0);
    expect(h.suspension.snapshot()).toMatchObject({
      sessionId: "row_b_session",
      generation: 2,
      ownerWindowId: 41
    });
    expect(h.ignoredMenuShortcutWindows).toEqual(new Set([41]));

    expect(await h.suspension.end("row_b_session", 2, 41, DOCUMENT_A)).toBe(true);
    expect(h.live.size).toBe(2);
    expect(h.ignoredMenuShortcutWindows.size).toBe(0);
  });

  test("moves menu-accelerator bypass to a superseding recorder window", async () => {
    const h = makeNativeHarness();
    await h.suspension.begin("older_window", 1, 41, DOCUMENT_A);
    await h.suspension.begin("newer_window", 1, 77, DOCUMENT_B);

    expect(h.live.size).toBe(0);
    expect(h.ignoredMenuShortcutWindows).toEqual(new Set([77]));

    expect(await h.suspension.releaseOwner(77, DOCUMENT_B, "renderer-gone")).toBe(true);
    expect(h.ignoredMenuShortcutWindows.size).toBe(0);
    expect(h.live.size).toBe(2);
  });

  test("abnormal owner cleanup restores ownership and cannot clear another window", async () => {
    const h = makeNativeHarness();
    await h.suspension.begin("older_window", 1, 41, DOCUMENT_A);
    await h.suspension.begin("newer_window", 1, 77, DOCUMENT_B);

    expect(await h.suspension.releaseOwner(41, DOCUMENT_A, "window-closed")).toBe(false);
    expect(h.live.size).toBe(0);
    expect(h.ignoredMenuShortcutWindows).toEqual(new Set([77]));
    expect(await h.suspension.releaseOwner(77, DOCUMENT_B, "renderer-gone")).toBe(true);
    expect(h.live.size).toBe(2);
    expect(h.ignoredMenuShortcutWindows.size).toBe(0);
  });

  test("bounded timeout restores native ownership after renderer loss", async () => {
    vi.useFakeTimers();
    const h = makeNativeHarness({ timeoutMs: 250 });
    await h.suspension.begin("abandoned_session", 1, 41, DOCUMENT_A);

    await vi.advanceTimersByTimeAsync(249);
    expect(h.live.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.live.size).toBe(2);
    expect(h.ignoredMenuShortcutWindows.size).toBe(0);
    expect(h.suspension.isSuspended()).toBe(false);
  });

  test("same-session heartbeat refreshes without re-registering", async () => {
    vi.useFakeTimers();
    const h = makeNativeHarness({ timeoutMs: 250 });
    const original = await h.suspension.begin("long_session", 3, 41, DOCUMENT_A);
    const registerCalls = vi.mocked(h.registrar.register).mock.calls.length;

    await vi.advanceTimersByTimeAsync(200);
    const refreshed = await h.suspension.begin("long_session", 3, 41, DOCUMENT_A);
    expect(refreshed.accepted).toBe(true);
    expect(refreshed.expiresAt).toBeGreaterThan(original.expiresAt);
    expect(vi.mocked(h.registrar.register)).toHaveBeenCalledTimes(registerCalls);

    await vi.advanceTimersByTimeAsync(249);
    expect(h.live.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.live.size).toBe(2);
  });

  test("superseded begins wait for the same serialized native acquisition", async () => {
    const h = makeNativeHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let queue: Promise<unknown> = gate;
    h.coordinator.withSerializedSettings = <T>(
      operation: (current: Settings) => T | Promise<T>
    ): Promise<T> => {
      const next = queue.then(() => operation(h.settings));
      queue = next.catch(() => undefined);
      return next;
    };

    const older = h.suspension.begin("row_a_session", 1, 41, DOCUMENT_A);
    const newer = h.suspension.begin("row_b_session", 2, 41, DOCUMENT_A);
    let newerSettled = false;
    void newer.then(() => {
      newerSettled = true;
    });
    await Promise.resolve();
    expect(newerSettled).toBe(false);
    expect(h.live.size).toBe(2);

    release();
    await expect(older).resolves.toMatchObject({ accepted: false });
    await expect(newer).resolves.toMatchObject({
      accepted: true,
      sessionId: "row_b_session",
      generation: 2
    });
    expect(h.live.size).toBe(0);
  });

  test("owner cleanup fences a begin already waiting for the settings lock", async () => {
    const h = makeNativeHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let queue: Promise<unknown> = gate;
    h.coordinator.withSerializedSettings = <T>(
      operation: (current: Settings) => T | Promise<T>
    ): Promise<T> => {
      const next = queue.then(() => operation(h.settings));
      queue = next.catch(() => undefined);
      return next;
    };

    const delayedBegin = h.suspension.begin(
      "delayed_begin",
      1,
      41,
      DOCUMENT_A
    );
    const cleanup = h.suspension.releaseOwner(
      41,
      DOCUMENT_A,
      "navigation"
    );
    release();

    await expect(delayedBegin).resolves.toMatchObject({ accepted: false });
    await expect(cleanup).resolves.toBe(false);
    expect(h.live.size).toBe(2);
    expect(h.suspension.isSuspended()).toBe(false);
  });

  test("transient participants suspend and restore with manager ownership", async () => {
    const h = makeNativeHarness();
    const participant = { id: "float-over", suspend: vi.fn(), restore: vi.fn() };
    h.suspension.registerParticipant(participant);

    await h.suspension.begin("participant_session", 1, 41, DOCUMENT_A);
    expect(participant.suspend).toHaveBeenCalledOnce();
    expect(h.live.size).toBe(0);

    expect(await h.suspension.end("participant_session", 1, 41, DOCUMENT_A)).toBe(true);
    expect(participant.restore).toHaveBeenCalledOnce();
    expect(h.live.size).toBe(2);
  });

  test("participant suspension failure rolls manager ownership back", async () => {
    const h = makeNativeHarness();
    h.suspension.registerParticipant({
      id: "broken-owner",
      suspend: () => {
        throw new Error("cannot disarm transient shortcut");
      },
      restore: vi.fn()
    });

    await expect(
      h.suspension.begin("broken_session", 1, 41, DOCUMENT_A)
    ).rejects.toThrow("cannot disarm transient shortcut");
    expect(h.suspension.isSuspended()).toBe(false);
    expect(h.live.size).toBe(2);
    expect(h.manager.statusSnapshot().quickCapture.state).toBe("active");
  });

  test("menu-bypass acquisition failure restores every prior native binding", async () => {
    const h = makeNativeHarness();
    h.suspension.configureInputScope({
      suspend: () => {
        throw new Error("Settings window disappeared");
      },
      restore: vi.fn()
    });

    await expect(
      h.suspension.begin("missing_settings", 1, 41, DOCUMENT_A)
    ).rejects.toThrow("Settings window disappeared");

    expect(h.suspension.isSuspended()).toBe(false);
    expect([...h.live.keys()].sort()).toEqual([
      "Control+Alt+R",
      "Control+Shift+C"
    ]);
    expect(h.manager.statusSnapshot().quickCapture.state).toBe("active");
  });
});
