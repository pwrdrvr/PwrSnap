// TEMPORARY diagnostic for the Electron 44 Windows dock-width failure
// (float-over dock settles 32px wide instead of 18). Logs measurements and
// never fails. Remove once the cause is known.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchPwrSnap, test } from "./fixtures/electron-app";

test.describe("windows dock width probe", () => {
  test.skip(process.platform !== "win32", "Windows-only diagnostic");

  test("bare window sizing variants", async () => {
    const app = await launchPwrSnap();
    try {
      const results = await app.electronApp.evaluate(async ({ BrowserWindow, screen }) => {
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const variants: Array<{ name: string; options: Record<string, unknown>; via: "bounds" | "content" }> = [
          { name: "float-over-like", via: "bounds", options: { frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, roundedCorners: false, hasShadow: true } },
          { name: "float-over-like/setContentSize", via: "content", options: { frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, roundedCorners: false, hasShadow: true } },
          { name: "opaque", via: "bounds", options: { frame: false, transparent: false, resizable: false } },
          { name: "transparent-resizable", via: "bounds", options: { frame: false, transparent: true, resizable: true } },
          { name: "transparent-plain", via: "bounds", options: { frame: false, transparent: true } },
          { name: "opaque-thickFrame-false", via: "bounds", options: { frame: false, transparent: false, resizable: false, thickFrame: false } }
        ];
        const out: unknown[] = [];
        const display = screen.getPrimaryDisplay();
        for (const variant of variants) {
          const win = new BrowserWindow({ show: false, width: 200, height: 200, ...variant.options });
          win.setMinimumSize(0, 0);
          win.showInactive();
          await wait(200);
          const rows: unknown[] = [];
          for (const width of [10, 18, 31, 33, 72]) {
            if (variant.via === "bounds") {
              win.setBounds({ x: 300, y: 300, width, height: 54 }, false);
            } else {
              win.setContentSize(width, 54, false);
            }
            await wait(150);
            rows.push({
              asked: width,
              bounds: win.getBounds(),
              content: win.getContentSize(),
              min: win.getMinimumSize(),
              max: win.getMaximumSize()
            });
          }
          out.push({ variant: variant.name, rows });
          win.destroy();
        }
        return { scaleFactor: display.scaleFactor, workArea: display.workArea, out };
      });
      console.log(`[dock-width-probe] bare ${JSON.stringify(results)}`);
    } catch (error) {
      console.log(`[dock-width-probe] bare failed: ${String(error)}`);
    } finally {
      await app.close();
    }
  });

  test("real dock: renderer measure vs window size", async () => {
    const app = await launchPwrSnap();
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-dock-probe-"));
      const pngPath = path.join(dir, "fixture.png");
      await writeFile(
        pngPath,
        Buffer.from(
          "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
          "hex"
        )
      );
      const captureId = `dock-probe-${Date.now().toString(36)}`;
      await app.electronApp.evaluate(async (_electron, payload: { id: string; pngPath: string }) => {
        const bridge = (globalThis as unknown as {
          __PWRSNAP_TEST__: {
            seedCapture: (input: Record<string, unknown>) => Promise<unknown>;
            setFloatOverState: (event: unknown) => void;
          };
        }).__PWRSNAP_TEST__;
        await bridge.seedCapture({
          id: payload.id,
          kind: "image",
          captured_at: new Date().toISOString(),
          source_app_bundle_id: "com.test.dock-probe",
          source_app_name: "Dock Probe",
          legacy_src_path: payload.pngPath,
          width_px: 1920,
          height_px: 1080,
          device_pixel_ratio: 2,
          byte_size: 70,
          sha256: payload.id
        });
        bridge.setFloatOverState({ kind: "show-loaded", captureId: payload.id });
      }, { id: captureId, pngPath });

      let page = null as null | Awaited<ReturnType<typeof app.electronApp.windows>>[number];
      for (let i = 0; i < 100 && page === null; i += 1) {
        page = app.electronApp.windows().find((p) => p.url().includes("stage=float-over")) ?? null;
        if (page === null) await app.window.waitForTimeout(100);
      }
      if (page === null) {
        console.log("[dock-width-probe] dock: no float-over page");
        return;
      }
      await page.locator(".fod-tab").first().waitFor({ timeout: 15_000 });
      for (let sample = 0; sample < 6; sample += 1) {
        await app.window.waitForTimeout(500);
        const renderer = await page.evaluate(() => {
          const describe = (el: Element) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              tag: el.tagName.toLowerCase(),
              cls: (el as HTMLElement).className?.toString().slice(0, 60) ?? "",
              w: r.width,
              h: r.height,
              x: r.x,
              scrollW: (el as HTMLElement).scrollWidth,
              clientW: (el as HTMLElement).clientWidth,
              display: cs.display,
              position: cs.position,
              minW: cs.minWidth,
              overflow: `${cs.overflowX}/${cs.overflowY}`
            };
          };
          const wrapper = document.querySelector("#root > div");
          const nodes = wrapper === null ? [] : [wrapper, ...Array.from(wrapper.querySelectorAll("*")).slice(0, 25)];
          return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            dpr: window.devicePixelRatio,
            nodes: nodes.map(describe)
          };
        });
        const native = await app.electronApp.evaluate(({ BrowserWindow }) => {
          const bridge = (globalThis as unknown as {
            __PWRSNAP_TEST__: { getFloatOverWindowId: () => number | null };
          }).__PWRSNAP_TEST__;
          const id = bridge.getFloatOverWindowId();
          const win = id === null ? null : BrowserWindow.fromId(id);
          if (win === null) return null;
          return {
            visible: win.isVisible(),
            bounds: win.getBounds(),
            content: win.getContentSize(),
            min: win.getMinimumSize(),
            max: win.getMaximumSize(),
            zoom: win.webContents.zoomFactor
          };
        });
        console.log(`[dock-width-probe] dock sample ${sample} ${JSON.stringify({ native, renderer })}`);
      }
    } catch (error) {
      console.log(`[dock-width-probe] dock failed: ${String(error)}`);
    } finally {
      await app.close();
    }
  });
});
