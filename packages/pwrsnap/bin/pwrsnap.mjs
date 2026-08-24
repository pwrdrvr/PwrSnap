#!/usr/bin/env node

const RELEASES_URL = "https://github.com/pwrdrvr/PwrSnap/releases/latest";

process.stdout.write(
  [
    "PwrSnap is a desktop screen-capture app for macOS and Windows.",
    "Download the latest release:",
    RELEASES_URL,
    ""
  ].join("\n")
);
