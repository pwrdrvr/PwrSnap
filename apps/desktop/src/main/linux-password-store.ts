// Pick a real Linux secret store for `safeStorage`.
//
// Chromium chooses the store from `--password-store`, and failing that from
// the desktop environment. A desktop it does not recognize (Hyprland, sway,
// i3, LXQt, ...) is reported as `basic_text`: a key compiled into Chromium,
// which is plaintext by another name. `DesktopSecretStore` refuses to write
// secrets there, so on those desktops every secret-backed feature (an
// OpenAI key, a local agent's token, a custom model credential) fails, even
// when a perfectly good keyring is running on the session bus.
//
// The fix is the one PwrAgent ships (pwrdrvr/PwrAgent#2322):
//
//   1. After ready, if the backend is `basic_text`, ask the session bus which
//      secret service is actually there (not Chromium's desktop list), write
//      that choice to `linux-password-store` in userData, and relaunch once
//      with `--password-store` set to it.
//   2. Every later launch appends the remembered switch before Chromium reads
//      it, so the relaunch happens once per install, not once per launch.
//
// A backend that is not `basic_text` is left alone, so a KWallet user is
// never moved onto libsecret: that would mint a new key and strand the
// ciphertext the old one wrote.
//
// One difference from PwrAgent: "is the backend usable" is decided from
// `getSelectedStorageBackend()` alone. PwrAgent also asks the sync
// `isEncryptionAvailable()`, which Electron 45 deprecates and Electron 46
// removes, and which reaches the answer by fetching the key, a keyring read
// at every launch. Its async replacement initializes the encryptor (the same
// keyring read) and resolves true whether or not a key was found. Neither
// belongs on the startup path, so a GNOME session whose keyring daemon is not
// running is not handled here: the secret store refuses its writes instead.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Operator override: one of the stores below, `basic` (leave Chromium's
 *  choice alone), or `auto` (the default behavior). */
export const LINUX_PASSWORD_STORE_ENV = "PWRSNAP_LINUX_PASSWORD_STORE";
export const LINUX_PASSWORD_STORE_FILE = "linux-password-store";

const PASSWORD_STORE_SWITCH = "--password-store";
const BUS_TIMEOUT_MS = 1_000;

/** Chromium's `--password-store` spellings. Note `gnome` is NOT one of them:
 *  PwrAgent measured it selecting `basic_text` on Electron 41. */
const LINUX_SECRET_STORES = ["gnome-libsecret", "kwallet", "kwallet5", "kwallet6"] as const;

export type LinuxSecretStore = (typeof LINUX_SECRET_STORES)[number];

/** Bus name -> store, in preference order. */
const SECRET_SERVICES = [
  ["org.freedesktop.secrets", "gnome-libsecret"],
  ["org.kde.kwalletd6", "kwallet6"],
  ["org.kde.kwalletd5", "kwallet5"],
  ["org.kde.kwalletd", "kwallet"]
] as const satisfies ReadonlyArray<readonly [string, LinuxSecretStore]>;

type BusTool = {
  command: string;
  listArgs: readonly string[];
  activatableArgs: readonly string[];
};

