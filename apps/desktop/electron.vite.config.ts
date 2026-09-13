import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

/**
 * Opt-in: bridge the renderer to the standalone `react-devtools` app.
 *
 * Set to `1` to have the renderer HTML load the DevTools backend from
 * `http://<host>:<port>` as its very first script — the hook has to be
 * installed before `react-dom` initializes or React never registers a
 * renderer with it. Companion vars pick the endpoint; see AGENTS.md
 * ("React DevTools renderer profiling").
 *
 * Read at Vite config time, not at app runtime. With the var unset the
 * plugin below is never constructed, so a normal `electron-vite build`
 * emits the same HTML it does today. `verify-asar-contents.mjs` fails
 * packaging if a bridged HTML ever reaches an app.asar anyway.
 */
const REACT_DEVTOOLS_ENV = "PWRSNAP_REACT_DEVTOOLS";
const REACT_DEVTOOLS_HOST_ENV = "PWRSNAP_REACT_DEVTOOLS_HOST";
const REACT_DEVTOOLS_PORT_ENV = "PWRSNAP_REACT_DEVTOOLS_PORT";
const DEFAULT_REACT_DEVTOOLS_HOST = "localhost";
const DEFAULT_REACT_DEVTOOLS_PORT = "8097";

/**
 * Opt-in: build the renderer against `react-dom/profiling` instead of
 * `react-dom/client`, so the DevTools Profiler can record a production
 * bundle. A plain production `react-dom` is compiled without the timing
 * instrumentation and the Profiler tab reports "Profiling not supported".
 *
 * Only `react-dom/client` is aliased. Every other entry — bare `react-dom`
 * for `createPortal`/`flushSync`, and `react-dom/server` — keeps resolving
 * normally, which is what keeps a single reconciler in the bundle: in
 * React 19 both `react-dom/client` and `react-dom/profiling` require the
 * shared bare `react-dom` module for their internals, so swapping the
 * client entry alone cannot produce two copies.
 */
const REACT_PROFILING_ENV = "PWRSNAP_REACT_PROFILING";

/**
 * Matches the allowlist the rest of the repository uses for env-gated
 * harnesses (`isEnabled` in `src/main/diagnostics/content-trace-config.ts`
 * and `src/main/diagnostics/hot-cpu-profile-config.ts`). Anything else is
 * off — in particular `false`, `off`, and `no`, which a "not empty and not
 * 0" test would read as on and silently bake the bridge into a build.
 */
function isEnvEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value !== undefined && ["1", "true", "yes", "on"].includes(value);
}

/**
 * Injects the standalone React DevTools backend as the first `<head>`
 * script. `head-prepend` matters: it lands above the pre-React appearance
 * bootstrap and above the `/src/main.tsx` module, which is the ordering the
 * DevTools hook needs.
 *
 * The script also logs the endpoint to the renderer console. Several
 * PwrDrvr Electron apps usually run at once on one machine and the
 * standalone DevTools window says nothing about which page it is attached
 * to, so that line is how an operator confirms that *this* window is the
 * one talking to the DevTools instance on that port.
 */
function reactDevtoolsBridge(): Plugin {
  const host = process.env[REACT_DEVTOOLS_HOST_ENV]?.trim()
    || DEFAULT_REACT_DEVTOOLS_HOST;
  const port = process.env[REACT_DEVTOOLS_PORT_ENV]?.trim()
    || DEFAULT_REACT_DEVTOOLS_PORT;
  const endpoint = `http://${host}:${port}`;
  return {
    name: "pwrsnap:react-devtools-bridge",
    transformIndexHtml: {
      order: "pre",
      // Returns the bare tag array rather than `{ html, tags }`: the object
      // form's `html` is required by the type, and passing "" to mean "leave
      // the document alone" only works because Vite happens to do
      // `res.html || html`. The array form says the same thing by contract.
      handler: () => [
        {
          tag: "script",
          attrs: { src: endpoint },
          injectTo: "head-prepend" as const
        },
        {
          tag: "script",
          // Vite escapes tag attributes but emits inline-script children
          // verbatim, and JSON.stringify does not escape `<` — so a host
          // carrying `</script>` would close this tag early.
          children: `console.info(${JSON.stringify(
            `[pwrsnap] React DevTools bridge -> ${endpoint} (renderer from ${__dirname})`
          ).replaceAll("<", "\\u003c")});`,
          injectTo: "head-prepend" as const
        }
      ]
    }
  };
}

/**
 * Copy main-process fs assets alongside the compiled main bundle. Runtime
 * code reads these via filesystem paths so prompts stay reviewable as .md and
 * migrations stay executable as .sql in both dev and packaged builds.
 */
