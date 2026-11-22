// The image-attachment API is in the macOS 27 SDK. Compile the small
// helper separately so the rest of the app can keep its existing SDK.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const source = join(desktop, "native", "apple-caption", "main.swift");
const output = join(desktop, "build", "native", "apple-caption");
const universal = process.argv.includes("--universal");
const optional = process.argv.includes("--if-supported");

if (process.platform !== "darwin") {
  if (optional) process.exit(0);
  throw new Error("The Apple caption helper requires macOS.");
}

let sdk;
try {
  sdk = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-version"], { encoding: "utf8" }).trim();
} catch (error) {
  if (!optional) throw error;
}
if (sdk === undefined || Number.parseInt(sdk, 10) < 27) {
  if (!optional) throw new Error("Building the Apple caption helper requires the macOS 27 SDK.");
  rmSync(output, { force: true });
  console.log("[build-apple-caption] macOS 27 SDK unavailable; skipping the local helper build");
  process.exit(0);
}

const hostArch = process.arch === "x64" ? "x86_64" : process.arch;
const architectures = universal ? ["arm64", "x86_64"] : [hostArch];
mkdirSync(dirname(output), { recursive: true });
const work = mkdtempSync(join(dirname(output), ".apple-caption-"));
try {
  const binaries = architectures.map((arch) => {
    const binary = join(work, arch);
    execFileSync("xcrun", [
      "swiftc", "-O", "-warnings-as-errors",
      "-target", `${arch}-apple-macosx26.0`, source, "-o", binary
    ], { stdio: "inherit" });
    return binary;
  });
  const staged = join(work, "apple-caption");
  if (universal) {
    execFileSync("lipo", ["-create", ...binaries, "-output", staged], { stdio: "inherit" });
    const slices = execFileSync("lipo", ["-archs", staged], { encoding: "utf8" })
      .trim().split(/\s+/).sort();
    if (slices.join(" ") !== "arm64 x86_64") {
      throw new Error("The Apple caption helper must contain both macOS architectures.");
    }
  } else {
    renameSync(binaries[0], staged);
  }
  execFileSync("codesign", ["--force", "--sign", "-", staged], { stdio: "inherit" });
  renameSync(staged, output);
  console.log(`[build-apple-caption] ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