/** Tried in order; a missing binary falls through to the next. */
const BUS_TOOLS: readonly BusTool[] = [
  {
    command: "busctl",
    listArgs: ["--user", "--no-pager", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames"],
    activatableArgs: [
      "--user",
      "--no-pager",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListActivatableNames"
    ]
  },
  {
    command: "dbus-send",
    listArgs: ["--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"],
    activatableArgs: [
      "--session",
      "--print-reply",
      "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.ListActivatableNames"
    ]
  },
  {
    command: "gdbus",
    listArgs: [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.ListNames"
    ],
    activatableArgs: [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.ListActivatableNames"
    ]
  }
];

export type CommandResult =
  | { status: 0; stdout: string }
  | { status: number; stdout: string; stderr: string }
  | { missing: true };

export type CommandExec = (command: string, args: readonly string[]) => CommandResult;

export type SecretServiceProbe =
  | { status: "ok"; owned: readonly string[]; activatable: readonly string[] }
  | { status: "unavailable"; reason: string };

/** Bus names from a busctl, dbus-send, or gdbus `ListNames` reply. */
export function parseDbusNameList(stdout: string): string[] {
  const names = new Set<string>();
  for (const match of stdout.matchAll(/["']([A-Za-z_][\w.-]*)["']/g)) {
    const name = match[1];
    if (name?.includes(".")) names.add(name);
  }
  return [...names];
}

export function linuxPasswordStorePath(userDataDir: string): string {
  return join(userDataDir, LINUX_PASSWORD_STORE_FILE);
}

function isLinuxSecretStore(value: string): value is LinuxSecretStore {
  return LINUX_SECRET_STORES.some((store) => store === value);
}

function argvSelectsPasswordStore(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === PASSWORD_STORE_SWITCH || arg.startsWith(`${PASSWORD_STORE_SWITCH}=`));
}

function forcedStore(env: NodeJS.ProcessEnv): LinuxSecretStore | "basic" | "auto" | undefined {
  const raw = env[LINUX_PASSWORD_STORE_ENV]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "auto" || raw === "basic") return raw;
  return isLinuxSecretStore(raw) ? raw : undefined;
}

function readStoreFile(userDataDir: string): LinuxSecretStore | undefined {
  try {
    const text = readFileSync(linuxPasswordStorePath(userDataDir), "utf8").trim();
    return isLinuxSecretStore(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** tmp + rename, like every other file PwrSnap keeps in userData: a torn
 *  write would read back as "no store" and cost one more relaunch, nothing
 *  worse, but there is no reason to allow it. */
function writeStoreFile(userDataDir: string, store: LinuxSecretStore): void {
  mkdirSync(userDataDir, { recursive: true });
  const path = linuxPasswordStorePath(userDataDir);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${store}\n`, "utf8");
  renameSync(tmpPath, path);
}

function storeForNames(names: readonly string[]): LinuxSecretStore | undefined {
  for (const [service, store] of SECRET_SERVICES) {
    if (names.includes(service)) return store;
  }
  return undefined;
}

/** A running service wins over one that is only activatable. */
function storeFromProbe(probe: SecretServiceProbe): LinuxSecretStore | undefined {
  if (probe.status !== "ok") return undefined;
  return storeForNames(probe.owned) ?? storeForNames(probe.activatable);
}

/** argv without the executable, with any `--password-store` replaced. */
function argsWithPasswordStore(argv: readonly string[], store: LinuxSecretStore): string[] {
  const args: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === PASSWORD_STORE_SWITCH) {
      index += 1;
      continue;
    }
    if (arg === undefined || arg.startsWith(`${PASSWORD_STORE_SWITCH}=`)) continue;
    args.push(arg);
  }
  args.push(`${PASSWORD_STORE_SWITCH}=${store}`);
  return args;
}

function defaultExec(command: string, args: readonly string[]): CommandResult {
  try {
    return {
      status: 0,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        timeout: BUS_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"]
      })
    };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { status?: unknown; stdout?: unknown; stderr?: unknown };
    if (failed.code === "ENOENT") return { missing: true };
    return {
      status: typeof failed.status === "number" ? failed.status : 1,
      stdout: typeof failed.stdout === "string" ? failed.stdout : "",
      stderr: typeof failed.stderr === "string" ? failed.stderr : (failed.code ?? "dbus client failed")
    };
  }
}

/** List the session bus's owned and activatable names with the first dbus
 *  client that is installed. A client that runs and fails is a probe
 *  failure, not a reason to try the next one. */
export function probeSecretServices(exec: CommandExec = defaultExec): SecretServiceProbe {
  let missingTools = 0;
  for (const tool of BUS_TOOLS) {
    const listed = exec(tool.command, tool.listArgs);
    if ("missing" in listed) {
      missingTools += 1;
      continue;
    }
    if (listed.status !== 0) {
      return { status: "unavailable", reason: `${tool.command} ListNames exited ${listed.status}` };
    }
    const owned = parseDbusNameList(listed.stdout);
    const activatableResult = exec(tool.command, tool.activatableArgs);
    const activatable =
      "missing" in activatableResult || activatableResult.status !== 0 ? [] : parseDbusNameList(activatableResult.stdout);
    return { status: "ok", owned, activatable };
  }
  return {
    status: "unavailable",
    reason: missingTools === BUS_TOOLS.length ? "no dbus client (busctl, dbus-send, gdbus)" : "session bus name list failed"
  };
}

export type ApplyRememberedLinuxPasswordStoreInput = {
  platform: NodeJS.Platform;
  isE2E: boolean;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  userDataDir: string;
  appendSwitch: (store: LinuxSecretStore) => void;
};

/**
 * Append an operator override, or the store a previous launch picked.
 *
 * Must run synchronously during bootstrap, before `app.whenReady()`:
 * Chromium reads `--password-store` once during early init. Returns the
 * store that was appended.
 */
export function applyRememberedLinuxPasswordStore(input: ApplyRememberedLinuxPasswordStoreInput): LinuxSecretStore | undefined {
  if (input.platform !== "linux" || input.isE2E) return undefined;
  if (argvSelectsPasswordStore(input.argv)) return undefined;

  const forced = forcedStore(input.env);
  if (forced === "basic") return undefined;
  const store = forced !== undefined && forced !== "auto" ? forced : readStoreFile(input.userDataDir);
  if (store === undefined) return undefined;
  input.appendSwitch(store);
  return store;
}

export type RelaunchForLinuxSecretStoreInput = {
  platform: NodeJS.Platform;
  isE2E: boolean;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  userDataDir: string;
  /** What `applyRememberedLinuxPasswordStore` appended, if anything.
   *  `appendSwitch` does not show up in `process.argv`. */
  selectedStore: LinuxSecretStore | undefined;
  /** `safeStorage.getSelectedStorageBackend()`, read after ready. */
  backend: string | null;
  probe?: SecretServiceProbe;
  exec?: CommandExec;
  relaunch: (args: string[]) => void;
  exit: (code: number) => void;
  info: (message: string, fields: Record<string, unknown>) => void;
  warn: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * When this process came up on `basic_text`, relaunch once onto the secret
 * service that is on the bus, and remember it for later launches.
 *
 * A store the operator chose (argv or env) or a previous launch picked is
 * never replaced, even when that keyring is unavailable right now: a locked
 * or stopped KWallet is not a reason to move the user's secrets elsewhere.
 * Returns true when the process is exiting for the relaunch.
 */
export function relaunchForLinuxSecretStore(input: RelaunchForLinuxSecretStoreInput): boolean {
  if (input.platform !== "linux" || input.isE2E) return false;
  if (argvSelectsPasswordStore(input.argv)) return false;
  if (input.selectedStore !== undefined) return false;

  const forced = forcedStore(input.env);
  if (forced !== undefined && forced !== "auto") return false;
  if (input.backend !== "basic_text") return false;

  const probe = input.probe ?? probeSecretServices(input.exec);
  if (probe.status === "unavailable") {
    input.warn("linux secret store: session bus probe failed; staying on basic_text", { reason: probe.reason });
    return false;
  }

  const store = storeFromProbe(probe);
  if (store === undefined) {
    input.info("linux secret store: no secret service on the session bus; staying on basic_text", {});
    return false;
  }

  try {
    writeStoreFile(input.userDataDir, store);
  } catch (error) {
    // Relaunch anyway: this launch still gets a real store. The next one
    // probes again.
    input.warn("linux secret store: could not remember the selection", {
      message: error instanceof Error ? error.message : String(error)
    });
  }

  input.info("linux secret store: relaunching onto the session bus's secret service", { store });
  input.relaunch(argsWithPasswordStore(input.argv, store));
  input.exit(0);
  return true;
}
