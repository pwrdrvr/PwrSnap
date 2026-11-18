# Agent rules: Native modules: better-sqlite3 and sharp

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## better-sqlite3 loads its own N-API prebuild — nothing is rebuilt for Electron

**better-sqlite3 13 is N-API and ships a prebuild for every platform it
supports inside the one npm package, as `prebuilds/<platform>-<arch>.node`.
Its loader picks the file for `process.platform` / `process.arch` at runtime,
so unit tests under system Node and the app under Electron load the same
binary. Do not reintroduce a `nativeBinding` override, an Electron-only
rebuild, or a second binding beside the first.** Pinned by
[better-sqlite3-prebuilds.test.mjs](../../apps/desktop/scripts/better-sqlite3-prebuilds.test.mjs).

Until 13, better-sqlite3 was written against V8's own API: one prebuild per
Electron ABI, and none for Electron 44 (ABI 149). Every install and every
packaging stage compiled an Electron copy into an `electron-native/` sidecar
beside the system-Node one, `native-binding.ts` chose between them by a
metadata file, and the compile needed a C++ toolchain plus a GCC 12 workaround
for V8 15's headers. All of that is gone, and an old note that tells you to
"repair the native sidecar" is describing it.

Things that bite:

- **`allowBuilds: better-sqlite3: false` in `pnpm-workspace.yaml` is a
  guard.** pnpm 10 ignored the package's `gypfile: false` and ran an
  implicit `node-gyp rebuild` because a `binding.gyp` is present. With a
  prebuild for the host, every target in that file is `type: none`, so the
  run compiled nothing, yet it still needed Python and make (Visual Studio
  on Windows) just to configure. pnpm 12.9.1 honors `gypfile: false`:
  measured, it builds nothing even with the entry set to `true`. `false`
  keeps a future pnpm from bringing the build back. The cost: a host with no
  prebuild fails to load at runtime instead of compiling. Every target
  PwrSnap ships or tests on has one, and the test above checks the installed
  package for each.
- **`npmRebuild: false` in `electron-builder.yml` is on purpose too.** With
  it on, electron-builder runs `@electron/rebuild` over better-sqlite3 once
  per arch. On 44.4.5 that compiled nothing, but its fallback is a node-gyp
  source build. PwrGit sets the same.
- **Packaging keeps only the target's prebuilds.** `release.mjs` and
  `package-win.mjs` call `pruneBetterSqlite3Prebuilds` on the stage, the same
  way sharp's foreign `@img` packages are pruned. The universal Mac keeps
  `darwin-arm64.node` + `darwin-x64.node`, the arm64-only Mac keeps
  `darwin-arm64.node`, and Windows keeps `win32-x64.node`. The other six are
  ~2 MB each. `verify-asar-contents.mjs` fails on a missing target prebuild
  and on a foreign one.
- **The darwin pair are thin Mach-Os, identical in both per-arch app trees,
  so they are in `mac.x64ArchFiles`.** `@electron/universal` aborts the merge
  on an identical thin Mach-O that glob does not cover. The old sidecar never
  hit this because it was already fat, and the merge skips fat files.
  `verifyPackagedArchitecture` expects each one thin, at its own arch.
- **The Linux prebuild needs glibc 2.34 and `GLIBCXX_3.4.29`**: Ubuntu 22.04
  or later, or Debian bookworm, which is the Docker E2E image. A musl host
  gets the `linuxmusl-*` file.

## sharp in Electron on Linux runs its WebAssembly build

**In Electron on Linux, sharp must load `@img/sharp-wasm32`, never the
native `@img/sharp-linux-*` addon. Every entry that can load sharp imports
[sharp-wasm-steer.ts](../../apps/desktop/src/main/sharp-wasm-steer.ts) before
anything else that could pull sharp in.** Pinned by
[sharp-wasm-steer.test.ts](../../apps/desktop/src/main/__tests__/sharp-wasm-steer.test.ts)
(the policy and the import order) and
[pnpmfile.test.mjs](../../scripts/__tests__/pnpmfile.test.mjs) (the install
wiring and the lockfile).

