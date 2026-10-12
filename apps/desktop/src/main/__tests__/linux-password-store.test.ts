import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyRememberedLinuxPasswordStore,
  linuxPasswordStorePath,
  parseDbusNameList,
  probeSecretServices,
  relaunchForLinuxSecretStore,
  type CommandExec,
  type RelaunchForLinuxSecretStoreInput,
  type SecretServiceProbe
} from "../linux-password-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-linux-password-store-"));
  roots.push(root);
  return root;
}

function remember(userDataDir: string, store: string): void {
  writeFileSync(linuxPasswordStorePath(userDataDir), `${store}\n`);
}

const secretsProbe: SecretServiceProbe = {
  status: "ok",
  owned: ["org.freedesktop.secrets"],
  activatable: ["org.kde.kwalletd6"]
};

describe("parseDbusNameList", () => {
  test("reads busctl, dbus-send, and gdbus replies", () => {
    expect(parseDbusNameList('as 2 "org.freedesktop.DBus" "org.freedesktop.secrets"')).toEqual([
      "org.freedesktop.DBus",
      "org.freedesktop.secrets"
    ]);
    expect(
      parseDbusNameList(`
        array [
           string "org.kde.kwalletd6"
        ]
      `)
    ).toEqual(["org.kde.kwalletd6"]);
    expect(parseDbusNameList("(['org.freedesktop.secrets', 'org.kde.kwalletd5'],)")).toEqual([
      "org.freedesktop.secrets",
      "org.kde.kwalletd5"
    ]);
  });

  test("ignores unique connection names and other non-service tokens", () => {
    expect(parseDbusNameList('as 3 ":1.42" "org.freedesktop.secrets" "s"')).toEqual(["org.freedesktop.secrets"]);
  });
});

