#!/usr/bin/env node
/**
 * Compile the bundled native helpers (currently just the
 * window-list helper). Idempotent — skips when the source hasn't
 * changed since the last build.
 *
 * Output: apps/desktop/build/native/<name>
 *
 * The compiled binaries are picked up by electron-builder via the
 * `extraResources` entry in electron-builder.yml and end up at
 * Contents/Resources/PwrSnap<Name> in the packaged .app. At runtime,
 * src/main/capture/window-list.ts looks them up via
 * `process.resourcesPath` (production) or by walking up from
 * `__dirname` (dev — `out/main/...` → `apps/desktop/build/native/...`).
 *
 * macOS — compiles the Swift CLI helpers + Quick Look .appex bundles
 * (window-list, recorder, thumbnail/preview extensions) below.
 *
 * Windows — compiles the C++ window-list helper
 * (native/window-list-win/main.cpp → build/native/window-list.exe) via
 * the win32 branch immediately below, then exits. The .exe is the
 * counterpart to the Swift window-list binary: it drives snap-to-window
 * in the region selector and source-app metadata at capture time. The
 * macOS-only Swift/.appex targets are skipped on Windows.
 *
 * Linux — no native helpers; the build is a no-op so unit tests + Linux
 * CI keep working.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopRoot = resolve(__dirname, "..");
const nativeRoot = join(desktopRoot, "native");
const buildRoot = join(desktopRoot, "build", "native");

if (process.platform === "win32") {
  buildWindowsHelpers();
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.log("[build-native] non-darwin/non-win32 platform — skipping");
  process.exit(0);
}

mkdirSync(buildRoot, { recursive: true });

const targets = [
  {
    name: "window-list",
    sources: [join(nativeRoot, "window-list", "main.swift")],
    output: join(buildRoot, "window-list")
  },
  {
    // Fast Video Capture (issue #64). ScreenCaptureKit-based fixed-
    // rect recorder; spoken to over stdin/stdout JSON-RPC by
    // main/recording/recording-service.ts. ABI-stable forever — no
    // node-gyp / Electron-rebuild dance per Electron major bump.
    name: "recorder",
    sources: [join(nativeRoot, "recorder", "main.swift")],
    output: join(buildRoot, "recorder")
  },
  {
    // Writes a named image pasteboard item in one native operation:
    // PNG/TIFF bytes plus public.file-url for the friendly alias. Electron's
    // clipboard.write* calls clear the pasteboard per call, so this cannot
    // be composed safely from main-process JavaScript.
    name: "pasteboard-writer",
    sources: [join(nativeRoot, "pasteboard-writer", "main.swift")],
    output: join(buildRoot, "pasteboard-writer")
  },
  {
    // Diagnostic + test harness for the Quick Look Thumbnail
    // Extension. Reuses the same ZIP-reader + entry-extraction logic
    // (main.swift) the .appex uses at runtime, wired to a stdout /
    // file-output CLI in cli-main.swift. Lets us validate the
    // thumbnail pipeline against real `.pwrsnap` bundles without
    // needing Finder/lsregister gymnastics.
    name: "pwrsnap-thumbnail-cli",
    sources: [
      join(nativeRoot, "thumbnail-extension", "zip-reader.swift"),
      join(nativeRoot, "thumbnail-extension", "cli.swift")
    ],
    output: join(buildRoot, "pwrsnap-thumbnail-cli")
  }
];

/**
 * App-extension (`.appex`) targets. Despite the directory layout
 * resembling a loadable bundle, **App Extensions are MH_EXECUTE
 * binaries** — not MH_BUNDLE — with `_NSExtensionMain` (Foundation)
 * as their entry point. `pluginkit` and `extensionkitd` silently
 * reject MH_BUNDLE binaries when scanning Contents/PlugIns/, and
 * `codesign --entitlements` is also a no-op on MH_BUNDLE, so getting
 * the binary type wrong cascades into "extension never registers,
 * no log entry anywhere" (the failure mode that cost us a session
 * the first time we shipped this).
 *
 * Bundle layout:
 *   PwrSnapThumbnailExtension.appex/
 *     Contents/
 *       Info.plist
 *       MacOS/
 *         PwrSnapThumbnailExtension   # MH_EXECUTE Mach-O
 *
 * Compiler flags differ from the CLI targets above:
 *   • `-Xlinker -e -Xlinker _NSExtensionMain` — set the entry point
 *     to the symbol Foundation exports for App Extensions. It reads
 *     `NSExtension.NSExtensionPrincipalClass` from Info.plist, sets
 *     up the XPC connection with the host (Finder / QuickLookUI),
 *     and instantiates our `@objc(ThumbnailProvider)` class.
 *   • `-parse-as-library` — there's no `main.swift` / top-level code
 *     in our sources; tell swiftc to compile the files as a library
 *     module. The `-e _NSExtensionMain` linker flag wires up the
 *     entry point in place of Swift's usual `_main`.
 *   • `-framework QuickLookThumbnailing` — explicit; the principal
 *     class subclasses `QLThumbnailProvider`.
 *
 * The .appex is intentionally not signed here — electron-builder's
 * afterPack hook (apps/desktop/scripts/afterpack-sign-appex.mjs)
 * signs it with the Developer ID identity + the sandbox-enabling
 * entitlements file before the parent app's signing pass runs.
 */
