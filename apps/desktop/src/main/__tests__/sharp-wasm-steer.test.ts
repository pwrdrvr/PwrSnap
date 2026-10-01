// Pins sharp-wasm-steer.ts: in Electron on Linux, sharp's native addon
// shares a process with Electron's system glib and crashes main with
// SIGTRAP, so sharp must load its WebAssembly build there and nowhere else.
//
// The real hook cannot be exercised here: vitest is plain Node, where the
// steer is (correctly) a no-op. The Linux E2E job is what proves the
// wiring, via the "sharp: using the WebAssembly build" boot line.

import { readFileSync } from "node:fs";
import type { registerHooks } from "node:module";
import { describe, expect, test, vi } from "vitest";
import {
  installSharpWasmSteer,
  isNativeLinuxSharpBinding,
  sharpNeedsWasm,
  type SharpWasmSteerDeps
} from "../sharp-wasm-steer";

type ResolveHook = NonNullable<Parameters<typeof registerHooks>[0]["resolve"]>;

const ELECTRON_VERSIONS = { ...process.versions, electron: "41.10.7" } as NodeJS.ProcessVersions;
const NODE_VERSIONS = { ...process.versions, electron: undefined } as unknown as NodeJS.ProcessVersions;

function deps(overrides: Partial<SharpWasmSteerDeps>): SharpWasmSteerDeps & {
  readonly register: ReturnType<typeof vi.fn>;
} {
  const register = vi.fn();
  return {
    platform: "linux",
    versions: ELECTRON_VERSIONS,
    resolveWasmBinding: () => "/x/@img/sharp-wasm32/lib/sharp-wasm32.node.js",
    register,
    ...overrides
  } as SharpWasmSteerDeps & { readonly register: ReturnType<typeof vi.fn> };
}

describe("sharpNeedsWasm", () => {
  test("only Electron on Linux", () => {
    expect(sharpNeedsWasm("linux", ELECTRON_VERSIONS)).toBe(true);
    expect(sharpNeedsWasm("linux", NODE_VERSIONS)).toBe(false);
    expect(sharpNeedsWasm("darwin", ELECTRON_VERSIONS)).toBe(false);
    expect(sharpNeedsWasm("win32", ELECTRON_VERSIONS)).toBe(false);
  });
});

describe("isNativeLinuxSharpBinding", () => {
  test("matches the native binding sharp's loader asks for on Linux", () => {
    for (const arch of ["x64", "arm64", "arm", "ppc64", "riscv64", "s390x"]) {
      expect(isNativeLinuxSharpBinding(`@img/sharp-linux-${arch}/sharp.node`)).toBe(true);
    }
    expect(isNativeLinuxSharpBinding("@img/sharp-linuxmusl-x64/sharp.node")).toBe(true);
  });

  test("leaves the wasm build, the libvips packages and other platforms alone", () => {
    expect(isNativeLinuxSharpBinding("@img/sharp-wasm32/sharp.node")).toBe(false);
    expect(isNativeLinuxSharpBinding("@img/sharp-libvips-linux-x64/package")).toBe(false);
    expect(isNativeLinuxSharpBinding("@img/sharp-darwin-arm64/sharp.node")).toBe(false);
    expect(isNativeLinuxSharpBinding("@img/sharp-win32-x64/sharp.node")).toBe(false);
    expect(isNativeLinuxSharpBinding("sharp")).toBe(false);
  });
});

describe("installSharpWasmSteer", () => {
  test("does nothing outside Electron on Linux", () => {
    for (const d of [
      deps({ platform: "darwin" }),
      deps({ platform: "win32" }),
      deps({ versions: NODE_VERSIONS })
    ]) {
      expect(installSharpWasmSteer(d)).toEqual({ kind: "not-applicable" });
      expect(d.register).not.toHaveBeenCalled();
    }
  });

  test("keeps the native addon when the wasm build is not installed", () => {
    // Refusing native with nothing behind it would make `import sharp` throw
    // at startup; the decision carries the reason for the boot log instead.
    const d = deps({
      resolveWasmBinding: () => {
        throw new Error("Cannot find module '@img/sharp-wasm32/sharp.node'");
      }
    });
    expect(installSharpWasmSteer(d)).toEqual({
      kind: "wasm-unavailable",
      reason: "Cannot find module '@img/sharp-wasm32/sharp.node'"
    });
    expect(d.register).not.toHaveBeenCalled();
  });

  test("refuses the native binding as not-found and passes everything else through", () => {
    const d = deps({});
    expect(installSharpWasmSteer(d)).toEqual({
      kind: "steered",
      wasmBinding: "/x/@img/sharp-wasm32/lib/sharp-wasm32.node.js"
    });
    expect(d.register).toHaveBeenCalledTimes(1);
    const hook = (d.register.mock.calls[0]?.[0] as { resolve: ResolveHook }).resolve;
    const context = { conditions: [], importAttributes: {}, parentURL: undefined };
    const next = vi.fn(() => ({ url: "file:///resolved" }));

    let refused: unknown;
    try {
      hook("@img/sharp-linux-x64/sharp.node", context, next);
    } catch (error) {
      refused = error;
    }
    // MODULE_NOT_FOUND is what sharp's loader expects from an absent
    // platform package, so it moves on to @img/sharp-wasm32 silently.
    expect((refused as NodeJS.ErrnoException).code).toBe("MODULE_NOT_FOUND");
    expect(next).not.toHaveBeenCalled();

    expect(hook("@img/sharp-wasm32/sharp.node", context, next)).toEqual({ url: "file:///resolved" });
    expect(next).toHaveBeenCalledWith("@img/sharp-wasm32/sharp.node", context);
  });
});

describe("production wiring", () => {
  // The steer only works if it is evaluated before anything imports sharp.
  // index.js is ESM: its static imports all evaluate before its body, so the
  // steer must be a separate module imported ahead of the first sharp
  // importer, in every entry that can load sharp. Workers have their own
  // module loader, so each worker entry needs its own import.
  const read = (rel: string): string =>
    readFileSync(new URL(rel, import.meta.url), "utf8");

  test.each([
    ["../index.ts", "./sharp-wasm-steer"],
    ["../workers/composite-thumbnail-worker.ts", "../sharp-wasm-steer"],
    ["../workers/paste-image-worker.ts", "../sharp-wasm-steer"]
  ])("%s imports the steer before any other non-builtin module", (file, specifier) => {
    const imports = [...read(file).matchAll(/^import\s(?:[^"';]*?\sfrom\s)?"([^"]+)";/gm)].map(
      (match) => match[1]
    );
    const firstAppImport = imports.find(
      (spec) => !spec.startsWith("node:") && spec !== "./startup-profile-boot"
    );
    expect(firstAppImport).toBe(specifier);
  });

  test("the steer is its own rollup input, so it is never inlined behind `import sharp`", () => {
    const config = read("../../../electron.vite.config.ts");
    expect(config).toMatch(/"sharp-wasm-steer":\s*resolve\(__dirname,\s*"src\/main\/sharp-wasm-steer\.ts"\)/);
  });
});
