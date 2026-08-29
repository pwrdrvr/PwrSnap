import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  CaptureExportFormat,
  CaptureExportRequest,
  CaptureExportResult,
  CaptureExportVariant,
  ExportStrategy
} from "@pwrsnap/shared";
import { resolveExportRung } from "@pwrsnap/shared";
import sharp from "sharp";
import { getCaptureById } from "../persistence/captures-repo";
import { getCacheRoot } from "../persistence/paths";
import { ensureEffectiveSrcPath } from "../persistence/source-store";
import { renderViaCoordinator } from "./coordinator";
import { BAKE_PIPELINE_VERSION } from "./compose-tree";

const MAX_EDGE_PX = 16_384;
const MAX_PIXELS = 100_000_000;
const execFile = promisify(execFileCallback);

export class CaptureExportError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "not_an_image"
      | "invalid_dimensions"
      | "invalid_quality"
      | "invalid_scale"
      | "unsupported_format"
      | "export_failed",
    message: string
  ) {
    super(message);
    this.name = "CaptureExportError";
  }
}

export async function exportCapture(
  request: CaptureExportRequest,
  exportStrategy: ExportStrategy = "legacy"
): Promise<CaptureExportResult> {
  const record = getCaptureById(request.captureId);
  if (record === null || record.deleted_at !== null) {
    throw new CaptureExportError("not_found", `capture not found: ${request.captureId}`);
  }
  if (record.kind !== "image") {
    throw new CaptureExportError("not_an_image", "image export only supports image captures");
  }
  const variant = request.variant ?? "composite";
  const format = request.format ?? "png";
  const quality = normalizeQuality(request.quality);
  const presetWidth = resolvePresetWidth(request, record, exportStrategy);
  const scale = normalizeScale(request.preset === undefined ? request.scale : undefined);
  if (format === "heic" && process.platform !== "darwin") {
    throw new CaptureExportError(
      "unsupported_format",
      "HEIC export is available only on supported macOS installations"
    );
  }
  const dimensions = resolveDimensions({
    width: record.width_px,
    height: record.height_px,
    scale,
    ...(presetWidth !== undefined
      ? { maxWidth: presetWidth }
      : request.maxWidth !== undefined
        ? { maxWidth: request.maxWidth }
        : {}),
    ...(request.maxHeight !== undefined ? { maxHeight: request.maxHeight } : {})
  });
  const normalized = {
    captureId: record.id,
    variant,
    format,
    widthPx: dimensions.width,
    heightPx: dimensions.height,
    quality,
    background: request.background ?? "#ffffff",
    sourceHash: record.sha256,
    editsVersion: variant === "composite" ? record.edits_version : 0,
    // A composite export IS bake output, so it has to re-key when the
    // bake pipeline changes — same reason `computeTreeRenderHash`
    // hashes the version. Without this the cached file below outlives
    // a BAKE_PIPELINE_VERSION bump forever: `edits_version` only moves
    // when the user edits, so an untouched capture keeps returning
    // pre-bump pixels while every composeV2 surface (clipboard,
    // Library thumbnails) renders the new ones. `original` exports
    // bypass the compositor, so they stay keyed without it.
    pipelineVersion: variant === "composite" ? BAKE_PIPELINE_VERSION : ""
  };
  const exportId = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 32);
  const extension = extensionFor(format);
  const outputDir = join(getCacheRoot(), "local-agent-exports", record.id);
  const outputPath = join(outputDir, `${exportId}.${extension}`);
  try {
    const cached = await statExport(outputPath);
    if (cached !== null) {
      return {
        captureId: record.id,
        variant,
        format,
        ...(request.preset !== undefined ? { preset: request.preset } : {}),
        path: outputPath,
        mimeType: mimeTypeFor(format),
        widthPx: dimensions.width,
        heightPx: dimensions.height,
        byteSize: cached,
        fromCache: true,
        exportId
      };
    }

    const inputPath =
      variant === "original"
        ? await ensureEffectiveSrcPath(record)
        : (
            await renderViaCoordinator({
              captureId: record.id,
              srcPath: await ensureEffectiveSrcPath(record),
              imageWidthPx: record.width_px,
              imageHeightPx: record.height_px,
              width: Math.min(record.width_px, dimensions.width),
              format: "png"
            })
          ).cachePath;
    const bytes = await encodeImage({
      inputPath,
      format,
      width: dimensions.width,
      height: dimensions.height,
      quality,
      background: request.background ?? "#ffffff"
    });
    await mkdir(outputDir, { recursive: true });
    const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, bytes, { mode: 0o600 });
      await rename(tempPath, outputPath);
    } catch (cause) {
      await unlink(tempPath).catch(() => undefined);
      throw cause;
    }
    return {
      captureId: record.id,
      variant,
      format,
      ...(request.preset !== undefined ? { preset: request.preset } : {}),
      path: outputPath,
      mimeType: mimeTypeFor(format),
      widthPx: dimensions.width,
      heightPx: dimensions.height,
      byteSize: bytes.length,
      fromCache: false,
      exportId
    };
  } catch (cause) {
    if (cause instanceof CaptureExportError) throw cause;
    throw new CaptureExportError(
      "export_failed",
      cause instanceof Error ? cause.message : String(cause)
    );
  }
}

