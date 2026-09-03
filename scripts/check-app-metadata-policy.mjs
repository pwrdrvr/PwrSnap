#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `description` in apps/desktop/package.json is SHIPPED UI on Windows, not
// inert metadata. electron-builder reads it into `AppInfo.description` and
// emits it twice:
//
//   - the NSIS installer's own FileDescription version string, which is what
//     SmartScreen and Explorer's Properties -> Details name the program;
//   - APP_DESCRIPTION, passed to `CreateShortCut` for the Start Menu and
//     desktop .lnk files, which is the line Windows 11 renders in the taskbar
//     jump list above "Pin to taskbar" / "Close window".
//
// The app exe's own FileDescription is `productName`, so the string is
// invisible on macOS and only appears once a .exe is built and installed.
// v1.1 shipped "Mac-first agentic screen capture tool" to Windows users that
// way, and nothing here caught it. Hence this gate, which runs in `pnpm lint`
// (so on every PR) rather than only at release time.
//
// Only these two files are covered: apps/desktop/package.json is the one
// electron-builder reads, and the root workspace copy is kept identical so a
// reader cannot pick up the wrong one. The `packages/*` descriptions are
// library metadata that never reaches an installer.
const DESKTOP_PACKAGE = "apps/desktop/package.json";
const ROOT_PACKAGE = "package.json";

// Words that name one platform. A description carrying any of them is wrong on
// every other platform it ships to. Deliberately broader than the "Mac-first"
// wording that prompted the gate — the next regression will not reuse it.
const PLATFORM_WORDS = [
  "mac",
  "macos",
  "osx",
  "darwin",
  "apple",
  "cocoa",
  "appkit",
  "ios",
  "ipados",
  "iphone",
  "ipad",
  "windows",
  "win32",
  "win64",
  "linux",
];
const PLATFORM_WORD_PATTERN = new RegExp(`\\b(?:${PLATFORM_WORDS.join("|")})\\b`, "i");

// The jump-list entry and the SmartScreen program name are single-line labels.
// Anything longer is truncated by the OS, not wrapped.
const MAX_DESCRIPTION_LENGTH = 80;

function readPackageJson(root, relPath) {
  try {
    return JSON.parse(readFileSync(resolve(root, relPath), "utf8"));
  } catch (error) {
    return { __readError: error instanceof Error ? error.message : String(error) };
  }
}

export function checkAppMetadataPolicy(root = repoRoot) {
  const failures = [];

  const desktopPackage = readPackageJson(root, DESKTOP_PACKAGE);
  if (desktopPackage.__readError !== undefined) {
    return [`${DESKTOP_PACKAGE} could not be read: ${desktopPackage.__readError}`];
  }

  const description = desktopPackage.description;
  if (typeof description !== "string" || description.trim() === "") {
    failures.push(
      `${DESKTOP_PACKAGE} description must be a non-empty string; Windows ships it as the installer FileDescription and the Start Menu shortcut comment`,
    );
  } else {
    if (PLATFORM_WORD_PATTERN.test(description)) {
      failures.push(
        `${DESKTOP_PACKAGE} description must stay platform-neutral because Windows ships it as the installer FileDescription and the Start Menu shortcut comment; got ${JSON.stringify(description)}`,
      );
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      failures.push(
        `${DESKTOP_PACKAGE} description is ${description.length} characters; keep it at or under ${MAX_DESCRIPTION_LENGTH} so the Windows jump-list label is not truncated`,
      );
    }

    const rootPackage = readPackageJson(root, ROOT_PACKAGE);
    if (rootPackage.__readError !== undefined) {
      failures.push(`${ROOT_PACKAGE} could not be read: ${rootPackage.__readError}`);
    } else if (rootPackage.description !== description) {
      failures.push(
        `${ROOT_PACKAGE} description ${JSON.stringify(rootPackage.description)} must match ${DESKTOP_PACKAGE} description ${JSON.stringify(description)}`,
      );
    }
  }

  return failures.sort((a, b) => a.localeCompare(b));
}

function runCli() {
  const failures = checkAppMetadataPolicy();
  if (failures.length > 0) {
    console.error("app metadata policy check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("app metadata policy check passed");
}

export { isCliEntrypoint };

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