const appexTargets = [
  {
    name: "PwrSnapThumbnailExtension",
    sources: [join(nativeRoot, "thumbnail-extension", "zip-reader.swift")],
    infoPlist: join(nativeRoot, "thumbnail-extension", "Info.plist"),
    output: join(buildRoot, "PwrSnapThumbnailExtension.appex"),
    frameworks: ["QuickLookThumbnailing", "AppKit", "Foundation"]
  },
  // PwrSnapPreviewExtension — separate .appex for Quick Look's
  // full-screen / Spacebar preview surface. Shares zip-reader.swift
  // with the Thumbnail Extension (identical ZIP central-directory
  // walk + same Data-extraction surface area) — building both
  // targets compiles zip-reader.swift twice, once into each .appex.
  // Acceptable: zip-reader.swift is ~280 LOC, compile is sub-second.
  // The alternative (a shared framework) would mean signing a third
  // bundle and dealing with library-validation rules from inside a
  // sandbox.
  {
    name: "PwrSnapPreviewExtension",
    sources: [
      join(nativeRoot, "thumbnail-extension", "zip-reader.swift"),
      join(nativeRoot, "preview-extension", "preview-provider.swift")
    ],
    infoPlist: join(nativeRoot, "preview-extension", "Info.plist"),
    output: join(buildRoot, "PwrSnapPreviewExtension.appex"),
    // QuickLookUI hosts QLPreviewProvider / QLPreviewingController
    // (the Preview API), distinct from QuickLookThumbnailing which
    // hosts QLThumbnailProvider. UniformTypeIdentifiers is needed
    // for the `.png` / `.jpeg` UTType references in the reply.
    frameworks: ["QuickLookUI", "AppKit", "Foundation", "UniformTypeIdentifiers"]
  }
];

function hasUniversalSlices(path) {
  const result = spawnSync(
    "lipo",
    [path, "-verify_arch", "arm64", "x86_64"],
    { stdio: "ignore" }
  );
  return result.status === 0;
}

