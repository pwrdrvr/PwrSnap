import { spawnSync } from "node:child_process";
import { expect, test, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import { quoteMcpExecutable } from "../mcp-executable";
test("copyable commands preserve spaces, apostrophes and shell metacharacters literally", () => {
  const path = "/fixture/a'b/$(must-not-execute)/pwrsnap-mcp";
  if (process.platform !== "win32") {
    const result = spawnSync("sh", ["-c", `printf '%s' ${quoteMcpExecutable(path, "darwin")}`], {
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(path);
  }
  expect(quoteMcpExecutable("C:\\fixture's folder\\pwrsnap-mcp.exe", "win32")).toBe(
    "'C:\\fixture''s folder\\pwrsnap-mcp.exe'"
  );
});