function resolvePresetWidth(
  request: CaptureExportRequest,
  record: {
    width_px: number;
    height_px: number;
    device_pixel_ratio: number;
  },
  strategy: ExportStrategy
): number | undefined {
  if (request.preset === undefined) return undefined;
  if (
    request.maxWidth !== undefined ||
    request.maxHeight !== undefined ||
    request.scale !== undefined
  ) {
    throw new CaptureExportError(
      "invalid_dimensions",
      "preset cannot be combined with maxWidth, maxHeight, or scale"
    );
  }
  return resolveExportRung(
    {
      widthPx: record.width_px,
      heightPx: record.height_px,
      devicePixelRatio: record.device_pixel_ratio
    },
    strategy,
    request.preset
  )?.widthPx;
}

async function encodeImage(args: {
  inputPath: string;
  format: CaptureExportFormat;
  width: number;
  height: number;
  quality: number;
  background: string;
}): Promise<Buffer> {
  let image = sharp(args.inputPath).resize({
    width: args.width,
    height: args.height,
    fit: "fill"
  });
  if (args.format === "jpeg" || args.format === "pdf" || args.format === "heic") {
    image = image.flatten({ background: args.background });
  }
  switch (args.format) {
    case "png":
      return image.png({ compressionLevel: 9 }).toBuffer();
    case "jpeg":
      return image.jpeg({ quality: args.quality, mozjpeg: true }).toBuffer();
    case "webp":
      return image.webp({ quality: args.quality }).toBuffer();
    case "heic":
      return encodeHeicWithSips(
        await image.png({ compressionLevel: 9 }).toBuffer(),
        args.quality
      );
    case "pdf": {
      const jpeg = await image.jpeg({ quality: args.quality, mozjpeg: true }).toBuffer();
      return singleImagePdf(jpeg, args.width, args.height);
    }
  }
}

async function encodeHeicWithSips(png: Buffer, quality: number): Promise<Buffer> {
  if (process.platform !== "darwin") {
    throw new CaptureExportError(
      "unsupported_format",
      "HEIC export is available only on supported macOS installations"
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-heic-"));
  const inputPath = join(dir, "input.png");
  const outputPath = join(dir, "output.heic");
  try {
    await writeFile(inputPath, png, { mode: 0o600 });
    await execFile(
      "/usr/bin/sips",
      [
        "-s",
        "format",
        "heic",
        "-s",
        "formatOptions",
        String(quality),
        inputPath,
        "--out",
        outputPath
      ],
      { timeout: 30_000 }
    );
    return await readFile(outputPath);
  } catch (cause) {
    throw new CaptureExportError(
      "unsupported_format",
      `HEIC export is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function resolveDimensions(args: {
  width: number;
  height: number;
  scale: number;
  maxWidth?: number;
  maxHeight?: number;
}): { width: number; height: number } {
  const maxWidth = normalizeOptionalDimension(args.maxWidth, "maxWidth");
  const maxHeight = normalizeOptionalDimension(args.maxHeight, "maxHeight");
  let width = args.width * args.scale;
  let height = args.height * args.scale;
  const ratio = Math.min(
    1,
    maxWidth === undefined ? 1 : maxWidth / width,
    maxHeight === undefined ? 1 : maxHeight / height
  );
  width = Math.max(1, Math.round(width * ratio));
  height = Math.max(1, Math.round(height * ratio));
  if (width > MAX_EDGE_PX || height > MAX_EDGE_PX || width * height > MAX_PIXELS) {
    throw new CaptureExportError(
      "invalid_dimensions",
      `export dimensions exceed ${MAX_EDGE_PX}px per edge or ${MAX_PIXELS} pixels`
    );
  }
  return { width, height };
}

function normalizeOptionalDimension(
  value: number | undefined,
  name: string
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 1 || value > MAX_EDGE_PX) {
    throw new CaptureExportError(
      "invalid_dimensions",
      `${name} must be between 1 and ${MAX_EDGE_PX}`
    );
  }
  return Math.floor(value);
}

function normalizeScale(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value) || value < 0.05 || value > 4) {
    throw new CaptureExportError("invalid_scale", "scale must be between 0.05 and 4");
  }
  return value;
}

function normalizeQuality(value: number | undefined): number {
  if (value === undefined) return 85;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new CaptureExportError("invalid_quality", "quality must be an integer from 1 to 100");
  }
  return value;
}

function extensionFor(format: CaptureExportFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function mimeTypeFor(format: CaptureExportFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "heic":
      return "image/heic";
  }
}

async function statExport(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function singleImagePdf(jpeg: Buffer, width: number, height: number): Buffer {
  const content = Buffer.from(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`, "ascii");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
      "ascii"
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
          `/Length ${jpeg.length} >>\nstream\n`,
        "ascii"
      ),
      jpeg,
      Buffer.from("\nendstream", "ascii")
    ]),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "ascii"),
      content,
      Buffer.from("endstream", "ascii")
    ])
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  let offset = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const framed = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "ascii"),
      object,
      Buffer.from("\nendobj\n", "ascii")
    ]);
    chunks.push(framed);
    offset += framed.length;
  });
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`,
    `startxref\n${xrefOffset}\n%%EOF\n`
  ].join("");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}
