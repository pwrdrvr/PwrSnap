import type { SizzleTimeline, SizzleTimelineLayer } from "./sizzle-timeline";

const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const escape = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;

export function sizzleEase(
  p: number,
  easing: "linear" | "ease-in-out" | "ease-out",
): number {
  const n = clamp(p);
  return easing === "linear"
    ? n
    : easing === "ease-out"
      ? 1 - (1 - n) ** 3
      : n < 0.5
        ? 4 * n ** 3
        : 1 - (-2 * n + 2) ** 3 / 2;
}

function glyphs(
  layer: Extract<
    SizzleTimelineLayer,
    { kind: "text" | "typing" | "counter" | "terminal" }
  >,
  value: string,
  x = 0,
  y = 0,
  fill = layer.color,
): string {
  const anchor =
    layer.align === "center"
      ? "middle"
      : layer.align === "right"
        ? "end"
        : "start";
  const offset =
    layer.align === "center"
      ? layer.width / 2
      : layer.align === "right"
        ? layer.width
        : 0;
  return value
    .split("\n")
    .map(
      (line, index) =>
        `<text x="${x + offset}" y="${y + layer.fontSize + index * layer.fontSize * layer.lineHeight}" text-anchor="${anchor}" font-family="${escape(layer.fontFamily)}" font-size="${layer.fontSize}" font-weight="${layer.fontWeight}" fill="${fill}" xml:space="preserve">${escape(line)}</text>`,
    )
    .join("");
}

/** Pure absolute-frame renderer, shared by frame QA and the movie encoder.
 * Media URIs are supplied by the trusted preparation stage, never by a manifest.
 * IDs, text and numbers from the manifest cannot inject SVG/HTML or execute code. */
export function sizzleSceneSvg(args: {
  scene: SizzleTimeline["scenes"][number];
  frame: number;
  width: number;
  height: number;
  outputWidth?: number;
  outputHeight?: number;
  media: ReadonlyMap<string, string>;
}): string {
  const { scene, frame, width, height, media } = args;
  if (!Number.isInteger(frame) || frame < 0 || frame >= scene.durationFrames)
    throw new Error("Frame lies outside scene");
  const layers = scene.layers
    .map((layer, index) => {
      const end = layer.endFrame ?? scene.durationFrames;
      if (frame < layer.startFrame || frame >= end) return "";
      const local = frame - layer.startFrame;
      const duration = end - layer.startFrame;
      const progress = clamp(local / Math.max(1, duration - 1));
      let opacity = Math.min(
        layer.fadeInFrames ? clamp(local / layer.fadeInFrames) : 1,
        layer.fadeOutFrames
          ? clamp((end - 1 - frame) / layer.fadeOutFrames)
          : 1,
      );
      let transform = `translate(${layer.x} ${layer.y})`;
      if (layer.motion) {
        const { from, to, startFrame, endFrame, easing } = layer.motion;
        const p = sizzleEase(
          (local - startFrame) / (endFrame - startFrame),
          easing,
        );
        const scale = lerp(from.scale, to.scale, p);
        opacity *= lerp(from.opacity, to.opacity, p);
        transform += ` translate(${lerp(from.x, to.x, p)} ${lerp(from.y, to.y, p)}) translate(${layer.width / 2} ${layer.height / 2}) rotate(${lerp(from.rotation, to.rotation, p)}) scale(${scale}) translate(${-layer.width / 2} ${-layer.height / 2})`;
      }
      let body: string;
      if (layer.kind === "rect") {
        body = `<rect width="${layer.width}" height="${layer.height}" rx="${layer.radius}" fill="${layer.fill}" stroke="${layer.stroke ?? "none"}" stroke-width="${layer.strokeWidth}"/>`;
      } else if (layer.kind === "text") {
        body = glyphs(layer, layer.text);
      } else if (layer.kind === "counter") {
        const p = sizzleEase(
          layer.countFrames ? local / layer.countFrames : 1,
          "ease-in-out",
        );
        // Bindings were resolved before this pure renderer is called.
        if (typeof layer.from !== "number" || typeof layer.to !== "number")
          throw new Error("Unresolved counter binding");
        body = glyphs(
          layer,
          `${layer.prefix}${Math.round(lerp(layer.from, layer.to, p)).toLocaleString("en-US")}${layer.suffix}`,
        );
      } else if (layer.kind === "typing") {
        const chars = Array.from(layer.text);
        const count = Math.floor(
          chars.length *
            (layer.revealFrames ? clamp(local / layer.revealFrames) : 1),
        );
        body = glyphs(
          layer,
          chars.slice(0, count).join("") +
            (layer.caret && Math.floor(local / 10) % 2 === 0 ? "▍" : ""),
        );
      } else if (layer.kind === "terminal") {
        body =
          `<rect width="${layer.width}" height="${layer.height}" rx="18" fill="${layer.fill}"/>` +
          layer.lines
            .map((line, i) => {
              const at = local - i * layer.lineDelayFrames;
              if (at < 0) return "";
              const chars = Array.from(line.text);
              return glyphs(
                layer,
                chars
                  .slice(
                    0,
                    Math.floor(
                      chars.length *
                        (layer.revealFrames
                          ? clamp(at / layer.revealFrames)
                          : 1),
                    ),
                  )
                  .join(""),
                layer.padding,
                layer.padding + i * layer.fontSize * layer.lineHeight,
                line.color,
              );
            })
            .join("");
      } else {
        const uri = media.get(layer.id);
        if (
          !uri ||
          !/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=]+$/.test(uri)
        )
          throw new Error(`Missing prepared media: ${layer.id}`);
        const zoom = lerp(
          layer.zoomFrom,
          layer.zoomTo,
          sizzleEase(progress, "ease-in-out"),
        );
        const clip = `clip${index}`;
        const wipe = layer.wipeFrames
          ? layer.width * clamp(local / layer.wipeFrames)
          : layer.width;
        body = `<defs><clipPath id="${clip}"><rect width="${wipe}" height="${layer.height}" rx="${layer.radius}"/></clipPath></defs><g clip-path="url(#${clip})"><image href="${uri}" width="${layer.width}" height="${layer.height}" preserveAspectRatio="xMidYMid ${layer.fit === "cover" ? "slice" : "meet"}" transform="translate(${layer.width * layer.focusX * (1 - zoom)} ${layer.height * layer.focusY * (1 - zoom)}) scale(${zoom})"/></g>`;
      }
      return `<g transform="${transform}" opacity="${opacity}">${body}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${args.outputWidth ?? width}" height="${args.outputHeight ?? height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${scene.background}"/>${layers}</svg>`;
}
