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

export type SelectorCropStreamConnection = {
  ready: Promise<void>;
  exchange: CropStreamExchange;
  close(): void;
};

const CROP_PORT_CONNECT_TIMEOUT_MS = 2_000;
const CROP_MESSAGE_TIMEOUT_MS = 10_000;

/**
 * Open a fresh, commit-only MessagePort and hand its peer to preload/main.
 * Exactly one request is in flight because streamEncodedCrop awaits every
 * acknowledgement before sending the next bounded chunk.
 */
export function openSelectorCropStream(
  invocationId: number,
  timeouts: {
    connectMs?: number;
    messageMs?: number;
  } = {}
): SelectorCropStreamConnection {
  const connectTimeoutMs = timeouts.connectMs ?? CROP_PORT_CONNECT_TIMEOUT_MS;
  const messageTimeoutMs = timeouts.messageMs ?? CROP_MESSAGE_TIMEOUT_MS;
  const channel = new MessageChannel();
  const port = channel.port1;
  let closed = false;
  let readySettled = false;
  let connected = false;
  let resolveReady!: () => void;
  let rejectReady!: (cause: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error("committed crop port connection timed out"));
  }, connectTimeoutMs);
  let pending:
    | {
        resolve: (reply: SelectorCropStreamReply) => void;
        reject: (cause: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;

  const rejectPending = (cause: Error): void => {
    const active = pending;
    pending = null;
    if (active === null) return;
    clearTimeout(active.timer);
    active.reject(cause);
  };
  port.onmessage = (event): void => {
    const message = event.data as { type?: unknown; invocationId?: unknown } | null;
    if (
      message !== null &&
      message.type === "crop-port-ready" &&
      message.invocationId === invocationId
    ) {
      if (!readySettled) {
        readySettled = true;
        connected = true;
        clearTimeout(readyTimer);
        resolveReady();
      }
      return;
    }
    if (
      !readySettled &&
      message !== null &&
      message.type === "crop-rejected" &&
      message.invocationId === invocationId
    ) {
      readySettled = true;
      clearTimeout(readyTimer);
      rejectReady(
        new Error(
          typeof (message as { code?: unknown }).code === "string"
            ? String((message as { code: string }).code)
            : "committed crop port rejected"
        )
      );
      return;
    }
    const active = pending;
    if (active === null) return;
    const reply = event.data as SelectorCropStreamReply | null;
    if (
      reply === null ||
      typeof reply !== "object" ||
      reply.invocationId !== invocationId ||
      typeof reply.type !== "string"
    ) {
      rejectPending(new Error("invalid committed crop acknowledgement"));
      return;
    }
    pending = null;
    clearTimeout(active.timer);
    active.resolve(reply);
  };
  port.onmessageerror = (): void => {
    const cause = new Error("committed crop acknowledgement could not be decoded");
    if (!readySettled) {
      readySettled = true;
      clearTimeout(readyTimer);
      rejectReady(cause);
    }
    rejectPending(cause);
  };
  port.start();
  window.postMessage(
    { type: "pwrsnap-selector-crop-port", invocationId },
    "*",
    [channel.port2]
  );

  return {
    ready,
    exchange(message, transfer) {
      if (closed) return Promise.reject(new Error("committed crop port is closed"));
      if (!connected) {
        return Promise.reject(new Error("committed crop port is not connected"));
      }
      if (pending !== null) {
        return Promise.reject(new Error("committed crop exchange is already in flight"));
      }
      return new Promise<SelectorCropStreamReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending?.timer !== timer) return;
          pending = null;
          reject(new Error("committed crop transfer timed out"));
        }, messageTimeoutMs);
        pending = { resolve, reject, timer };
        try {
          if (transfer === undefined) port.postMessage(message);
          else port.postMessage(message, transfer);
        } catch (cause) {
          rejectPending(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (!readySettled) {
        readySettled = true;
        clearTimeout(readyTimer);
        rejectReady(new Error("committed crop port closed"));
      }
      rejectPending(new Error("committed crop port closed"));
      port.close();
    }
  };
}

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
