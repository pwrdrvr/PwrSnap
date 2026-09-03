import { SELECTOR_CROP_CHUNK_BYTES } from "@pwrsnap/shared/selector-crop-stream";
import { describe, expect, test, vi } from "vitest";
import {
  openSelectorCropStream,
  streamEncodedCrop,
  type CropStreamExchange
} from "../crop-stream";

describe("selector crop stream", () => {
  test("never transfers the complete encoded crop in one message", async () => {
    const size = SELECTOR_CROP_CHUNK_BYTES * 2 + 13;
    const messages: Array<{ type: string; bytes?: number }> = [];
    const exchange = vi.fn<CropStreamExchange>(async (message) => {
      messages.push({
        type: message.type,
        ...(message.type === "crop-chunk" ? { bytes: message.bytes.byteLength } : {})
      });
      if (message.type === "crop-start") {
        return { type: "crop-started", invocationId: message.invocationId };
      }
      if (message.type === "crop-chunk") {
        return {
          type: "crop-chunk-accepted",
          invocationId: message.invocationId,
          sequence: message.sequence
        };
      }
      return { type: "crop-accepted", invocationId: message.invocationId };
    });

    await streamEncodedCrop(
      51,
      {
        blob: new Blob([new Uint8Array(size)], { type: "image/png" }),
        width: 100,
        height: 100,
        mimeType: "image/png"
      },
      exchange
    );

    expect(messages.map((message) => message.type)).toEqual([
      "crop-start",
      "crop-chunk",
      "crop-chunk",
      "crop-chunk",
      "crop-end"
    ]);
    expect(messages.filter((message) => message.type === "crop-chunk")).toEqual([
      { type: "crop-chunk", bytes: SELECTOR_CROP_CHUNK_BYTES },
      { type: "crop-chunk", bytes: SELECTOR_CROP_CHUNK_BYTES },
      { type: "crop-chunk", bytes: 13 }
    ]);
    // Electron MessagePortMain cannot receive renderer-owned ArrayBuffers in
    // a transfer list on Windows. Every bounded exchange must have exactly
    // one argument so the chunk is structured-cloned instead.
    for (const call of exchange.mock.calls) expect(call).toHaveLength(1);
  });

  test("opens a fresh commit port and exchanges bounded copied chunks", async () => {
    const forwarded: unknown[] = [];
    const postMessage = vi.spyOn(window, "postMessage");
    postMessage.mockImplementation(
      ((message: unknown, _targetOrigin: string, transfer?: Transferable[]) => {
        forwarded.push(message);
        const mainPort = transfer?.[0] as MessagePort | undefined;
        if (mainPort === undefined) return;
        mainPort.onmessage = (event): void => {
          const request = event.data as {
            type: "crop-start" | "crop-chunk" | "crop-end";
            invocationId: number;
            sequence?: number;
          };
          if (request.type === "crop-start") {
            mainPort.postMessage({ type: "crop-started", invocationId: request.invocationId });
          } else if (request.type === "crop-chunk") {
            mainPort.postMessage({
              type: "crop-chunk-accepted",
              invocationId: request.invocationId,
              sequence: request.sequence
            });
          } else {
            mainPort.postMessage({ type: "crop-accepted", invocationId: request.invocationId });
          }
        };
        mainPort.start();
        mainPort.postMessage({ type: "crop-port-ready", invocationId: 52 });
      }) as never
    );
    const connection = openSelectorCropStream(52, { connectMs: 1_000, messageMs: 1_000 });
    try {
      await connection.ready;
      await streamEncodedCrop(
        52,
        {
          blob: new Blob([new Uint8Array(32)], { type: "image/png" }),
          width: 4,
          height: 2,
          mimeType: "image/png"
        },
        connection.exchange
      );
    } finally {
      connection.close();
      postMessage.mockRestore();
    }

    expect(forwarded).toEqual([
      { type: "pwrsnap-selector-crop-port", invocationId: 52 }
    ]);
  });

  test("fails a missing main-process port acknowledgement on a deterministic deadline", async () => {
    vi.useFakeTimers();
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(vi.fn());
    const connection = openSelectorCropStream(53, { connectMs: 25 });
    const outcome = expect(connection.ready).rejects.toThrow("connection timed out");
    await vi.advanceTimersByTimeAsync(25);
    await outcome;
    connection.close();
    postMessage.mockRestore();
    vi.useRealTimers();
  });
});
