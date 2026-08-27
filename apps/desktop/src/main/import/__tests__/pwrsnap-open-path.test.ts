import { describe, expect, test } from "vitest";

import { normalizePwrsnapOpenPath } from "../pwrsnap-open-path";

describe("normalizePwrsnapOpenPath", () => {
  test.each([
    "/Users/alice/Downloads/demo.pwrsnap",
    "/Volumes/USB/PwrSnap Demo.PWRSNAP"
  ])("accepts an absolute macOS path: %s", (path) => {
    expect(normalizePwrsnapOpenPath(path, { platform: "darwin" })).toBe(path);
  });

  test.each([
    "demo.pwrsnap",
    "~/Downloads/demo.pwrsnap",
    "file:///Users/alice/Downloads/demo.pwrsnap",
    "/Users/alice/Downloads/../Secrets/demo.pwrsnap",
    "/Users/alice/Downloads/demo.pwrsnap\0"
  ])("rejects a non-native or noncanonical macOS path: %s", (path) => {
    expect(() => normalizePwrsnapOpenPath(path, { platform: "darwin" })).toThrow();
  });

  test.each([
    ["C:\\Users\\Alice\\Downloads\\demo.pwrsnap", "C:\\Users\\Alice\\Downloads\\demo.pwrsnap"],
    ["c:/Users/Alice/Downloads/demo.PWRSNAP", "c:\\Users\\Alice\\Downloads\\demo.PWRSNAP"],
    ["\\\\server\\share\\folder\\demo.pwrsnap", "\\\\server\\share\\folder\\demo.pwrsnap"]
  ])("accepts and normalizes an absolute Windows drive/UNC path: %s", (input, expected) => {
    expect(normalizePwrsnapOpenPath(input!, { platform: "win32" })).toBe(expected);
  });

  test.each([
    "C:relative\\demo.pwrsnap",
    "\\Users\\Alice\\demo.pwrsnap",
    "/Users/Alice/demo.pwrsnap",
    "\\\\?\\C:\\Users\\Alice\\demo.pwrsnap",
    "\\\\.\\C:\\Users\\Alice\\demo.pwrsnap",
    "\\\\?\\UNC\\server\\share\\demo.pwrsnap",
    "file:///C:/Users/Alice/demo.pwrsnap",
    "file://server/share/demo.pwrsnap",
    "C:\\dir\\demo.pwrsnap:stream",
    "C:\\dir\\..\\demo.pwrsnap",
    "C:\\dir\\CON.pwrsnap",
    "C:\\dir.\\demo.pwrsnap"
  ])("rejects an unsafe or ambiguous Windows path: %s", (path) => {
    expect(() => normalizePwrsnapOpenPath(path, { platform: "win32" })).toThrow();
  });
});
