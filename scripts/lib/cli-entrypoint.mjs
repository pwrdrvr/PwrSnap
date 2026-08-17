import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Node realpaths the ESM main module when forming `import.meta.url`
// (`--preserve-symlinks-main` is off by default), but `process.argv[1]` keeps
// whatever path the caller typed, and `resolve()` does not follow symlinks. So
// both sides must be realpathed or a symlinked invocation compares unequal —
// macOS `/tmp` -> `/private/tmp`, a symlinked CI workspace, a Windows junction.
// Falls back to the resolved path when it does not exist on disk, so callers
// can still pass hypothetical paths (the unit tests do).
function realpathOrResolve(path) {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * True when `metaUrl` (an `import.meta.url`) names the module Node was asked to
 * run, i.e. the module is the CLI entrypoint rather than an imported library.
 *
 * Use this instead of hand-rolling the comparison. The obvious-looking
 * `import.meta.url === \`file://${process.argv[1]}\`` is WRONG and fails open —
 * the guard evaluates false and the CLI silently does nothing, exiting 0:
 *
 *   - On Windows, `process.argv[1]` is `D:\a\repo\scripts\x.mjs` while
 *     `import.meta.url` is `file:///D:/a/repo/scripts/x.mjs`.
 *   - On any platform, a checkout path needing percent-encoding (a space, `#`,
 *     `?`, non-ASCII) encodes in `import.meta.url` but not in the raw path.
 *   - On any platform, an invocation through a symlink: Node realpaths the main
 *     module but not `process.argv[1]`.
 *
 * A check script that silently no-ops is worse than one that is missing, so the
 * comparison is normalized in one place. See
 * docs/third-party-license-notices.md § "How the check can fail open".
 */
export function isCliEntrypoint(metaUrl, argvPath = process.argv[1]) {
  if (argvPath === undefined) return false;
  return realpathOrResolve(fileURLToPath(metaUrl)) === realpathOrResolve(argvPath);
}
