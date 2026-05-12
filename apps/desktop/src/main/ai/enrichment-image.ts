import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

export const DEFAULT_ENRICHMENT_IMAGE_MAX_EDGE_PX = 1024;
export const DEFAULT_ENRICHMENT_IMAGE_QUALITY = 75;
export const DEFAULT_ENRICHMENT_IMAGE_MAX_BYTES = 1_000_000;

export type PreparedEnrichmentImage = {
  path: string;
  width: number;
  height: number;
  byteSize: number;
  cleanup: () => Promise<void>;
};

export type PrepareEnrichmentImageOptions = {
  maxEdgePx?: number;
  quality?: number;
  maxBytes?: number;
  tempRoot?: string;
};

export async function prepareEnrichmentImage(
  sourcePath: string,
  options: PrepareEnrichmentImageOptions = {}
): Promise<PreparedEnrichmentImage> {
  const maxEdgePx = options.maxEdgePx ?? DEFAULT_ENRICHMENT_IMAGE_MAX_EDGE_PX;
  const quality = options.quality ?? DEFAULT_ENRICHMENT_IMAGE_QUALITY;
  const maxBytes = options.maxBytes ?? DEFAULT_ENRICHMENT_IMAGE_MAX_BYTES;
  const tempParent = options.tempRoot ?? tmpdir();

  await mkdir(tempParent, { recursive: true });
  const workDir = await mkdtemp(join(tempParent, "pwrsnap-ai-"));
  const outputPath = join(workDir, "capture.jpg");

  try {
    const image = sharp(sourcePath, { limitInputPixels: 80_000_000 }).rotate();
    const metadata = await image.metadata();
    const width = metadata.width ?? maxEdgePx;
    const height = metadata.height ?? maxEdgePx;
    const longestEdge = Math.max(width, height);
    const resize =
      longestEdge > maxEdgePx
        ? {
            width: width >= height ? maxEdgePx : undefined,
            height: height > width ? maxEdgePx : undefined,
            fit: "inside" as const,
            withoutEnlargement: true
          }
        : undefined;

    await image
      .resize(resize)
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toFile(outputPath);

    const outputMetadata = await sharp(outputPath).metadata();
    const outputStat = await stat(outputPath);
    if (outputStat.size > maxBytes) {
      throw new Error(
        `prepared enrichment image exceeds ${maxBytes} byte limit (${outputStat.size})`
      );
    }

    return {
      path: outputPath,
      width: outputMetadata.width ?? 0,
      height: outputMetadata.height ?? 0,
      byteSize: outputStat.size,
      cleanup: async () => {
        await rm(workDir, { force: true, recursive: true });
      }
    };
  } catch (error) {
    await rm(workDir, { force: true, recursive: true });
    throw error;
  }
}
