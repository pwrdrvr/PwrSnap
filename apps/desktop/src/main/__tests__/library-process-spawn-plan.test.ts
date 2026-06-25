// Spawn-plan computation for the library child process (§D2). The
// packaged/dev split is the part worth pinning: packaged Electron's
// execPath IS the app, dev's execPath is the bare runtime and needs
// the app dir argument or it boots Electron's default app.

import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));
vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const { libraryProcessSpawnPlan, isLibraryWindowSpawnVerb } = await import(
  "../process-split/library-process-supervisor"
);

describe("libraryProcessSpawnPlan", () => {
  test("packaged: relaunch our own binary with only the role flag", () => {
    expect(
      libraryProcessSpawnPlan({
        execPath: "/Applications/PwrSnap.app/Contents/MacOS/PwrSnap",
        appPath: "/Applications/PwrSnap.app/Contents/Resources/app.asar",
        isPackaged: true
      })
    ).toEqual({
      command: "/Applications/PwrSnap.app/Contents/MacOS/PwrSnap",
      args: ["--pwrsnap-role=library"]
    });
  });

  test("dev: bare Electron binary needs the app dir before the role flag", () => {
    expect(
      libraryProcessSpawnPlan({
        execPath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        appPath: "/repo/apps/desktop",
        isPackaged: false
      })
    ).toEqual({
      command: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      args: ["/repo/apps/desktop", "--pwrsnap-role=library"]
    });
  });
});

describe("isLibraryWindowSpawnVerb (cold-launch watchdog arming)", () => {
  test("arms for verbs that must produce a visible library main window", () => {
    expect(isLibraryWindowSpawnVerb("library:focus")).toBe(true);
    expect(isLibraryWindowSpawnVerb("library:openInLibrary")).toBe(true);
    expect(isLibraryWindowSpawnVerb("editor:open")).toBe(true);
  });

  test("does NOT arm for non-window verbs (no watchdog → no false kill)", () => {
    // Data/settings/etc. don't create the main window; a watchdog there
    // would time out (no window-ready signal) and kill a healthy library.
    expect(isLibraryWindowSpawnVerb("library:list")).toBe(false);
    expect(isLibraryWindowSpawnVerb("settings:open")).toBe(false);
    expect(isLibraryWindowSpawnVerb("settings:read")).toBe(false);
    expect(isLibraryWindowSpawnVerb("app:openDocumentWindow")).toBe(false);
    expect(isLibraryWindowSpawnVerb("capture:interactive")).toBe(false);
  });
});
