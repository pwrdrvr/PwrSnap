import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  plugins: [
    react(),
    {
      // Swap the IPC-backed assets hook for a static descriptor so the
      // bench measures render cost, not command-bus latency.
      name: "bench-stub-assets",
      enforce: "pre",
      resolveId(source) {
        if (source.endsWith("shared/useVideoTimelineAssets")) {
          return `${here}stub-assets.tsx`;
        }
        return null;
      }
    }
  ],
  // `BENCH_REACT=development` builds against react-dom.development so a
  // run can be compared against the DEV-server hot-cpu profiles.
  define:
    process.env.BENCH_REACT === "development"
      ? { "process.env.NODE_ENV": JSON.stringify("development") }
      : {},
  resolve:
    process.env.BENCH_REACT === "development"
      ? { conditions: ["development", "module", "browser"] }
      : {},
  build: {
    outDir: `${here}dist`,
    emptyOutDir: true,
    minify: true
  }
});
