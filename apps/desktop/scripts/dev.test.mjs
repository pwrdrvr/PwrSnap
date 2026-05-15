import { describe, expect, it } from "vitest";
import {
  checkNodeVersion,
  ELECTRON_DEV_ENV_KEYS,
  sanitizeDevEnv
} from "./dev.mjs";

describe("dev launch environment", () => {
  it("scrubs inherited Electron and module-resolution variables", () => {
    const inherited = {
      ELECTRON_EXEC_PATH: "/other/repo/Electron",
      ELECTRON_RENDERER_URL: "http://localhost:5173",
      NODE_PATH: "/other/repo/node_modules",
      PATH: "/usr/bin",
      PWRSNAP_DATA_ROOT: "/tmp/pwrsnap"
    };

    const { env, removed } = sanitizeDevEnv(inherited);

    for (const key of ELECTRON_DEV_ENV_KEYS) {
      expect(env).not.toHaveProperty(key);
    }
    expect(removed).toEqual(["ELECTRON_EXEC_PATH", "ELECTRON_RENDERER_URL", "NODE_PATH"]);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PWRSNAP_DATA_ROOT).toBe("/tmp/pwrsnap");
  });

  it("requires the active Node version to match .nvmrc exactly", () => {
    expect(checkNodeVersion("v24.14.1", "v24.14.1\n")).toMatchObject({ ok: true });
    expect(checkNodeVersion("v24.13.0", "v24.14.1\n")).toMatchObject({
      actual: "24.13.0",
      expected: "24.14.1",
      ok: false
    });
  });
});