describe("probeSecretServices", () => {
  test("uses the first installed client and keeps owned names apart from activatable ones", () => {
    const exec = vi.fn<CommandExec>((command, args) => {
      if (command !== "dbus-send") return { missing: true };
      const activatable = args.includes("org.freedesktop.DBus.ListActivatableNames");
      return { status: 0, stdout: activatable ? 'string "org.freedesktop.secrets"' : 'string "org.kde.kwalletd6"' };
    });

    expect(probeSecretServices(exec)).toEqual({
      status: "ok",
      owned: ["org.kde.kwalletd6"],
      activatable: ["org.freedesktop.secrets"]
    });
    expect(exec.mock.calls.some(([command]) => command === "gdbus")).toBe(false);
  });

  test("reports a failed bus call, rather than trying the next client", () => {
    const exec = vi.fn<CommandExec>((command) =>
      command === "busctl" ? { status: 1, stdout: "", stderr: "Failed to connect to bus" } : { missing: true }
    );

    expect(probeSecretServices(exec)).toEqual({ status: "unavailable", reason: "busctl ListNames exited 1" });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test("reports when no dbus client is installed", () => {
    expect(probeSecretServices(() => ({ missing: true }))).toEqual({
      status: "unavailable",
      reason: "no dbus client (busctl, dbus-send, gdbus)"
    });
  });

  test("a failed activatable list still returns the owned names", () => {
    const exec: CommandExec = (_command, args) =>
      args.includes("ListActivatableNames")
        ? { status: 1, stdout: "", stderr: "denied" }
        : { status: 0, stdout: 'as 1 "org.freedesktop.secrets"' };

    expect(probeSecretServices(exec)).toEqual({ status: "ok", owned: ["org.freedesktop.secrets"], activatable: [] });
  });
});

describe("applyRememberedLinuxPasswordStore", () => {
  function applyWith(overrides: Partial<Parameters<typeof applyRememberedLinuxPasswordStore>[0]>) {
    const appendSwitch = vi.fn();
    const store = applyRememberedLinuxPasswordStore({
      platform: "linux",
      isE2E: false,
      argv: ["/usr/bin/pwrsnap"],
      env: {},
      userDataDir: tempDir(),
      appendSwitch,
      ...overrides
    });
    return { store, appendSwitch };
  }

  test("appends the store a previous launch remembered", () => {
    const userDataDir = tempDir();
    remember(userDataDir, "kwallet5");

    const { store, appendSwitch } = applyWith({ userDataDir });

    expect(store).toBe("kwallet5");
    expect(appendSwitch).toHaveBeenCalledWith("kwallet5");
  });

  test("an env override wins over the remembered file", () => {
    const userDataDir = tempDir();
    remember(userDataDir, "kwallet6");

    const { store, appendSwitch } = applyWith({ userDataDir, env: { PWRSNAP_LINUX_PASSWORD_STORE: "gnome-libsecret" } });

    expect(store).toBe("gnome-libsecret");
    expect(appendSwitch).toHaveBeenCalledWith("gnome-libsecret");
  });

  test("`auto` still uses the remembered file", () => {
    const userDataDir = tempDir();
    remember(userDataDir, "gnome-libsecret");

    expect(applyWith({ userDataDir, env: { PWRSNAP_LINUX_PASSWORD_STORE: "auto" } }).store).toBe("gnome-libsecret");
  });

  test("appends nothing when nothing was remembered, or the file holds something else", () => {
    expect(applyWith({}).appendSwitch).not.toHaveBeenCalled();

    const userDataDir = tempDir();
    remember(userDataDir, "gnome");
    expect(applyWith({ userDataDir }).appendSwitch).not.toHaveBeenCalled();
  });

  test("leaves the choice alone when argv, `basic`, E2E, or another platform already decided", () => {
    const userDataDir = tempDir();
    remember(userDataDir, "gnome-libsecret");

    for (const overrides of [
      { argv: ["/usr/bin/pwrsnap", "--password-store=kwallet6"] },
      { argv: ["/usr/bin/pwrsnap", "--password-store", "kwallet6"] },
      { env: { PWRSNAP_LINUX_PASSWORD_STORE: "basic" } },
      { isE2E: true },
      { platform: "darwin" as const },
      { platform: "win32" as const }
    ]) {
      const { store, appendSwitch } = applyWith({ userDataDir, ...overrides });
      expect(store).toBeUndefined();
      expect(appendSwitch).not.toHaveBeenCalled();
    }
  });
});

describe("relaunchForLinuxSecretStore", () => {
  /** Probes with `secretsProbe` unless the test supplies its own `exec`. */
  function relaunchWith(overrides: Partial<RelaunchForLinuxSecretStoreInput>) {
    const userDataDir = overrides.userDataDir ?? tempDir();
    const relaunch = vi.fn();
    const exit = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const exited = relaunchForLinuxSecretStore({
      platform: "linux",
      isE2E: false,
      argv: ["/usr/bin/pwrsnap", "--enable-logging", "/home/fixture/shot.pwrsnap"],
      env: {},
      userDataDir,
      selectedStore: undefined,
      backend: "basic_text",
      ...(overrides.exec === undefined ? { probe: secretsProbe } : {}),
      relaunch,
      exit,
      info,
      warn,
      ...overrides
    });
    return { exited, relaunch, exit, info, warn, userDataDir };
  }

  test("on basic_text, remembers the bus's secret service and relaunches onto it once", () => {
    const result = relaunchWith({});

    expect(result.exited).toBe(true);
    // The executable is dropped (Electron supplies it) and every other
    // argument survives, a file to open included.
    expect(result.relaunch).toHaveBeenCalledWith([
      "--enable-logging",
      "/home/fixture/shot.pwrsnap",
      "--password-store=gnome-libsecret"
    ]);
    expect(result.exit).toHaveBeenCalledWith(0);
    expect(readFileSync(linuxPasswordStorePath(result.userDataDir), "utf8")).toBe("gnome-libsecret\n");
    expect(existsSync(`${linuxPasswordStorePath(result.userDataDir)}.tmp`)).toBe(false);
  });

  test("a running service wins over an activatable one", () => {
    const result = relaunchWith({
      probe: { status: "ok", owned: ["org.kde.kwalletd6"], activatable: ["org.freedesktop.secrets"] }
    });

    expect(result.relaunch).toHaveBeenCalledWith(expect.arrayContaining(["--password-store=kwallet6"]));
  });

  test("an activatable service is used when nothing is running", () => {
    const result = relaunchWith({
      probe: { status: "ok", owned: ["org.freedesktop.DBus"], activatable: ["org.freedesktop.secrets"] }
    });

    expect(result.relaunch).toHaveBeenCalledWith(expect.arrayContaining(["--password-store=gnome-libsecret"]));
  });

  test("creates userData when this is the first launch", () => {
    const userDataDir = join(tempDir(), "fresh", "PwrSnap");

    expect(relaunchWith({ userDataDir }).exited).toBe(true);
    expect(readFileSync(linuxPasswordStorePath(userDataDir), "utf8")).toBe("gnome-libsecret\n");
  });

  test("still relaunches when the choice cannot be remembered", () => {
    // A path whose parent is a file: mkdir fails. This launch still gets a
    // real store; the next one probes again.
    const blocker = join(tempDir(), "blocker");
    writeFileSync(blocker, "");

    const result = relaunchWith({ userDataDir: join(blocker, "PwrSnap") });

    expect(result.exited).toBe(true);
    expect(result.warn).toHaveBeenCalledWith("linux secret store: could not remember the selection", expect.any(Object));
  });

  test.each(["gnome_libsecret", "kwallet5", "kwallet6", null])(
    "leaves a %s backend alone, so existing ciphertext keeps its key",
    (backend) => {
      const exec = vi.fn<CommandExec>();
      const result = relaunchWith({ backend, exec });

      expect(result.exited).toBe(false);
      expect(result.relaunch).not.toHaveBeenCalled();
      // Not even a bus probe: a usable backend costs nothing at startup.
      expect(exec).not.toHaveBeenCalled();
    }
  );

  test("never replaces a remembered store, even if that keyring is down right now", () => {
    const result = relaunchWith({ selectedStore: "kwallet6" });

    expect(result.exited).toBe(false);
    expect(result.relaunch).not.toHaveBeenCalled();
  });

  test("never overrides the operator's argv or env choice, or runs under E2E or off Linux", () => {
    for (const overrides of [
      { argv: ["/usr/bin/pwrsnap", "--password-store=basic"] },
      { env: { PWRSNAP_LINUX_PASSWORD_STORE: "basic" } },
      { env: { PWRSNAP_LINUX_PASSWORD_STORE: "kwallet6" } },
      { isE2E: true },
      { platform: "darwin" as const }
    ]) {
      const result = relaunchWith(overrides);
      expect(result.exited).toBe(false);
      expect(result.relaunch).not.toHaveBeenCalled();
    }
  });

  test("`auto` behaves like no override", () => {
    expect(relaunchWith({ env: { PWRSNAP_LINUX_PASSWORD_STORE: "auto" } }).exited).toBe(true);
  });

  test("stays put, writing nothing, when the bus has no secret service or cannot be read", () => {
    const none = relaunchWith({ probe: { status: "ok", owned: ["org.freedesktop.DBus"], activatable: [] } });
    expect(none.exited).toBe(false);
    expect(existsSync(linuxPasswordStorePath(none.userDataDir))).toBe(false);

    const failed = relaunchWith({ probe: { status: "unavailable", reason: "no dbus client (busctl, dbus-send, gdbus)" } });
    expect(failed.exited).toBe(false);
    expect(failed.warn).toHaveBeenCalledWith(expect.stringContaining("probe failed"), {
      reason: "no dbus client (busctl, dbus-send, gdbus)"
    });
    expect(existsSync(linuxPasswordStorePath(failed.userDataDir))).toBe(false);
  });

  test("a remembered store is applied on the next launch, which then does not relaunch", () => {
    const first = relaunchWith({});
    const appendSwitch = vi.fn();
    const selectedStore = applyRememberedLinuxPasswordStore({
      platform: "linux",
      isE2E: false,
      argv: ["/usr/bin/pwrsnap"],
      env: {},
      userDataDir: first.userDataDir,
      appendSwitch
    });

    expect(appendSwitch).toHaveBeenCalledWith("gnome-libsecret");
    const second = relaunchWith({ userDataDir: first.userDataDir, selectedStore, backend: "gnome_libsecret" });
    expect(second.exited).toBe(false);
  });
});

describe("linux password store wiring", () => {
  const mainSource = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  const readyIndex = mainSource.indexOf("app.whenReady().then(async () => {");

  test("the remembered store is appended before ready, after the userData override", () => {
    const applyIndex = mainSource.indexOf("applyRememberedLinuxPasswordStore({");
    const userDataOverrideIndex = mainSource.indexOf('app.setPath("userData", customUserData)');

    expect(applyIndex).toBeGreaterThan(-1);
    expect(userDataOverrideIndex).toBeGreaterThan(-1);
    // Chromium reads --password-store during early init.
    expect(readyIndex).toBeGreaterThan(applyIndex);
    // The file lives in the userData this process will actually use.
    expect(applyIndex).toBeGreaterThan(userDataOverrideIndex);
  });

  test("the relaunch runs right after the shutdown listener, before anything is created", () => {
    // `installSystemShutdown()` stays first (system-shutdown.test.ts pins it).
    const shutdownIndex = mainSource.indexOf("installSystemShutdown();", readyIndex);
    const relaunchIndex = mainSource.indexOf("relaunchForLinuxSecretStore({");
    const nextInstallIndex = mainSource.indexOf("installMediaPermissionPolicy();", readyIndex);

    expect(shutdownIndex).toBeGreaterThan(readyIndex);
    expect(relaunchIndex).toBeGreaterThan(shutdownIndex);
    expect(nextInstallIndex).toBeGreaterThan(relaunchIndex);
  });

  test("both calls pass the real E2E flag", () => {
    const calls = mainSource.match(/(?:applyRememberedLinuxPasswordStore|relaunchForLinuxSecretStore)\(\{[^}]*?isE2E,/g);
    expect(calls).toHaveLength(2);
  });
});
