import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { releaseWindowCaptureTemp } from "../window-capture-temp";

describe("releaseWindowCaptureTemp", () => {
  test("removes only the capture-owned pwrsnap temp directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pwrsnap-window-temp-test-"));
    const tempPath = join(directory, "capture.png");
    await writeFile(tempPath, "png");

    await releaseWindowCaptureTemp(tempPath);

    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses a path outside a pwrsnap-prefixed immediate temp child", async () => {
    await expect(
      releaseWindowCaptureTemp(join(tmpdir(), "not-owned", "capture.png"))
    ).rejects.toThrow("refusing to remove a non-PwrSnap capture temp path");
  });
});
