import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

let segmenter: Promise<ImageSegmenter> | null = null;
self.onmessage = async (
  event: MessageEvent<{ id: number; image: ImageBitmap; base: string }>,
) => {
  const { id, image, base } = event.data;
  try {
    segmenter ??= FilesetResolver.forVisionTasks(`${base}mediapipe`, true).then(
      (files) =>
        ImageSegmenter.createFromOptions(files, {
          baseOptions: {
            modelAssetPath: `${base}models/selfie_segmenter_landscape.tflite`,
            delegate: "CPU",
          },
          runningMode: "IMAGE",
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        }),
    );
    const engine = await segmenter;
    const result = engine.segment(image);
    try {
      const mask = result.confidenceMasks?.[0];
      if (!mask)
        throw new Error("The background removal model returned no mask.");
      const pixels = new Float32Array(mask.getAsFloat32Array());
      self.postMessage(
        { id, width: mask.width, height: mask.height, pixels },
        { transfer: [pixels.buffer] },
      );
    } finally {
      result.close();
    }
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    image.close();
  }
};
