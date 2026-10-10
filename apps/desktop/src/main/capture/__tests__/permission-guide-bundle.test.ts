// The permission guide must hand over the RUNNING bundle, and must report the
// other copies macOS will list under the same name.

import { describe, expect, test } from "vitest";
import {
  abbreviateHome,
  appBundlePathFromExe,
  appNameFromBundlePath,
  otherCopiesFromMdfind
} from "../permission-guide-bundle";

describe("appBundlePathFromExe", () => {
  test("packaged executable → its .app", () => {
    expect(appBundlePathFromExe("/Applications/PwrSnap.app/Contents/MacOS/PwrSnap")).toBe(
      "/Applications/PwrSnap.app"
    );
  });

  test("a bundle path containing spaces and a nested .app name", () => {
    expect(
      appBundlePathFromExe("/Users/a/Downloads/PwrSnap 1.1.15.app/Contents/MacOS/PwrSnap")
    ).toBe("/Users/a/Downloads/PwrSnap 1.1.15.app");
    // A helper app inside the bundle resolves to the innermost .app.
    expect(
      appBundlePathFromExe(
        "/Applications/PwrSnap.app/Contents/Frameworks/PwrSnap Helper.app/Contents/MacOS/PwrSnap Helper"
      )
    ).toBe("/Applications/PwrSnap.app/Contents/Frameworks/PwrSnap Helper.app");
  });

  test("not inside a bundle → null", () => {
    expect(appBundlePathFromExe("/usr/local/bin/electron")).toBeNull();
  });
});

describe("appNameFromBundlePath", () => {
  test("strips the directory and the .app suffix", () => {
    expect(appNameFromBundlePath("/Applications/PwrSnap.app")).toBe("PwrSnap");
    expect(appNameFromBundlePath("/x/Electron.app")).toBe("Electron");
  });
});

describe("abbreviateHome", () => {
  test("only a whole leading home segment is abbreviated", () => {
    expect(abbreviateHome("/Users/a/Downloads/PwrSnap.app", "/Users/a")).toBe("~/Downloads/PwrSnap.app");
    expect(abbreviateHome("/Users/ab/PwrSnap.app", "/Users/a")).toBe("/Users/ab/PwrSnap.app");
    expect(abbreviateHome("/Applications/PwrSnap.app", "/Users/a")).toBe("/Applications/PwrSnap.app");
  });
});

describe("otherCopiesFromMdfind", () => {
  test("drops the running copy, nested bundles, the Trash, and duplicates", () => {
    const stdout = [
      "/Applications/PwrSnap.app",
      "/Users/a/Downloads/PwrSnap 1.1.15.app",
      "/Volumes/PwrSnap/PwrSnap.app",
      "/Users/a/.Trash/PwrSnap.app",
      "/Applications/PwrSnap.app/Contents/Library/LoginItems/Helper.app",
      "/Users/a/Downloads/PwrSnap 1.1.15.app",
      "",
      "/Users/a/notes.txt"
    ].join("\n");
    expect(otherCopiesFromMdfind(stdout, "/Applications/PwrSnap.app")).toEqual([
      "/Users/a/Downloads/PwrSnap 1.1.15.app",
      "/Volumes/PwrSnap/PwrSnap.app"
    ]);
  });
});
