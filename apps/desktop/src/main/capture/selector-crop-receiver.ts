import {
  SELECTOR_CROP_MAX_PIXELS,
  isSelectorCropChunkMessage,
  isSelectorCropEndMessage,
  isSelectorCropStartMessage,
  type SelectorCropChunkMessage,
  type SelectorCropEndMessage,
  type SelectorCropStartMessage,
  type SelectorCropStreamReply
} from "@pwrsnap/shared/selector-crop-stream";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

type ReceivingCrop = {
  dir: string;
  path: string;
  file: FileHandle;
  width: number;
  height: number;
  totalBytes: number;
  receivedBytes: number;
  nextSequence: number;
};

export type SelectorCropReceiverResult = {
  reply: SelectorCropStreamReply;
  completedPath?: string;
};

const SHARP_CROP_OPTIONS = {
  failOn: "warning" as const,
  limitInputPixels: SELECTOR_CROP_MAX_PIXELS,
  limitInputChannels: 4,
  sequentialRead: true,
  unlimited: false
};

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("crop stream write made no progress");
    offset += bytesWritten;
  }
}

async function validateCommittedPng(
  path: string,
  declared: { width: number; height: number }
): Promise<void> {
  const metadata = await sharp(path, SHARP_CROP_OPTIONS).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== declared.width ||
    metadata.height !== declared.height ||
    (metadata.pages !== undefined && metadata.pages !== 1) ||
    metadata.channels === undefined ||
    metadata.channels < 1 ||
    metadata.channels > 4
  ) {
    throw new Error("committed crop PNG metadata does not match its declaration");
  }

  // metadata() only probes the header. Force a complete decode while
  // discarding chunks so truncated/corrupt PNGs cannot enter persistence.
  const pipeline = sharp(path, SHARP_CROP_OPTIONS).raw();
  const decodedByteCap = declared.width * declared.height * 4;
  let decodedBytes = 0;
  try {
    for await (const chunk of pipeline) {
      decodedBytes += Buffer.byteLength(chunk);
      if (decodedBytes > decodedByteCap) {
        throw new Error("committed crop PNG exceeds its decoded-size declaration");
      }
    }
  } finally {
    pipeline.destroy();
  }
  if (decodedBytes <= 0) throw new Error("committed crop PNG decoded no pixels");
}

/**
 * Main-side receiver for one committed crop. Messages are bounded and
 * backpressured: the renderer sends the next chunk only after the preceding
 * chunk is durably written and acknowledged.
 */
export class SelectorCropReceiver {
  readonly invocationId: number;
  private receiving: ReceivingCrop | null = null;
  private completedDir: string | null = null;
  private completedPath: string | null = null;
  private busy = false;
  private disposed = false;

  constructor(invocationId: number) {
    this.invocationId = invocationId;
  }

  async accept(value: unknown): Promise<SelectorCropReceiverResult> {
    if (this.busy || this.disposed || this.completedPath !== null) {
      throw new Error("crop stream is not accepting messages");
    }
    this.busy = true;
    try {
      if (isSelectorCropStartMessage(value)) return await this.start(value);
      if (isSelectorCropChunkMessage(value)) return await this.chunk(value);
      if (isSelectorCropEndMessage(value)) return await this.finish(value);
      throw new Error("invalid crop stream message");
    } finally {
      this.busy = false;
      if (this.disposed) await this.cleanup();
    }
  }

  takeCompletedPath(): string | null {
    const path = this.completedPath;
    if (path === null) return null;
    this.completedPath = null;
    this.completedDir = null;
    return path;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (!this.busy) await this.cleanup();
  }

  private async start(message: SelectorCropStartMessage): Promise<SelectorCropReceiverResult> {
    if (message.invocationId !== this.invocationId || this.receiving !== null) {
      throw new Error("invalid crop stream start");
    }
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-selector-crop-"));
    const path = join(dir, `${this.invocationId}.png`);
    try {
      const file = await open(path, "wx");
      this.receiving = {
        dir,
        path,
        file,
        width: message.width,
        height: message.height,
        totalBytes: message.totalBytes,
        receivedBytes: 0,
        nextSequence: 0
      };
    } catch (cause) {
      await rm(dir, { recursive: true, force: true });
      throw cause;
    }
    return {
      reply: { type: "crop-started", invocationId: this.invocationId }
    };
  }

  private async chunk(message: SelectorCropChunkMessage): Promise<SelectorCropReceiverResult> {
    const receiving = this.receiving;
    if (
      message.invocationId !== this.invocationId ||
      receiving === null ||
      message.sequence !== receiving.nextSequence ||
      receiving.receivedBytes + message.bytes.byteLength > receiving.totalBytes
    ) {
      throw new Error("invalid crop stream chunk");
    }
    await writeAll(receiving.file, new Uint8Array(message.bytes));
    receiving.receivedBytes += message.bytes.byteLength;
    receiving.nextSequence += 1;
    return {
      reply: {
        type: "crop-chunk-accepted",
        invocationId: this.invocationId,
        sequence: message.sequence
      }
    };
  }

  private async finish(message: SelectorCropEndMessage): Promise<SelectorCropReceiverResult> {
    const receiving = this.receiving;
    if (
      message.invocationId !== this.invocationId ||
      receiving === null ||
      message.chunks !== receiving.nextSequence ||
      receiving.receivedBytes !== receiving.totalBytes
    ) {
      throw new Error("incomplete crop stream");
    }
    this.receiving = null;
    await receiving.file.close();
    try {
      await validateCommittedPng(receiving.path, receiving);
    } catch (cause) {
      await rm(receiving.dir, { recursive: true, force: true });
      throw cause;
    }
    this.completedDir = receiving.dir;
    this.completedPath = receiving.path;
    return {
      reply: { type: "crop-accepted", invocationId: this.invocationId },
      completedPath: receiving.path
    };
  }

  private async cleanup(): Promise<void> {
    const receiving = this.receiving;
    this.receiving = null;
    if (receiving !== null) {
      await receiving.file.close().catch(() => undefined);
      await rm(receiving.dir, { recursive: true, force: true });
    }
    if (this.completedDir !== null) {
      const dir = this.completedDir;
      this.completedDir = null;
      this.completedPath = null;
      await rm(dir, { recursive: true, force: true });
    }
  }
}
