import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig(({ command }) => {
  const isBuild = command === "build";
  const productionDefine = isBuild
    ? { "process.env.NODE_ENV": JSON.stringify("production") }
    : {};

  return {
    main: {
      define: productionDefine,
      plugins: [externalizeDepsPlugin()],
      build: {
        minify: "esbuild",
        sourcemap: false
      }
    },
    preload: {
      define: productionDefine,
      plugins: [externalizeDepsPlugin()],
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
