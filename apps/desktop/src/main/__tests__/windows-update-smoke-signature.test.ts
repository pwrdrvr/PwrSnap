import { afterEach, expect, test, vi } from "vitest";

const probe = vi.hoisted(() => vi.fn());
vi.mock("node:util", () => ({ promisify: () => probe }));
import { verifyWindowsSmokeSignature } from "../windows-update-smoke-signature";

afterEach(() => { probe.mockReset(); });

test("verifies the downloaded file through PowerShell 7 without shell interpolation", async () => {
  probe.mockResolvedValue({ stdout: JSON.stringify({ status: "Valid", publisher: "PwrDrvr LLC" }), stderr: "" });
  const path = "D:\\isolated\\quote'and`file.exe";
  await expect(verifyWindowsSmokeSignature(["PwrDrvr LLC"], path)).resolves.toBeNull();
  const [host, args, options] = probe.mock.calls[0];
  expect(host).toBe("pwsh.exe");
  expect(Buffer.from(args.at(-1), "base64").toString("utf16le")).not.toContain(path);
  expect(options.env.PWRSNAP_SIGNATURE_PATH).toBe(path);
  expect(options.timeout).toBe(30_000);
  expect(options.shell).toBeUndefined();
});

test.each([
  { status: "NotSigned", publisher: "PwrDrvr LLC" },
  { status: "HashMismatch", publisher: "PwrDrvr LLC" },
  { status: "Valid", publisher: "Other publisher" },
  null
])("rejects invalid signature evidence: %j", async (evidence) => {
  probe.mockResolvedValue({ stdout: JSON.stringify(evidence), stderr: "" });
  await expect(verifyWindowsSmokeSignature(["PwrDrvr LLC"], "D:\\target.exe")).rejects.toThrow();
});

test("never treats a timeout or malformed output as successful verification", async () => {
  probe.mockRejectedValue(new Error("ETIMEDOUT"));
  await expect(verifyWindowsSmokeSignature(["PwrDrvr LLC"], "D:\\target.exe")).rejects.toThrow("ETIMEDOUT");
  probe.mockResolvedValue({ stdout: "not JSON", stderr: "" });
  await expect(verifyWindowsSmokeSignature(["PwrDrvr LLC"], "D:\\target.exe")).rejects.toThrow();
});

test("rejects unexpected publisher configuration before invoking PowerShell", async () => {
  await expect(verifyWindowsSmokeSignature([], "D:\\target.exe")).rejects.toThrow();
  expect(probe).not.toHaveBeenCalled();
});
