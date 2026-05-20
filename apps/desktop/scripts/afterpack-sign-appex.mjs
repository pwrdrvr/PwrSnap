#!/usr/bin/env node
/**
 * electron-builder `afterPack` hook. Signs every `.appex` Quick Look
 * extension shipped under `Contents/PlugIns/` before the main app's
 * codesign pass runs.
 *
 * Why this exists
 * ---------------
 * electron-builder (v26.x) / @electron/osx-sign doesn't auto-discover
 * `.appex` bundles when walking the staged .app for things to sign.
 * It signs the parent `Contents/MacOS/<App>` first, which causes
 * codesign to traverse the resource manifest and find nested
 * subcomponents — and if any of those (our `.appex`) is unsigned, the
 * parent signing aborts:
 *
 *     code object is not signed at all
 *     In subcomponent: .../PlugIns/PwrSnapThumbnailExtension.appex
 *
 * This hook runs AFTER electron-builder finishes packing the staged
 * app (so the .appex is in place) and BEFORE the parent signing pass
 * starts. It signs each `.appex` with the same Developer ID identity
 * the parent will use (discovered via CSC_NAME or
 * `security find-identity`), applying minimal extension-specific
 * entitlements (App Sandbox + files.user-selected.read-only — no
 * V8 / libvips exemptions, those belong to the parent's Hardened
 * Runtime profile, not a sandboxed Quick Look provider). The parent
 * app's signing pass does NOT replace this signature — the .appex
 * keeps the signature we apply here, sealed into the parent's
 * CodeResources manifest by cdhash.
 *
 * For unsigned dev builds (no CSC_* env var, no Developer ID
 * identity in the keychain), the hook ad-hoc signs with `-` so the
 * .appex is still a valid bundle on disk. Ad-hoc signing is
 * acceptable ONLY in dev — in a release context we error out
 * rather than ship an ad-hoc-signed extension that won't pass
 * notarization. See `assertReleaseContextHasIdentity` below.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopRoot = resolve(__dirname, "..");
const entitlementsPath = join(
  desktopRoot,
  "build",
  "entitlements.thumbnail-extension.plist"
);

/**
 * Locate a Developer ID Application identity for code signing.
 * Mirrors electron-builder's own discovery heuristic:
 *   1. `CSC_NAME` env var (set by CI, or by the user via release.mjs)
 *   2. First "Developer ID Application: ..." identity from the user
 *      keychain via `security find-identity -v -p codesigning`
 *   3. None — fall through to ad-hoc signing (`-`)
 */
function discoverSigningIdentity() {
  if (process.env.CSC_NAME) return process.env.CSC_NAME;

  try {
    const out = execSync("security find-identity -v -p codesigning", {
      encoding: "utf-8"
    });
    // Output looks like:
    //   1) ABCDEF... "Developer ID Application: PwrDrvr LLC (T44CNHC4UH)"
    //   2) ABCDEF... "Apple Development: Joe <joe@example.com> (XYZ)"
    //      ...
    //   2 valid identities found
    const match = out.match(/"(Developer ID Application: [^"]+)"/);
    if (match !== null && match[1] !== undefined) return match[1];
  } catch {
    // `security` not on PATH or no keychain access — fall through.
  }
  return null;
}

/**
 * Sign one `.appex` bundle. Returns true on success, throws on
 * codesign failure (electron-builder catches it and aborts the
 * build with the codesign stderr).
 */
function signAppex(appexPath, identity) {
  const isAdHoc = identity === null;
  const args = [
    "--sign", isAdHoc ? "-" : identity,
    "--force",
    "--options", "runtime",
    "--entitlements", entitlementsPath
  ];
  // `--timestamp` requires a real identity (the Apple timestamp
  // server rejects ad-hoc signatures). For dev builds we drop it;
  // electron-builder's parent signing pass re-signs with timestamp
  // at release time anyway.
  if (!isAdHoc) args.push("--timestamp");
  args.push(appexPath);

  console.log(
    `[afterpack-sign-appex] signing ${appexPath} with ${isAdHoc ? "ad-hoc" : `"${identity}"`}`
  );
  const result = spawnSync("codesign", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `[afterpack-sign-appex] codesign failed for ${appexPath} (exit ${result.status})`
    );
  }
}

/**
 * Decide whether this is a "release context" — i.e., the build is
 * supposed to produce a notarizable artifact, and ad-hoc signing
 * would be a bug. Signals:
 *
 *   - `CSC_LINK` is set (electron-builder uses this for a code-sign
 *     cert path, almost always set in CI)
 *   - The packager's mac config has `notarize` truthy (we set
 *     `notarize: true` in electron-builder.yml; CI or release.mjs
 *     could override it false for an unnotarized dev DMG)
 *   - `npm_lifecycle_event` is `release` or similar (catches
 *     `pnpm release`-style invocations)
 *
 * Any one of those being on flips us to "must sign for real."
 */
function isReleaseContext(context) {
  if (process.env.CSC_LINK) return true;
  if (process.env.npm_lifecycle_event === "release") return true;
  const macConfig = context.packager?.config?.mac;
  if (macConfig?.notarize) return true;
  return false;
}

/**
 * Bail loudly if we'd ad-hoc sign a release artifact. Catches the
 * "CI forgot to load the keychain" failure mode where everything
 * looks green until you try to notarize the DMG and Apple rejects
 * it for the nested ad-hoc signature inside the parent app.
 */
function assertReleaseContextHasIdentity(context, identity) {
  if (identity !== null) return;
  if (!isReleaseContext(context)) return;
  throw new Error(
    "[afterpack-sign-appex] release context detected " +
    "(CSC_LINK / npm_lifecycle_event=release / mac.notarize=true) " +
    "but no Developer ID Application identity was discovered " +
    "(CSC_NAME unset, `security find-identity -v -p codesigning` " +
    "found no Developer ID Application certificate). Refusing to " +
    "ad-hoc sign — the resulting .appex would fail notarization. " +
    "Load the signing keychain (CI: unlock-keychain step) or set " +
    "CSC_NAME explicitly, then re-run the build."
  );
}

/**
 * Default export — electron-builder's `afterPack` hook entry point.
 */
export default async function afterPackSignAppex(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = join(context.appOutDir, `${appName}.app`);
  const pluginsDir = join(appPath, "Contents", "PlugIns");
  if (!existsSync(pluginsDir)) {
    // No nested extensions in this configuration — nothing to do.
    return;
  }

  const appexBundles = readdirSync(pluginsDir).filter((n) => n.endsWith(".appex"));
  if (appexBundles.length === 0) return;

  const identity = discoverSigningIdentity();
  assertReleaseContextHasIdentity(context, identity);

  for (const name of appexBundles) {
    signAppex(join(pluginsDir, name), identity);
  }
}
