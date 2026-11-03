import { copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), rename: vi.fn(actual.rename) };
});
import { publishRenderedFile } from "../publish-rendered-file";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let workDir: string;
let source: string;
let destination: string;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(copyFile).mockReset().mockImplementation(actual.copyFile);
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-save-publication-"));
  source = join(workDir, "source.png");
  destination = join(workDir, "chosen.png");
  await writeFile(source, "complete render");
  await writeFile(destination, "previous file");
});
afterEach(async () => { await rm(workDir, { recursive: true, force: true }); });

test("keeps the old destination readable until a complete staged copy is ready", async () => {
  const copying = deferred<string>();
  const release = deferred<void>();
  vi.mocked(copyFile).mockImplementationOnce(async (_source, staged) => {
    const path = String(staged);
    await writeFile(path, "partial");
    copying.resolve(path);
    await release.promise;
    await writeFile(path, "complete render");
  });
  const pending = publishRenderedFile(source, destination);
  const staged = await copying.promise;
  expect(dirname(dirname(staged))).toBe(workDir);
  expect(await readFile(destination, "utf8")).toBe("previous file");
  expect(rename).not.toHaveBeenCalled();
  release.resolve();
  await pending;
  expect(await readFile(destination, "utf8")).toBe("complete render");
  expect((await readdir(workDir)).sort()).toEqual(["chosen.png", "source.png"]);
});

test.each(["copy", "rename"])("a %s failure preserves the destination and removes staging", async (failure) => {
  if (failure === "copy") {
    vi.mocked(copyFile).mockImplementationOnce(async (_source, staged) => {
      await writeFile(staged, "partial");
      throw new Error("copy failed");
    });
  } else {
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename failed"));
  }
  await expect(publishRenderedFile(source, destination)).rejects.toThrow(`${failure} failed`);
  expect(await readFile(destination, "utf8")).toBe("previous file");
  expect((await readdir(workDir)).sort()).toEqual(["chosen.png", "source.png"]);
});
