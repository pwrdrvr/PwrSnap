import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { getMainLogger } from "../log";

const execFileAsync = promisify(execFile);
const log = getMainLogger("pwrsnap:named-image-pasteboard");

const PRODUCTION_HELPER_NAME = "PwrSnapPasteboardWriter";
const DEV_HELPER_NAME = "pasteboard-writer";

let cachedHelperPath: string | null | undefined;

function resolvePasteboardWriterPath(): string | null {
  if (cachedHelperPath !== undefined) return cachedHelperPath;
  if (process.platform !== "darwin") {
    cachedHelperPath = null;
    return null;
  }

  const candidates = [join(__dirname, "..", "..", "build", "native", DEV_HELPER_NAME)];
  if (typeof process.resourcesPath === "string") {
    candidates.unshift(join(process.resourcesPath, PRODUCTION_HELPER_NAME));
  }
  try {
    candidates.push(join(app.getAppPath(), "build", "native", DEV_HELPER_NAME));
  } catch {
    // app.getAppPath can be unavailable before ready in some test harnesses.
  }

  cachedHelperPath = candidates.find((candidate) => existsSync(candidate)) ?? null;
  return cachedHelperPath;
}

export async function writeNamedPngToPasteboard(args: {
  pngPath: string;
  fileUrlPath: string;
}): Promise<boolean> {
  const helperPath = resolvePasteboardWriterPath();
  if (helperPath === null) return false;

  try {
    await execFileAsync(helperPath, ["--png", args.pngPath, "--file-url", args.fileUrlPath]);
    return true;
  } catch (cause) {
    log.warn("named image pasteboard helper failed; falling back to Electron image clipboard", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return false;
  }
}
