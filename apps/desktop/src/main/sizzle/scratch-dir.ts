import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { app } from "electron";

// Per-project chat scratch directories at
// ~/Documents/PwrSnap/Chats/<YYYY-MM-DD>-<sanitized-project-name>/.
// The Sizzle chat agent runs sandboxed (workspace-write) with this dir
// as its cwd, so any files it writes land somewhere the user can find —
// and the whole dir is reaped when the project is deleted (locked
// decision #6). Mirrors PwrAgnt's scratch-project minting: exclusive
// mkdir with a random-suffix collision retry.

/** Lazily resolved so unit tests can pass an explicit `root` and never
 *  touch Electron's `app`. */
function defaultChatsRoot(): string {
  return join(app.getPath("documents"), "PwrSnap", "Chats");
}

/** Turn a project name into a filesystem-safe directory component.
 *  Mirrors `sanitizeProjectFilename` in sizzle-handlers but tuned for a
 *  directory leaf (no leading dots, collapsed separators). */
export function sanitizeChatDirName(name: string): string {
  const stripped = name
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^[.\s]+/, "_")
    .replace(/[_\s]+/g, "_")
    .replace(/_+$/g, "")
    .slice(0, 60);
  return stripped.length > 0 ? stripped : "chat";
}

/**
 * Mint a fresh scratch directory for a project's chat. Returns the
 * absolute path. Uses non-recursive `mkdir` so an EEXIST collision is
 * detectable and retried with a random suffix.
 */
export async function createChatScratchDir(params: {
  projectName: string;
  root?: string;
  now?: Date;
}): Promise<string> {
  const root = params.root ?? defaultChatsRoot();
  await mkdir(root, { recursive: true });
  const date = (params.now ?? new Date()).toISOString().slice(0, 10);
  const base = `${date}-${sanitizeChatDirName(params.projectName)}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = attempt === 0 ? "" : `-${randomBytes(3).toString("hex")}`;
    const dir = join(root, `${base}${suffix}`);
    try {
      await mkdir(dir);
      return dir;
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "EEXIST") continue;
      throw cause;
    }
  }
  throw new Error(`could not mint a unique chat scratch directory under ${root}`);
}

/**
 * Remove a chat scratch directory and everything in it. Refuses to
 * delete anything outside the Chats root — a defensive guard so a
 * corrupt / spoofed stored path can never trigger an `rm -rf` elsewhere.
 */
export async function deleteChatScratchDir(params: {
  dir: string;
  root?: string;
}): Promise<void> {
  if (params.dir.length === 0) return;
  const root = resolve(params.root ?? defaultChatsRoot());
  const target = resolve(params.dir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`refusing to delete chat scratch dir outside ${root}: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}
