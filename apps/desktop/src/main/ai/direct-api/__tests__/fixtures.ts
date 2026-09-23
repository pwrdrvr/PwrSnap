import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CustomModel } from "@pwrsnap/shared";
export const FIRST_ID = "12345678-1234-4234-8234-123456789001";
export const SECOND_ID = "12345678-1234-4234-8234-123456789002";
export const CREDENTIAL_ID = "12345678-1234-4234-8234-123456789003";
export const OTHER_CREDENTIAL_ID = "12345678-1234-4234-8234-123456789004";
// Contrived 1x1 transparent PNG, never an operator capture.
export const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
export function model(baseUrl: string, protocol: CustomModel["protocol"] = "openai-chat"): CustomModel {
  return { id: FIRST_ID, displayName: "Fixture model", modelId: "fixture/exact-model", baseUrl,
    protocol, auth: { type: "none" }, capabilities: { vision: true, streaming: true }, maxOutputTokens: 100 };
}
export async function server(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<{ url: string; close(): Promise<void> }> {
  const instance = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500).end(); }); });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address(); if (!address || typeof address === "string") throw new Error("fixture address missing");
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    instance.closeAllConnections(); await new Promise<void>((resolve) => instance.close(() => resolve()));
  } };
}
export async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString();
}
export function json(res: ServerResponse, value: unknown): void { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); }
export function stream(res: ServerResponse, events: unknown[]): void {
  res.setHeader("content-type", "text/event-stream");
  for (const event of events) {
    const line = `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`;
    // Deliberately split every event and its CRLF framing across writes.
    res.write(line.slice(0, -3)); res.write(line.slice(-3));
  }
  res.end();
}
