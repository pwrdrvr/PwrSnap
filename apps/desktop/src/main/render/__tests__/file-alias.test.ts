import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { prepareRenderedFileAlias } from "../file-alias";

let directory: string;
let source: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pwrsnap-file-alias-"));
  source = join(directory, "render.png");
  await writeFile(source, "original");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("retains the published alias when its replacement cannot be prepared", async () => {
  const alias = await prepareRenderedFileAlias(source, "capture.png");
  await rm(source);
  await expect(prepareRenderedFileAlias(source, "capture.png")).rejects.toThrow();
  expect(await readFile(alias, "utf8")).toBe("original");
  expect(await readdir(dirname(alias))).toEqual(["capture.png"]);
});

test("repeated copies preserve hard links without leaving staging files", async () => {
  const alias = await prepareRenderedFileAlias(source, "capture.png");
  await prepareRenderedFileAlias(source, "capture.png");
  expect((await stat(alias)).ino).toBe((await stat(source)).ino);
  expect(await readdir(dirname(alias))).toEqual(["capture.png"]);
});

test("concurrent readers always see a complete file during alias replacement", async () => {
  const alias = await prepareRenderedFileAlias(source, "capture.png");
  const replacement = "replacement".repeat(8192);
  let reading = true;
  let reads = 0;
  const reader = (async () => {
    while (reading) {
      const value = await readFile(alias, "utf8");
      expect(["original", replacement]).toContain(value);
      reads += 1;
    }
  })();
  // Observe failures immediately while still allowing replacement cleanup.
  const observedReader = reader.catch((error: unknown) => error);
  try {
    for (let index = 0; index < 40; index += 1) {
      const next = join(directory, "next.png");
      await writeFile(next, index % 2 === 0 ? replacement : "original");
      await rename(next, source);
      await prepareRenderedFileAlias(source, "capture.png");
    }
  } finally {
    reading = false;
    expect(await observedReader).toBeUndefined();
  }
  expect(reads).toBeGreaterThan(0);
  expect(await readdir(dirname(alias))).toEqual(["capture.png"]);
});
