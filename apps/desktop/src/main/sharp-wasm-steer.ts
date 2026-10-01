// Side-effect bootstrap: in Electron on Linux, make sharp load its
// WebAssembly build instead of its native addon.
//
// It must be evaluated before ANY module that imports `sharp` — every
// entry that can load sharp (index.ts and both worker entries) imports it
// first, and it is its own rollup input so the import survives as a
// separate chunk that ESM evaluates ahead of the `sharp` import. A module
// inlined into the entry chunk would run AFTER the hoisted `import sharp`.
//
// Why: Electron's Linux binary links the SYSTEM glib (libgobject-2.0 is
// in its DT_NEEDED). sharp's prebuilt `@img/sharp-linux-*` addon imports
// g_object_ref / g_object_unref / g_signal_connect_data / g_malloc /
// g_free / g_log_set_handler / g_utf8_validate, which it means to resolve
// against the glib statically linked into libvips-cpp.so. In Electron the
// global scope wins, so they bind to the system glib, whose GType
// registry has never seen libvips' objects: every ref/unref logs
// "GLib-GObject: g_object_ref: assertion 'G_IS_OBJECT (object)' failed"
// and does nothing. sharp's C++ wrappers then hold no references, libvips
// frees images they still use, and the main process dies with SIGTRAP a
// few hundred ms into its first sharp work. Upstream:
// electron/electron#46323 (open), sharp's install docs §"Electron and
// Linux". Measured in the Linux E2E harness: a bare Electron + sharp
// probe crashed 3/3; `editor-crop-clip.spec.ts` passed 12/20.
//
// What does NOT work, so nobody tries it again:
//   • RTLD_DEEPBIND on the addon fixes the glib binding and breaks the
//     allocator: the addon's free / operator new / operator delete then
//     bind to glibc instead of Chromium's allocator shim, which the
//     electron executable also exports. Measured: SIGSEGV 3/3.
//   • A utilityProcess or ELECTRON_RUN_AS_NODE child is still the
//     electron executable, so it loads the same system glib.
//
// The wasm build carries its own glib inside the wasm module, so there is
// nothing to clash with. It is slower, and it renders SVG <text> blank
// (no native text rendering). Text annotations are unaffected — the bake
// rasterizes them through Chromium (text-html-bake.ts) — but sharp-only
// SVG text (the cart drag icon's labels) draws no glyphs on Linux.
//
// Linux is not a distribution target: this changes the Linux E2E job and
// Linux dev runs. macOS and Windows never take this path, and plain Node
// on Linux (vitest, scripts) keeps the native addon because it has no
// second glib. `@img/sharp-wasm32` is installed on Linux hosts only — see
// the readPackage hook in the root .pnpmfile.cjs.

import { createRequire, registerHooks } from "node:module";

/** sharp's loader requires exactly this shape for the native binding. */
const NATIVE_LINUX_BINDING = /^@img\/sharp-linux(?:musl)?-[^/]+\/sharp\.node$/;

export type SharpWasmSteerDecision =
  | { readonly kind: "not-applicable" }
  | { readonly kind: "steered"; readonly wasmBinding: string }
  | { readonly kind: "wasm-unavailable"; readonly reason: string };

export function sharpNeedsWasm(
  platform: NodeJS.Platform,
  versions: NodeJS.ProcessVersions
): boolean {
  return platform === "linux" && typeof versions.electron === "string";
}

/** Is the native binding request one we refuse? Exported for the test. */
export function isNativeLinuxSharpBinding(specifier: string): boolean {
  return NATIVE_LINUX_BINDING.test(specifier);
}

function resolveWasmBinding(): string {
  // Resolve from sharp's own location: under pnpm the wasm package is
  // linked into sharp's node_modules as its optional dependency, not into
  // ours.
  const sharpEntry = createRequire(import.meta.url).resolve("sharp");
  return createRequire(sharpEntry).resolve("@img/sharp-wasm32/sharp.node");
}

export type SharpWasmSteerDeps = {
  readonly platform: NodeJS.Platform;
  readonly versions: NodeJS.ProcessVersions;
  readonly resolveWasmBinding: () => string;
  readonly register: typeof registerHooks;
};

export function installSharpWasmSteer(
  deps: SharpWasmSteerDeps = {
    platform: process.platform,
    versions: process.versions,
    resolveWasmBinding,
    register: registerHooks
  }
): SharpWasmSteerDecision {
  if (!sharpNeedsWasm(deps.platform, deps.versions)) return { kind: "not-applicable" };

  let wasmBinding: string;
  try {
    wasmBinding = deps.resolveWasmBinding();
  } catch (error) {
    // Refusing the native binding with no wasm build behind it would make
    // `import sharp` throw and take the whole process down at startup.
    // Leaving it is the pre-fix behavior; the boot log names why.
    return {
      kind: "wasm-unavailable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  // A MODULE_NOT_FOUND is exactly what sharp's loader expects from a
  // platform package that is not installed, so it moves on to
  // `@img/sharp-wasm32` without reporting anything.
  deps.register({
    resolve(specifier, context, nextResolve) {
      if (isNativeLinuxSharpBinding(specifier)) {
        const error = new Error(
          `PwrSnap uses sharp's WebAssembly build in Electron on Linux; refused ${specifier} (see sharp-wasm-steer.ts)`
        ) as NodeJS.ErrnoException;
        error.code = "MODULE_NOT_FOUND";
        throw error;
      }
      return nextResolve(specifier, context);
    }
  });
  return { kind: "steered", wasmBinding };
}

export const sharpWasmSteerDecision: SharpWasmSteerDecision = installSharpWasmSteer();
