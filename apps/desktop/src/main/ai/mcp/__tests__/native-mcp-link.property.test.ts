import fc from "fast-check";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
vi.mock("electron", () => ({ app: { getVersion: () => "generated" } }));
import { NativeMcpBridge } from "../native-mcp-bridge";

// End-to-end byte oracle: the real Rust classifier + control channel must
// deliver exactly the request bytes, and the reply must reach the same peer.
test("native IPC classification preserves arbitrary HTTP payload bytes under generated fragmentation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ps-link-property-"));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\ps-link-${directory.split(/[\\/]/).pop()}` : join(directory, "m.sock");
  let onBytes = (_bytes: Buffer): void => undefined;
  const bridge = new NativeMcpBridge({ endpoint, allowHttp: true,
    executable: fileURLToPath(new URL("../../../../../build/mcp/" +
      (process.platform === "win32" ? "pwrsnap-mcp.exe" : "pwrsnap-mcp"), import.meta.url)),
    onConnection: (connection) => {
      expect(connection.framing).toBe("http");
      const stream = connection.createStream();
      stream.on("data", (bytes: Buffer) => { onBytes(bytes); stream.write(bytes); });
    }
  });
  try {
    await bridge.start();
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("GET", "POST", "DELETE", "OPTIONS", "HEAD", "PUT", "PATCH"),
      fc.constantFrom("HTTP/1.0", "HTTP/1.1"),
      fc.uint8Array({ maxLength: 2048 }),
      fc.array(fc.integer({ min: 1, max: 150 }), { minLength: 1, maxLength: 10 }),
      async (method, version, payload, splits) => {
        const header = Buffer.from(`${method} /mcp?value=${Buffer.from(payload.subarray(0, 20)).toString("base64url")} ${version}\r\nContent-Length: ${payload.length}\r\n\r\n`);
        const bytes = Buffer.concat([header, payload]);
        const desktop: Buffer[] = [];
        const echoed: Buffer[] = [];
        onBytes = (chunk) => desktop.push(chunk);
        const peer = connect(endpoint);
        peer.on("error", () => undefined);
        try {
          const response = new Promise<void>((resolve, reject) => {
            peer.on("data", (chunk: Buffer) => {
              echoed.push(chunk);
              if (Buffer.concat(echoed).length >= bytes.length) resolve();
            });
            peer.once("error", reject);
            peer.once("close", () => reject(new Error("IPC closed before byte echo completed")));
          });
          await once(peer, "connect");
          let offset = 0;
          for (let i = 0; offset < bytes.length; i++) {
            const end = offset + splits[i % splits.length];
            await new Promise<void>((resolve, reject) =>
              peer.write(bytes.subarray(offset, end), (error) => error ? reject(error) : resolve()));
            offset = end;
          }
          await response;
          expect(Buffer.concat(desktop)).toEqual(bytes);
          expect(Buffer.concat(echoed)).toEqual(bytes);
        } finally { peer.destroy(); await once(peer, "close"); }
      }
    ), { numRuns: 30 });
  } finally { await bridge.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 10_000);
