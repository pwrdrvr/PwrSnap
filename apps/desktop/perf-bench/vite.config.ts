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
  //
  // `NODE_ENV` is pinned in BOTH branches, not just the development
  // one. It selects react-dom's own internals AND is what `main.tsx`
  // reports as the run's arm, while `resolve.conditions` is what
  // actually links the bundle — so if Vite were left to derive NODE_ENV
  // from `--mode`, `vite build --mode development` would move the label
  // (and react-dom's internal checks) without moving the conditions,
  // and the run would print a development header over a production
  // bundle. One switch, no way for the two to disagree.
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.BENCH_REACT === "development" ? "development" : "production"
    )
  },
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