for (const target of targets) {
  const newestSourceMtime = Math.max(
    ...target.sources.map((p) => statSync(p).mtimeMs)
  );
  const outputExists = existsSync(target.output);
  const requiresUniversal = process.env.PWRSNAP_NATIVE_UNIVERSAL === "1";
  const upToDate =
    outputExists
    && statSync(target.output).mtimeMs >= newestSourceMtime
    && (!requiresUniversal || hasUniversalSlices(target.output));

  if (upToDate) {
    console.log(`[build-native] ${target.name} up to date`);
    continue;
  }

  console.log(`[build-native] compiling ${target.name}…`);
  // Release-mode universal builds compile twice (one per arch) and
  // lipo together so end-user installs work on both Apple Silicon and
  // Intel. Dev/postinstall stays single-arch — universal doubles the
  // compile time and devs only run the binary on their own host.
  if (process.env.PWRSNAP_NATIVE_UNIVERSAL === "1") {
    const slicePaths = [];
    for (const arch of ["arm64", "x86_64"]) {
      const slice = `${target.output}.${arch}`;
      const compile = spawnSync(
        "swiftc",
        [
          "-O",
          "-target",
          `${arch}-apple-macos14.0`,
          "-o",
          slice,
          ...target.sources
        ],
        { stdio: "inherit" }
      );
      if (compile.status !== 0) {
        console.error(`[build-native] ${target.name} compilation (${arch}) failed`);
        process.exit(compile.status ?? 1);
      }
      slicePaths.push(slice);
    }
    const lipo = spawnSync(
      "lipo",
      ["-create", ...slicePaths, "-output", target.output],
      { stdio: "inherit" }
    );
    for (const slice of slicePaths) {
      try { rmSync(slice, { force: true }); } catch { /* best effort */ }
    }
    if (lipo.status !== 0) {
      console.error(`[build-native] ${target.name} lipo failed`);
      process.exit(lipo.status ?? 1);
    }
  } else {
    const result = spawnSync(
      "swiftc",
      [
        "-O", // optimized; binary is small + invoked synchronously on hot paths
        "-o",
        target.output,
        ...target.sources
      ],
      { stdio: "inherit" }
    );
    if (result.status !== 0) {
      console.error(`[build-native] ${target.name} compilation failed`);
      process.exit(result.status ?? 1);
    }
  }

  // Ad-hoc sign the binary so macOS TCC (Screen Recording, etc.)
  // can attach permissions to a stable identity. Without this the
  // binary is unsigned and System Settings → Screen Recording
  // refuses to add it. Production builds are signed by the
  // electron-builder bundle signing pass; ad-hoc signing here is
  // dev-only convenience.
  //
  // `codesign -s - --force` ad-hoc signs (the `-` identity is
  // ad-hoc). --force overwrites any existing signature so a
  // re-build always reflects the current binary content.
  const signResult = spawnSync(
    "codesign",
    ["-s", "-", "--force", target.output],
    { stdio: "inherit" }
  );
  if (signResult.status !== 0) {
    console.error(`[build-native] ${target.name} ad-hoc signing failed`);
    process.exit(signResult.status ?? 1);
  }

  console.log(`[build-native] ${target.name} → ${target.output} (ad-hoc signed)`);
}

// ---------------------------------------------------------------------------
// .appex (loadable-bundle) targets
// ---------------------------------------------------------------------------

