#!/usr/bin/env node

import { readFileSync } from "node:fs";

const RELEASES_URL = "https://github.com/pwrdrvr/PwrSnap/releases/latest";
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

const args = process.argv.slice(2);

function writeDownloadLink() {
  process.stdout.write(
    [
      "PwrSnap is a desktop screen-capture app for macOS and Windows.",
      "Official downloads:",
      RELEASES_URL,
      ""
    ].join("\n")
  );
}

function writeHelp() {
  process.stdout.write(
    [
      "Usage: pwrsnap [--help | --version]",
      "",
      "Print the official PwrSnap desktop download URL.",
      "This npm helper does not install, open, or control PwrSnap.",
      "",
      "Options:",
      "  -h, --help     Show this help",
      "  -v, --version  Show the npm helper version",
      ""
    ].join("\n")
  );
}

if (args.length === 0) {
  writeDownloadLink();
} else if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  writeHelp();
} else if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  process.stdout.write(
    `pwrsnap npm helper ${version}\nThis is not the PwrSnap desktop app version.\n`
  );
} else {
  process.stderr.write(
    `pwrsnap: unsupported argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}\n` +
      'Run "pwrsnap --help" for usage.\n'
  );
  process.exitCode = 2;
}
