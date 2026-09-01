import { SELECTOR_CROP_CHUNK_BYTES } from "@pwrsnap/shared/selector-crop-stream";
import { describe, expect, test, vi } from "vitest";
import { streamEncodedCrop, type CropStreamExchange } from "../crop-stream";

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
  });
});
