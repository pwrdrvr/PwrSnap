import {
  SELECTOR_CROP_CHUNK_BYTES,
  type SelectorCropStreamMessage,
  type SelectorCropStreamReply
} from "@pwrsnap/shared/selector-crop-stream";
import type { EncodedFrozenCrop } from "./frozen-frame";

export type CropStreamExchange = (
  message: SelectorCropStreamMessage,
  transfer?: Transferable[]
) => Promise<SelectorCropStreamReply>;

function requireReply(
  reply: SelectorCropStreamReply,
  expectedType: SelectorCropStreamReply["type"],
  sequence?: number
): void {
  if (reply.type === "crop-rejected") throw new Error(reply.code);
  if (reply.type !== expectedType) throw new Error(`unexpected crop reply: ${reply.type}`);
  if (
    expectedType === "crop-chunk-accepted" &&
    (reply.type !== "crop-chunk-accepted" || reply.sequence !== sequence)
  ) {
    throw new Error("crop chunk acknowledgement is out of sequence");
  }
}

/** Stream one encoded crop over a MessagePort with per-chunk backpressure. */
export async function streamEncodedCrop(
  invocationId: number,
  crop: EncodedFrozenCrop,
  exchange: CropStreamExchange
): Promise<void> {
  let reply = await exchange({
    type: "crop-start",
    invocationId,
    width: crop.width,
    height: crop.height,
    mimeType: crop.mimeType,
    totalBytes: crop.blob.size
  });
  requireReply(reply, "crop-started");

  let sequence = 0;
  for (let offset = 0; offset < crop.blob.size; offset += SELECTOR_CROP_CHUNK_BYTES) {
    const bytes = await crop.blob
      .slice(offset, Math.min(offset + SELECTOR_CROP_CHUNK_BYTES, crop.blob.size))
      .arrayBuffer();
    reply = await exchange(
      { type: "crop-chunk", invocationId, sequence, bytes },
      [bytes]
    );
    requireReply(reply, "crop-chunk-accepted", sequence);
    sequence += 1;
  }

  reply = await exchange({
    type: "crop-end",
    invocationId,
    chunks: sequence
  });
  requireReply(reply, "crop-accepted");
}
