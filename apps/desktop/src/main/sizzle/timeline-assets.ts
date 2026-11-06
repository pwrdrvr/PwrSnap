import "../sharp-wasm-steer";
import sharp from "sharp";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, unlink, readFile } from "node:fs/promises";
import { basename, extname, join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SizzleAsset } from "@pwrsnap/shared";
import { probeTimelineMedia } from "./timeline-process";

const MAX_BYTES = 2 * 1024 ** 3;
const extensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp4",
  ".mov",
  ".m4v",
  ".wav",
  ".mp3",
  ".m4a",
  ".flac",
  ".aac",
]);

export function timelineAssetPath(root: string, asset: SizzleAsset): string {
  if (!/^[a-f0-9]{64}$/.test(asset.id) || !extensions.has(asset.extension))
    throw new Error("Invalid asset identity");
  return join(root, `${asset.id}${asset.extension}`);
}

/** A managed copy, never a live reference to arbitrary source paths. SVG,
 * playlists, URLs, directories and devices are not importable media. */
let imports: Promise<unknown> = Promise.resolve();
export function importTimelineAsset(
  root: string,
  path: string,
  ffmpeg: string,
  signal?: AbortSignal,
): Promise<SizzleAsset> {
  // A pending macOS folder grant must not consume every libuv filesystem
  // worker when an agent imports a batch of files at once.
  const pending = imports
    .catch(() => undefined)
    .then(() => {
      signal?.throwIfAborted();
      return performImport(root, path, ffmpeg, signal);
    });
  imports = pending.catch(() => undefined);
  return pending;
}

async function performImport(
  root: string,
  path: string,
  ffmpeg: string,
  signal?: AbortSignal,
): Promise<SizzleAsset> {
  const extension = extname(path).toLowerCase();
  if (!isAbsolute(path) || !extensions.has(extension))
    throw new Error(
      "Import requires an absolute local PNG, JPEG, WebP, MOV, MP4, or audio path",
    );
  await mkdir(root, { recursive: true });
  const staging = join(root, `.import-${randomUUID()}${extension}`);
  const source = await open(path, "r");
  let byteSize = 0;
  const hash = createHash("sha256");
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size < 8 || info.size > MAX_BYTES)
      throw new Error("Media must be a regular file of at most 2 GiB");
    const head = Buffer.alloc(16);
    await source.read(head, 0, 16, 0);
    const image = [".png", ".jpg", ".jpeg", ".webp"].includes(extension);
    const valid = image
      ? head
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        (head[0] === 255 && head[1] === 216) ||
        (head.toString("ascii", 0, 4) === "RIFF" &&
          head.toString("ascii", 8, 12) === "WEBP")
      : ["ftyp", "moov", "mdat", "wide"].includes(
          head.toString("ascii", 4, 8),
        ) ||
        (head.toString("ascii", 0, 4) === "RIFF" &&
          head.toString("ascii", 8, 12) === "WAVE") ||
        head.toString("ascii", 0, 4) === "fLaC" ||
        head.toString("ascii", 0, 3) === "ID3" ||
        (head[0] === 255 && (head[1]! & 224) === 224);
    if (!valid) throw new Error("File header is not supported media");
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > MAX_BYTES)
          return callback(new Error("Media exceeds 2 GiB"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      source.createReadStream({ start: 0, autoClose: false }),
      meter,
      createWriteStream(staging, { flags: "wx" }),
      signal ? { signal } : {},
    );
    let durationSec = 0,
      width = 0,
      height = 0;
    let kind: SizzleAsset["kind"];
    if (image) {
      const metadata = await sharp(staging, {
        limitInputPixels: 40_000_000,
      }).metadata();
      width = metadata.width ?? 0;
      height = metadata.height ?? 0;
      if (!width || !height) throw new Error("Image dimensions unavailable");
      kind = "image";
    } else {
      const probe = await probeTimelineMedia(ffmpeg, staging, signal);
      if (!probe.durationSec || probe.durationSec > 86400)
        throw new Error("Media duration must be between zero and 24 hours");
      ({ durationSec, width, height } = probe);
      kind = probe.video ? "video" : "audio";
      if (!probe.video && !probe.audio)
        throw new Error("File has no playable media");
    }
    const asset: SizzleAsset = {
      id: hash.digest("hex"),
      name: basename(path).slice(0, 200),
      kind,
      extension: extension as SizzleAsset["extension"],
      byteSize,
      durationSec,
      width,
      height,
    };
    await rename(staging, timelineAssetPath(root, asset));
    return asset;
  } finally {
    await source.close();
    await unlink(staging).catch(() => undefined);
  }
}

export async function timelineImageData(
  root: string,
  asset: SizzleAsset,
): Promise<string> {
  if (asset.kind !== "image") throw new Error("Expected image asset");
  const png = await sharp(await readFile(timelineAssetPath(root, asset)), {
    limitInputPixels: 40_000_000,
  })
    .rotate()
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}
