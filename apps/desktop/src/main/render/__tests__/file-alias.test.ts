import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { prepareRenderedFileAlias } from "../file-alias";

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let directory: string;
let source: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pwrsnap-file-alias-"));
  source = join(directory, "render.png");
  await writeFile(source, "original");
});

afterEach(async () => {
  vi.mocked(rename).mockReset();
  vi.mocked(rename).mockImplementation(actualFs.rename);
  await rm(directory, { recursive: true, force: true });
});

test("retries transient sharing conflicts without removing the published alias", async () => {
  const alias = await prepareRenderedFileAlias(source, "capture.png");
  const next = join(directory, "next.png");
  await writeFile(next, "replacement");
  await actualFs.rename(next, source);
  vi.mocked(rename).mockClear();
  for (const code of ["EPERM", "EACCES"]) {
    vi.mocked(rename).mockImplementationOnce(async () => {
      expect(await readFile(alias, "utf8")).toBe("original");
      throw Object.assign(new Error("sharing conflict"), { code });
    });
  }
  await prepareRenderedFileAlias(source, "capture.png");
  expect(rename).toHaveBeenCalledTimes(3);
  expect(await readFile(alias, "utf8")).toBe("replacement");
  expect(await readdir(dirname(alias))).toEqual(["capture.png"]);
});

test("bounds persistent permission failures, preserves the alias, and recovers after release", async () => {
  const alias = await prepareRenderedFileAlias(source, "capture.png");
  const next = join(directory, "next.png");
  await writeFile(next, "replacement");
  await actualFs.rename(next, source);
  const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });
  vi.mocked(rename).mockClear();
  vi.mocked(rename).mockRejectedValue(denied);
  await expect(prepareRenderedFileAlias(source, "capture.png")).rejects.toBe(denied);
  expect(rename).toHaveBeenCalledTimes(6);
  expect(await readFile(alias, "utf8")).toBe("original");
  expect(await readdir(dirname(alias))).toEqual(["capture.png"]);
  vi.mocked(rename).mockImplementation(actualFs.rename);
  await prepareRenderedFileAlias(source, "capture.png");
  expect(await readFile(alias, "utf8")).toBe("replacement");
  expect(await readdir(dirname(alias))).toEqual(["capture.png"]);
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
  let published = "original";
  const reader = (async () => {
    while (reading) {
      const value = await readFile(alias, "utf8");
      expect(["original", replacement]).toContain(value);
      reads += 1;
      // This gap reduces contention but cannot guarantee that Windows will
      // release every sharing lock within the publisher's bounded retry budget.
      await delay(1);
    }
  })();
  // Observe failures immediately while still allowing replacement cleanup.
  const observedReader = reader.catch((error: unknown) => error);
  try {
    for (let index = 0; index < 40; index += 1) {
      const next = join(directory, "next.png");
      const content = index % 2 === 0 ? replacement : "original";
      await writeFile(next, content);
      await rename(next, source);
      try {
        await prepareRenderedFileAlias(source, "capture.png");
        published = content;
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) {
          throw cause;
        }
        // Continuous readers may exhaust the documented 310ms sharing-lock
        // budget. That failure must preserve the last published bytes and
        // clean staging files, not turn the atomicity test into a timing bet.
        expect(await readFile(alias, "utf8")).toBe(published);
        expect(await readdir(dirname(alias))).toEqual(["capture.png"]);
        break;
      }
    }
  } finally {
    reading = false;
    expect(await observedReader).toBeUndefined();
  }
  expect(reads).toBeGreaterThan(0);
  // With readers drained, publication MUST succeed. Permanent permission or
  // replacement bugs cannot hide behind the allowed contention outcome above.
  await prepareRenderedFileAlias(source, "capture.png");
  expect(await readFile(alias, "utf8")).toBe(await readFile(source, "utf8"));
  expect(await readdir(dirname(alias))).toEqual(["capture.png"]);
});
