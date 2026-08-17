import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

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
 *
 * A check script that silently no-ops is worse than one that is missing, so the
 * comparison is normalized in one place. See
 * docs/third-party-license-notices.md § "How the check can fail open".
 */
export function isCliEntrypoint(metaUrl, argvPath = process.argv[1]) {
  if (argvPath === undefined) return false;
  return fileURLToPath(metaUrl) === resolve(argvPath);
}
