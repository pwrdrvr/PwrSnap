import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  cameraDirectory,
  moveCameraDirectory,
  resolveCameraSource,
  writeCameraManifest,
} from "../camera-track-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("camera sources survive source rename, trash and restore byte-for-byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "pwrsnap-camera-test-"));
  roots.push(root);
  const screen = join(root, "captures", "renamable.mp4"),
    trash = join(root, "trash", "cap-1.mp4");
  const dir = cameraDirectory(screen, "cap-1");
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from("original camera source bytes");
  await writeFile(join(dir, "source.webm"), bytes);
  await writeCameraManifest(dir, {
    version: 1,
    durationSec: 3,
    width: 640,
    height: 480,
    offsetSec: -2,
    sha256: "b".repeat(64),
    mimeType: "video/webm",
  });
  expect(
    await resolveCameraSource(join(root, "captures", "renamed.mp4"), "cap-1"),
  ).toBe(join(dir, "source.webm"));
  await moveCameraDirectory(screen, trash, "cap-1");
  expect(await resolveCameraSource(screen, "cap-1")).toBeNull();
  expect(await readFile((await resolveCameraSource(trash, "cap-1"))!)).toEqual(
    bytes,
  );
  await moveCameraDirectory(trash, screen, "cap-1");
  expect(await readFile((await resolveCameraSource(screen, "cap-1"))!)).toEqual(
    bytes,
  );
  expect(() => cameraDirectory(screen, "../escape")).toThrow(
    "Invalid capture id",
  );
});