for (const appex of appexTargets) {
  const newestSourceMtime = Math.max(
    ...appex.sources.concat(appex.infoPlist).map((p) => statSync(p).mtimeMs)
  );
  const innerBinary = join(appex.output, "Contents", "MacOS", appex.name);
  const innerInfoPlist = join(appex.output, "Contents", "Info.plist");
  const outputExists = existsSync(innerBinary) && existsSync(innerInfoPlist);
  const requiresUniversal = process.env.PWRSNAP_NATIVE_UNIVERSAL === "1";
  const upToDate =
    outputExists
    && statSync(innerBinary).mtimeMs >= newestSourceMtime
    && (!requiresUniversal || hasUniversalSlices(innerBinary));

  if (upToDate) {
    console.log(`[build-native] ${appex.name}.appex up to date`);
    continue;
  }

  console.log(`[build-native] compiling ${appex.name}.appex…`);

  // Wipe + rebuild the .appex directory tree from scratch. Stale
  // sibling files inside Contents/ (e.g., a re-named target binary
  // leaving an orphan) would otherwise confuse codesign.
  if (existsSync(appex.output)) {
    rmSync(appex.output, { recursive: true, force: true });
  }
  mkdirSync(join(appex.output, "Contents", "MacOS"), { recursive: true });

  // Drop Info.plist before the binary so a partial build is at least
  // self-describing (even if the binary is missing, `lsregister` can
  // still inspect the manifest).
  copyFileSync(appex.infoPlist, innerInfoPlist);

  // Frameworks must be linked explicitly — QuickLookThumbnailing has
  // no auto-link path, and we need Foundation explicitly (rather than
  // letting swiftc pick it up implicitly) because we're requesting
  // its `_NSExtensionMain` symbol as the linker entry point.
  const frameworkArgs = appex.frameworks.flatMap((fw) => ["-framework", fw]);

  // `-Xlinker -e -Xlinker _NSExtensionMain`: override the default
  // entry point (`_main`) with Foundation's NSExtensionMain. This is
  // what makes the output an App Extension instead of just an
  // executable that exits immediately. NSExtensionMain reads
  // NSExtension.NSExtensionPrincipalClass from Info.plist, sets up
  // the XPC connection with the extension host, and instantiates the
  // principal class. The two `-Xlinker` invocations are how swiftc
  // passes split flag pairs through to `ld`.
  //
  // `-parse-as-library`: there's no `main.swift` / top-level Swift
  // entry — our sources only define types. Tell swiftc to compile
  // them as a library module; the linker-level entry point above
  // takes over the `_main`-symbol role.
  //
  // `-module-name <name>`: stable Swift module name so @objc-exposed
  // class names ("ThumbnailProvider") match the Info.plist entry.
  //
  // NOT used here (and would be a bug): `-emit-library` /
  // `-Xlinker -bundle`. Those produce MH_BUNDLE. App Extensions on
  // macOS must be MH_EXECUTE — both `codesign --entitlements` and
  // `pluginkit` silently reject MH_BUNDLE binaries, leading to a
  // very confusing "extension never registers, no log entry"
  // failure mode.
  const baseFlags = [
    "-O",
    "-module-name", appex.name,
    "-parse-as-library",
    "-Xlinker", "-e",
    "-Xlinker", "_NSExtensionMain",
    ...frameworkArgs
  ];

  if (process.env.PWRSNAP_NATIVE_UNIVERSAL === "1") {
    const slicePaths = [];
    for (const arch of ["arm64", "x86_64"]) {
      const slice = `${innerBinary}.${arch}`;
      const compile = spawnSync(
        "swiftc",
        [
          ...baseFlags,
          "-target",
          `${arch}-apple-macos14.0`,
          "-o",
          slice,
          ...appex.sources
        ],
        { stdio: "inherit" }
      );
      if (compile.status !== 0) {
        console.error(`[build-native] ${appex.name}.appex compilation (${arch}) failed`);
        process.exit(compile.status ?? 1);
      }
      slicePaths.push(slice);
    }
    const lipo = spawnSync(
      "lipo",
      ["-create", ...slicePaths, "-output", innerBinary],
      { stdio: "inherit" }
    );
    for (const slice of slicePaths) {
      try { rmSync(slice, { force: true }); } catch { /* best effort */ }
    }
    if (lipo.status !== 0) {
      console.error(`[build-native] ${appex.name}.appex lipo failed`);
      process.exit(lipo.status ?? 1);
    }
  } else {
    const result = spawnSync(
      "swiftc",
      [
        ...baseFlags,
        "-o",
        innerBinary,
        ...appex.sources
      ],
      { stdio: "inherit" }
    );
    if (result.status !== 0) {
      console.error(`[build-native] ${appex.name}.appex compilation failed`);
      process.exit(result.status ?? 1);
    }
  }

  // INTENTIONALLY NOT SIGNED HERE. The standalone CLI binaries above
  // get ad-hoc signed because they're used in-place during dev (run
  // by hand from the Terminal). The .appex is different — it's an
  // embedded Quick Look extension that only runs when the parent
  // .app is installed by macOS, and electron-builder's mac signing
  // pass at package time re-signs the parent app's whole bundle
  // tree (including this .appex) with the Developer ID.
  //
  // Pre-signing with ad-hoc here creates a problem during
  // `pnpm package`: @electron/universal merges the arm64 and x64
  // builds, electron-builder then signs the parent .app with
  // `--deep`, but the re-sign doesn't fully overwrite our pre-
  // existing ad-hoc CodeResources inside Contents/PlugIns/
  // PwrSnapThumbnailExtension.appex/Contents/_CodeSignature/. The
  // final `codesign --verify --deep --strict` step trips on the
  // mismatched hashes:
  //
  //   PwrSnap.app: invalid Info.plist (plist or signature have been modified)
  //   In subcomponent: .../PlugIns/PwrSnapThumbnailExtension.appex
  //
  // Skipping the pre-sign here makes electron-builder the sole
  // signer for the .appex, eliminating the conflict. For dev
  // testing of the Thumbnail Extension you need a packaged build
  // (the .appex isn't picked up by Launch Services until the
  // parent app is in /Applications anyway) — the standalone CLI
  // above (pwrsnap-thumbnail-cli) covers the dev-loop need for
  // ZIP-extraction validation.

  console.log(`[build-native] ${appex.name}.appex → ${appex.output} (unsigned; electron-builder signs at package time)`);
}

