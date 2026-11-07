import fc from "fast-check";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import { NativeMcpBridge, type McpByteTransport } from "../native-mcp-bridge";

test("valid multi-MiB responses drain exactly once without interleaving or closing the shared listener", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 5, max: 8 }), async (mib) => {
    const dir = mkdtempSync(join(tmpdir(), "ps-pressure-"));
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\ps-pressure-${dir.split(/[\\/]/).pop()}` : join(dir, "m.sock");
    let opened!: (transport: McpByteTransport) => void;
    const transports: McpByteTransport[] = [];
    const bridge = new NativeMcpBridge({ endpoint,
      executable: fileURLToPath(new URL("../../../../../build/mcp/" + (process.platform === "win32" ? "pwrsnap-mcp.exe" : "pwrsnap-mcp"), import.meta.url)),
      onConnection: ({ createTransport }) => {
        const transport = createTransport(); transports.push(transport); void transport.start(); opened(transport);
      }
    });
    await bridge.start();
    const peers: ReturnType<typeof connect>[] = [];
    try {
      for (const size of [mib * 1024 * 1024, 32]) {
        const transportReady = new Promise<McpByteTransport>((resolve) => { opened = resolve; });
        const peer = connect(endpoint);
        peers.push(peer);
        const chunks: Buffer[] = [];
        let done!: () => void;
        const notification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" } as const;
        const message = { jsonrpc: "2.0", id: 1, result: { blob: "x".repeat(size) } } as const;
        const body = Buffer.from(JSON.stringify(message) + "\n" + JSON.stringify(notification) + "\n");
        const received = new Promise<void>((resolve, reject) => {
          done = resolve;
          peer.on("error", reject);
          peer.on("close", () => reject(new Error("peer closed before response completed")));
        });
        let length = 0;
        let greeting = -1;
        peer.on("data", (chunk: Buffer) => {
          chunks.push(chunk); length += chunk.length;
          if (greeting < 0) greeting = Buffer.concat(chunks).indexOf(10);
          if (greeting >= 0 && length >= greeting + 1 + body.length) done();
        });
        await once(peer, "connect");
        peer.write("PWRSNAP-MCP/1 0.0.1\n");
        const transport = await transportReady;
        // Concurrent SDK sends must preserve message boundaries on one stream.
        await Promise.all([transport.send(message), transport.send(notification), received]);
        const wire = Buffer.concat(chunks);
        const actual = wire.subarray(wire.indexOf(10) + 1);
        const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
        expect(actual.length).toBe(body.length);
        expect(hash(actual)).toBe(hash(body));
        expect(bridge.isRunning()).toBe(true);
      }
      const ready = new Promise<McpByteTransport>((resolve) => { opened = resolve; });
      const abandoned = connect(endpoint);
      peers.push(abandoned);
      abandoned.on("error", () => undefined);
      await once(abandoned, "connect");
      abandoned.write("PWRSNAP-MCP/1 0.0.1\n");
      const transport = await ready;
      const pending = transport.send({ jsonrpc: "2.0", id: 9, result: { blob: "x".repeat(8 * 1024 * 1024) } });
      abandoned.destroy();
      await expect(pending).rejects.toThrow(/reconnect|disconnected/i);
      expect(transport.controller.signal.aborted).toBe(true);
      await transports[0].send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      expect(bridge.isRunning()).toBe(true);
    } finally { for (const peer of peers) peer.destroy(); await bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
  }), { numRuns: 3, examples: [[5]] });
}, 20_000);