function copyMainAssetsPlugin(): Plugin {
  return {
    name: "pwrsnap-copy-main-assets",
    writeBundle(options) {
      const out = options.dir;
      if (out === undefined) return;
      copyDirFiles({
        src: resolve(__dirname, "src/main/persistence/migrations"),
        dest: resolve(out, "migrations"),
        extension: ".sql"
      });
      copyDirFiles({
        src: resolve(__dirname, "src/main/ai/prompts"),
        dest: resolve(out, "prompts"),
        extension: ".md"
      });
    }
  };
}

function copyDirFiles({
  src,
  dest,
  extension
}: {
  src: string;
  dest: string;
  extension: string;
}): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const file of readdirSync(src)) {
    if (!file.endsWith(extension)) continue;
    copyFileSync(resolve(src, file), resolve(dest, file));
  }
}

export default defineConfig(({ command }) => {
  const isBuild = command === "build";
  const productionDefine = isBuild
    ? { "process.env.NODE_ENV": JSON.stringify("production") }
    : {};

  const devtoolsBridgeEnabled = isEnvEnabled(REACT_DEVTOOLS_ENV);
  // The profiling alias is a build-only swap. `electron-vite dev` already
  // serves react-dom's development build, which carries the Profiler and
  // the hook-level "why did this render" attribution the production
  // profiling build drops — so aliasing in dev would cost a dependency
  // re-optimization and buy nothing.
  const profilingEnabled = isEnvEnabled(REACT_PROFILING_ENV);
  if (profilingEnabled) {
    console.warn(
      isBuild
        ? `[pwrsnap] ${REACT_PROFILING_ENV} is set: aliasing react-dom/client -> react-dom/profiling.`
          + " Do not ship this build."
        : `[pwrsnap] ${REACT_PROFILING_ENV} is set but only applies to \`electron-vite build\`;`
          + " the dev server already serves a profilable react-dom."
    );
  }
  if (devtoolsBridgeEnabled && isBuild) {
    console.warn(
      `[pwrsnap] ${REACT_DEVTOOLS_ENV} is set: the built renderer HTML will load the`
      + " React DevTools backend over http. Do not ship this build."
    );
  }

  return {
    main: {
      define: productionDefine,
      plugins: [
        // Source-form packages get bundled, not externalized — Node's
        // ESM resolver can't follow extensionless `./protocol`-style
        // imports inside source-form packages, and we don't want to ship
        // TS source separately. Mirrors PwrAgnt.
        externalizeDepsPlugin({
          exclude: ["@pwrsnap/shared", "@pwrdrvr/codex-app-server-protocol"]
        }),
        copyMainAssetsPlugin()
      ],
      build: {
        minify: "esbuild",
        sourcemap: false,
        // Multiple entries: main process + worker_threads scripts. Each
        // worker entry is loaded at runtime via
        // `new Worker(join(__dirname, "<name>.js"))` from its
        // workers/*-client.ts. Keeping them as separate bundles (rather
        // than evaling a string) preserves source-map resolution + lets
        // vite tree-shake each worker's deps.
        rollupOptions: {
          input: {
            index: resolve(__dirname, "src/main/index.ts"),
            "paste-image-worker": resolve(
              __dirname,
              "src/main/workers/paste-image-worker.ts"
            ),
            "composite-thumbnail-worker": resolve(
              __dirname,
              "src/main/workers/composite-thumbnail-worker.ts"
            ),
            // Standalone stdio MCP server an ACP chat agent (Gemini/Qwen)
            // spawns to reach PwrSnap tools. Built as its own bundle and
            // launched at runtime via `process.execPath` + ELECTRON_RUN_AS_NODE
            // (see pwrsnap-mcp-server-config.ts).
            "pwrsnap-mcp-server": resolve(
              __dirname,
              "src/main/ai/mcp/pwrsnap-mcp-server-entry.ts"
            )
          },
          output: {
            entryFileNames: "[name].js"
          }
        }
      }
    },
    preload: {
      define: productionDefine,
      plugins: [
        externalizeDepsPlugin({
          exclude: ["@pwrsnap/shared", "@pwrdrvr/codex-app-server-protocol"]
        })
      ],
      build: {
        minify: "esbuild",
        sourcemap: false,
        rollupOptions: {
          output: { format: "cjs" }
        }
      }
    },
    renderer: {
      plugins: devtoolsBridgeEnabled
        ? [react(), reactDevtoolsBridge()]
        : [react()],
      resolve: {
        alias: {
          "@renderer": resolve(__dirname, "src/renderer/src"),
          ...(profilingEnabled && isBuild
            ? { "react-dom/client": "react-dom/profiling" }
            : {})
        }
      },
      build: {
        minify: "esbuild",
        sourcemap: false
      }
    }
  };
});
