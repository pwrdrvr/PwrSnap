// Electron 43+ rounds frameless Linux windows unless told not to, and on Linux
// that clips the web contents themselves. See linux-window-corners.ts for why
// every PwrSnap window opts out. A window added later that forgets to is a
// Linux-only visual change nobody on macOS CI would see, so fail here instead.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { linuxSquareCorners } from "../linux-window-corners";

const mainRoot = fileURLToPath(new URL("..", import.meta.url));

function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...productionSources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

/** The brace-matched options literal of every `new BrowserWindow({ … })`. */
function browserWindowOptions(source: string): string[] {
  const literals: string[] = [];
  const marker = "new BrowserWindow(";
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
    const open = source.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}" && --depth === 0) {
        literals.push(source.slice(open, i + 1));
        break;
      }
    }
  }
  return literals;
}

describe("linuxSquareCorners", () => {
  test("opts out of Electron's rounding on Linux only", () => {
    expect(linuxSquareCorners("linux")).toEqual({ roundedCorners: false });
    expect(linuxSquareCorners("darwin")).toEqual({});
    expect(linuxSquareCorners("win32")).toEqual({});
  });

  test("every BrowserWindow main constructs spreads it", () => {
    const windows: string[] = [];
    for (const file of productionSources(mainRoot)) {
      // Comments out, so prose that mentions the constructor is not a window.
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (!source.includes("new BrowserWindow(")) continue;
      browserWindowOptions(source).forEach((options, index) => {
        const label = `${relative(mainRoot, file)} #${index + 1}`;
        windows.push(label);
        expect(options, label).toContain("...linuxSquareCorners(),");
      });
    }
    // Guards the scan itself: a refactor that moved every constructor out of
    // reach of `new BrowserWindow(` would otherwise pass with nothing checked.
    expect(windows.length).toBeGreaterThanOrEqual(13);
  });
});
