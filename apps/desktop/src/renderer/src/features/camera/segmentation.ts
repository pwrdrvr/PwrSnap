export class PersonSegmenter {
  private worker = new Worker(
    new URL("./segmentation.worker.ts", import.meta.url),
    { type: "module" },
  );
  private id = 0;
  private closed = false;
  private pending = new Map<
    number,
    { resolve: (value: ImageData) => void; reject: (error: Error) => void }
  >();
  constructor() {
    this.worker.onmessage = (event) => {
      const { id, width, height, pixels, error } = event.data as {
        id: number;
        width: number;
        height: number;
        pixels: Float32Array;
        error?: string;
      };
      const job = this.pending.get(id);
      if (!job) return;
      this.pending.delete(id);
      if (error) {
        job.reject(new Error(error));
        return;
      }
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < pixels.length; i++) {
        // Keep the soft confidence edge; binary thresholding loses hair/hands.
        const alpha = Math.round(Math.max(0, Math.min(1, pixels[i]!)) * 255);
        rgba.set([alpha, alpha, alpha, 255], i * 4);
      }
      job.resolve(new ImageData(rgba, width, height));
    };
    this.worker.onerror = () => this.close();
  }
  async mask(source: CanvasImageSource): Promise<ImageData> {
    if (this.closed) throw new Error("Background removal stopped.");
    const image = await createImageBitmap(source as ImageBitmapSource);
    if (this.closed) {
      image.close();
      throw new Error("Background removal stopped.");
    }
    const id = ++this.id;
    const result = new Promise<ImageData>((resolve, reject) => {
      const timer = setTimeout(() => this.close(), 10_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
    this.worker.postMessage(
      { id, image, base: new URL("./", document.baseURI).href },
      [image],
    );
    return result;
  }
  close(): void {
    this.closed = true;
    this.worker.terminate();
    for (const job of this.pending.values())
      job.reject(new Error("Background removal stopped."));
    this.pending.clear();
  }
}
