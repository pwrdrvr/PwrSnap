import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CameraTrackMetadataSchema,
  type CameraTrackMetadata,
} from "@pwrsnap/shared";

export function cameraDirectory(screenPath: string, captureId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(captureId))
    throw new Error("Invalid capture id");
  return join(dirname(screenPath), `${captureId}.camera`);
}
export function cameraSourceFile(metadata: CameraTrackMetadata): string {
  return metadata.mimeType === "video/mp4" ? "source.mp4" : "source.webm";
}
export async function resolveCameraSource(
  screenPath: string,
  captureId: string,
): Promise<string | null> {
  const dir = cameraDirectory(screenPath, captureId);
  try {
    const parsed = CameraTrackMetadataSchema.safeParse(
      JSON.parse(await readFile(join(dir, "track.json"), "utf8")),
    );
    if (!parsed.success) return null;
    const value = parsed.data;
    const path = join(dir, cameraSourceFile(value));
    return (await stat(path)).isFile() ? path : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function writeCameraManifest(
  dir: string,
  metadata: CameraTrackMetadata,
): Promise<void> {
  await writeFile(join(dir, "track.json.partial"), JSON.stringify(metadata));
  await rename(join(dir, "track.json.partial"), join(dir, "track.json"));
}
export async function moveCameraDirectory(
  fromScreen: string,
  toScreen: string,
  id: string,
): Promise<void> {
  const from = cameraDirectory(fromScreen, id),
    to = cameraDirectory(toScreen, id);
  if (from === to) return;
  try {
    await stat(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true });
  }
}