// ---------------------------------------------------------------------------
// Windows native helpers (C++ compiled with the VS Build Tools' cl.exe)
// ---------------------------------------------------------------------------

/**
 * Compile the Windows window-list helper:
 *   native/window-list-win/main.cpp → build/native/window-list.exe
 *
 * Counterpart to the macOS Swift `window-list` binary. Self-contained
 * C++ over Win32 (EnumWindows / DWM / PSAPI); compiled with cl.exe from
 * the Visual Studio Build Tools, which are present on the GitHub
 * `windows-latest` runner and the project's Windows dev box.
 *
 * Idempotent: skips the compile when the .exe is newer than its source.
 *
 * cl.exe needs the VS toolchain environment (INCLUDE / LIB / PATH). We
 * never assume the caller has run `vcvarsall.bat`/`VsDevCmd.bat` first —
 * instead we locate the VS install via `vswhere`, then invoke cl.exe
 * through a one-shot cmd that sources `VsDevCmd.bat` for the host arch.
 * If cl.exe is already on PATH (the developer ran from a Developer
 * Command Prompt) we use it directly and skip the bat dance.
 */
function buildWindowsHelpers() {
  mkdirSync(buildRoot, { recursive: true });

  const source = join(nativeRoot, "window-list-win", "main.cpp");
  const output = join(buildRoot, "window-list.exe");

  if (!existsSync(source)) {
    console.error(`[build-native] missing Windows source: ${source}`);
    process.exit(1);
  }

  // Up-to-date check — same mtime semantics as the macOS targets.
  if (
    existsSync(output) &&
    statSync(output).mtimeMs >= statSync(source).mtimeMs
  ) {
    console.log("[build-native] window-list.exe up to date");
    return;
  }

  // Object files land next to the .exe; cl.exe drops `main.obj` in the
  // cwd otherwise. Build dir is fine for transient artifacts.
  const objFile = join(buildRoot, "window-list.obj");

  console.log("[build-native] compiling window-list.exe…");

  // cl flags:
  //   /O2     optimize for speed (tiny binary, hot path)
  //   /EHsc   standard C++ exception handling
  //   /std:c++17  matches the source
  //   /nologo quiet banner
  //   /Fe:    output exe path
  //   /Fo:    output obj path (keeps cwd clean)
  // Libraries: user32 (EnumWindows / window APIs), dwmapi (cloak +
  // extended-frame bounds). Listed after the source per cl convention.
  const clArgs = [
    "/O2",
    "/EHsc",
    "/std:c++17",
    "/nologo",
    `/Fe:${output}`,
    `/Fo:${objFile}`,
    source,
    "user32.lib",
    "dwmapi.lib"
  ];

  // Quote each cl arg so paths with spaces survive cmd parsing.
  const quotedClArgs = clArgs.map((a) => `"${a}"`).join(" ");

  let result;
  let tempBat = null;
  if (commandOnPath("cl.exe")) {
    // Developer Command Prompt already has the toolchain env loaded.
    result = spawnSync("cl.exe", clArgs, { stdio: "inherit" });
  } else {
    // Locate VsDevCmd.bat via vswhere, then compile through a small
    // generated batch file that sources it for the host architecture.
    //
    // Why a batch file rather than `cmd /c "call ... && cl ..."`:
    // VsDevCmd.bat's path contains spaces (Program Files (x86)\…), and
    // chaining a quoted `call "<bat>"` with `&& cl.exe "<args>"` through
    // `cmd /c` runs into cmd.exe's quote-stripping rules (it removes the
    // first and last quote of the whole command line), which mangles the
    // bat path — observed as `'"…\VsDevCmd.bat"' is not recognized`. A
    // standalone .bat sidesteps the rule entirely: each line is parsed
    // independently with normal quoting.
    const vsDevCmd = findVsDevCmd();
    if (vsDevCmd === null) {
      console.error(
        "[build-native] cl.exe not found and VS Build Tools could not be located " +
          "via vswhere. Install the Visual Studio Build Tools (C++ workload), " +
          "or run from a Developer Command Prompt."
      );
      process.exit(1);
    }
    const hostArch = process.arch === "arm64" ? "arm64" : "amd64";
    tempBat = join(buildRoot, "build-window-list.bat");
    // `@echo off` keeps the VsDevCmd banner quiet; `exit /b` propagates
    // cl's exit code as the batch (and therefore the process) status.
    const batContents = [
      "@echo off",
      `call "${vsDevCmd}" -arch=${hostArch} -host_arch=${hostArch}`,
      `cl.exe ${quotedClArgs}`,
      "exit /b %ERRORLEVEL%",
      ""
    ].join("\r\n");
    writeFileSync(tempBat, batContents);
    result = spawnSync("cmd.exe", ["/d", "/c", tempBat], { stdio: "inherit" });
  }

  if (result.status !== 0) {
    console.error("[build-native] window-list.exe compilation failed");
    process.exit(result.status ?? 1);
  }

  // Best-effort cleanup of the transient object + batch files.
  for (const transient of [objFile, tempBat]) {
    if (transient === null) continue;
    try {
      rmSync(transient, { force: true });
    } catch {
      /* best effort */
    }
  }

  console.log(`[build-native] window-list.exe → ${output}`);
}

/** True when `name` resolves on the current PATH (Windows: tries
 *  `where`). */
function commandOnPath(name) {
  const probe = spawnSync("where", [name], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * Locate `VsDevCmd.bat` for the newest installed Visual Studio / Build
 * Tools instance using the bundled `vswhere` (shipped under Program
 * Files (x86)\\Microsoft Visual Studio\\Installer on every modern VS /
 * Build Tools install, including the windows-latest runner). Returns the
 * absolute path to VsDevCmd.bat, or null when no instance is found.
 */
function findVsDevCmd() {
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const vswhere = join(
    programFilesX86,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (!existsSync(vswhere)) {
    return null;
  }
  // -latest newest instance; -products * includes the standalone Build
  // Tools SKU (not just full VS); require the C++ toolset component so
  // we don't pick an instance without cl.exe; -property installationPath
  // returns the install root.
  const result = spawnSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath"
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    return null;
  }
  const installPath = (result.stdout || "").trim().split(/\r?\n/)[0];
  if (!installPath) {
    return null;
  }
  const vsDevCmd = join(
    installPath,
    "Common7",
    "Tools",
    "VsDevCmd.bat"
  );
  return existsSync(vsDevCmd) ? vsDevCmd : null;
}
