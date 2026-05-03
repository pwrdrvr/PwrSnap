import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

/**
 * Copy SQL migrations alongside the compiled main bundle. better-sqlite3
 * reads them via fs.readFileSync(__dirname/migrations/...) at runtime,
 * which resolves to `out/main/migrations/...` in production and to
 * `apps/desktop/src/main/persistence/migrations/...` during dev (where
 * electron-vite runs from source). Phase 1.3.
 */
function copyMigrationsPlugin(): Plugin {
  return {
    name: "pwrsnap-copy-migrations",
    writeBundle(options) {
      const out = options.dir;
      if (out === undefined) return;
      const src = resolve(__dirname, "src/main/persistence/migrations");
      if (!existsSync(src)) return;
      const dest = resolve(out, "migrations");
      mkdirSync(dest, { recursive: true });
      for (const file of readdirSync(src)) {
        if (!file.endsWith(".sql")) continue;
        copyFileSync(resolve(src, file), resolve(dest, file));
      }
    }
  };
}

export default defineConfig(({ command }) => {
  const isBuild = command === "build";
  const productionDefine = isBuild
    ? { "process.env.NODE_ENV": JSON.stringify("production") }
    : {};

  return {
    main: {
      define: productionDefine,
      plugins: [
        // Workspace packages get bundled, not externalized — Node's
        // ESM resolver can't follow extensionless `./protocol`-style
        // imports inside source-form workspace packages, and we don't
        // want to ship our shared TS source separately. Mirrors PwrAgnt.
        externalizeDepsPlugin({
          exclude: ["@pwrsnap/shared", "@pwrsnap/codex-app-server-protocol"]
        }),
        copyMigrationsPlugin()
      ],
      build: {
        minify: "esbuild",
        sourcemap: false
      }
    },
    preload: {
      define: productionDefine,
      plugins: [
        externalizeDepsPlugin({
          exclude: ["@pwrsnap/shared", "@pwrsnap/codex-app-server-protocol"]
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
      plugins: [react()],
      resolve: {
        alias: {
          "@renderer": resolve(__dirname, "src/renderer/src")
        }
      },
      build: {
        minify: "esbuild",
        sourcemap: false
      }
    }
  };
});
