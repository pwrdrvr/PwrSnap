import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

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
        copyMainAssetsPlugin()
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