Electron's Linux binary links the system glib, and sharp's addon imports
`g_object_ref` / `g_object_unref` meaning the copy statically linked into
libvips. The global scope wins, so they bind to a GType registry that has
never seen libvips' objects: every call logs
`GLib-GObject: g_object_ref: assertion 'G_IS_OBJECT (object)' failed` and
does nothing, libvips frees images sharp still holds, and main dies with
**SIGTRAP** a few hundred ms into its first sharp work. Upstream is
[electron/electron#46323](https://github.com/electron/electron/issues/46323)
(open). It surfaced as `editor-crop-clip.spec.ts` failing about 40% of runs,
blamed on a lost `editor:open` intent. The intent was never lost: the
process was already dead.

Four things that bite:

- **Those GLib lines are not noise.** They were in every Linux E2E log,
  healthy launches included, which is how they came to be ignored. Read
  them as "sharp is running native inside Electron", which is now a bug.
- **The steer must be its own chunk.** `out/main/*.js` is ESM, so every
  static import, `sharp` included, is evaluated before any module body. A
  steer inlined into an entry chunk runs after sharp has already loaded
  native. It is a separate rollup input, and each entry imports it first.
  Worker threads have their own module loader, so the worker entries each
  import it too.
- **The install needs the `.pnpmfile.cjs` hook.** sharp does not depend on
  `@img/sharp-wasm32` (its docs say to install it alongside), and pnpm's
  isolated layout hides a sibling from sharp's loader. The hook adds it to
  sharp's optional dependencies at sharp's own version. It declares `cpu: any`
  explicitly: pnpm 12 otherwise infers `wasm32` from the name and skips it on
  native Linux CPUs. It gates the package to `os: linux` so macOS and Windows
  release staging never ship it (the license notice does not disclose it).
  It also drops the edge from sharp's
  FreeBSD and WebContainers wrappers: pnpm 10.33 otherwise reaches the
  package through them first, skips it along with them, and never
  reconsiders.
- **Every shipped target refuses it at release time, too.** pnpm never
  removes an installed package that the lockfile now skips, so a stale tree
  can still hold it. `verify-asar-contents` fails any Sharp native package the
  target does not use, in the asar and in `app.asar.unpacked`, on universal
  mac as well. Before packaging, `pruneStagedSharp` narrows each mac stage's
  sharp manifest to the target's slices, because electron-builder follows
  that manifest. Without it, the universal app shipped both win32 slices
  through v1.1.15. A slice that no shipped target uses fails the release
  instead of being pruned.
- **What does not work.** `RTLD_DEEPBIND` on the addon fixes the glib
  binding but rebinds `free` / `operator new` / `operator delete` away from
  Chromium's allocator shim, and crashes with SIGSEGV. A `utilityProcess`
  or `ELECTRON_RUN_AS_NODE` child is still the electron executable, with
  the same system glib.

The wasm build is slower. It also rasterizes SVG with resvg instead of
librsvg, and renders SVG `<text>` blank. Text annotations are unaffected:
they bake through Chromium (`text-html-bake.ts`). On Linux, the cart drag
icon's labels draw no glyphs. Linux is not a distribution target, so this
covers the Linux E2E job and Linux dev runs. Plain Node on Linux (vitest,
scripts, the Playwright runner) keeps the native addon, because it has no
second glib.

The boot log says which build loaded:
`sharp: using the WebAssembly build (Electron on Linux)`, or a warn line
when the wasm package is missing and main is back on the crashing native
addon. Investigation, probes and measurements:
[docs/solutions/2026-10-01-sharp-electron-linux-glib-sigtrap.md](../../docs/solutions/2026-10-01-sharp-electron-linux-glib-sigtrap.md).
