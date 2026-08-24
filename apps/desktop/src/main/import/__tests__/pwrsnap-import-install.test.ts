import { constants, createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  type ImportInstallFileOps,
  publishStagedImport,
  writeImportStage
} from "../pwrsnap-import-install";

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), "pwrsnap-import-install-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

function realFileOps(): ImportInstallFileOps {
  return {
    copyFile: fs.copyFile,
    createReadStream: (path) => createReadStream(path),
    link: fs.link,
    lstat: fs.lstat,
    mkdir: fs.mkdir,
    open: fs.open,
    unlink: fs.unlink
  };
}

describe("publishStagedImport", () => {
  test("uses a destination-local verified copy after EXDEV and cleans staging", async () => {
    const contents = Buffer.from("validated bundle contents");
    const stage = await writeImportStage(join(workDir, "data"), contents);
    const destinationDir = join(workDir, "captures");
    const destination = join(destinationDir, "capture.pwrsnap");
    const ops = realFileOps();
    let linkCalls = 0;
    ops.link = async (source, target) => {
      linkCalls += 1;
      if (linkCalls === 1) {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      }
      await fs.link(source, target);
    };

    await expect(publishStagedImport(stage, destination, ops)).resolves.toBe(
      "copied_cross_volume"
    );
    await expect(fs.readFile(destination)).resolves.toEqual(contents);
    await expect(fs.lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(destinationDir)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("cleans a partial destination-local copy and preserves staging on failure", async () => {
    const contents = Buffer.from("validated bundle contents");
    const stage = await writeImportStage(join(workDir, "data"), contents);
    const destinationDir = join(workDir, "captures");
    const destination = join(destinationDir, "capture.pwrsnap");
    const ops = realFileOps();
    ops.link = async (source, target) => {
      if (source === stage) {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      }
      await fs.link(source, target);
    };
    ops.copyFile = async (source, target, mode) => {
      await fs.copyFile(source, target, mode ?? constants.COPYFILE_EXCL);
      throw Object.assign(new Error("copy interrupted"), { code: "EIO" });
    };

    await expect(publishStagedImport(stage, destination, ops)).rejects.toMatchObject({
      code: "publish_copy_failed"
    });
    await expect(fs.readFile(stage)).resolves.toEqual(contents);
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(destinationDir)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("refuses to overwrite an existing destination", async () => {
    const stage = await writeImportStage(join(workDir, "data"), Buffer.from("new"));
    const destinationDir = join(workDir, "captures");
    const destination = join(destinationDir, "capture.pwrsnap");
    await fs.mkdir(destinationDir, { recursive: true });
    await fs.writeFile(destination, "existing");

    await expect(publishStagedImport(stage, destination)).rejects.toMatchObject({
      code: "destination_exists"
    });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("existing");
    await expect(fs.readFile(stage, "utf8")).resolves.toBe("new");
  });

  test("never overwrites a destination created during the publish race", async () => {
    const stage = await writeImportStage(join(workDir, "data"), Buffer.from("new"));
    const destinationDir = join(workDir, "captures");
    const destination = join(destinationDir, "capture.pwrsnap");
    const ops = realFileOps();
    let linkCalls = 0;
    ops.link = async (source, target) => {
      linkCalls += 1;
      if (linkCalls === 2) {
        await fs.writeFile(destination, "racer", { flag: "wx" });
      }
      await fs.link(source, target);
    };

    await expect(publishStagedImport(stage, destination, ops)).rejects.toMatchObject({
      code: "destination_exists"
    });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("racer");
    expect((await fs.readdir(destinationDir)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("preserves a permission errno for the captures-folder fallback gate", async () => {
    const stage = await writeImportStage(join(workDir, "data"), Buffer.from("new"));
    const destination = join(workDir, "captures", "capture.pwrsnap");
    const ops = realFileOps();
    ops.link = async (_source, target) => {
      throw Object.assign(new Error("Documents denied"), {
        code: "EACCES",
        path: target
      });
    };

    await expect(publishStagedImport(stage, destination, ops)).rejects.toMatchObject({
      code: "EACCES",
      path: expect.stringContaining("captures")
    });
  });

  test("does not retract a published file when staging cleanup is delayed", async () => {
    const contents = Buffer.from("validated bundle contents");
    const stage = await writeImportStage(join(workDir, "data"), contents);
    const destination = join(workDir, "captures", "capture.pwrsnap");
    const ops = realFileOps();
    const originalUnlink = ops.unlink;
    ops.unlink = async (path) => {
      if (path === stage) {
        throw Object.assign(new Error("cleanup delayed"), { code: "EBUSY" });
      }
      await originalUnlink(path);
    };

    await expect(publishStagedImport(stage, destination, ops)).resolves.toBe("renamed");
    await expect(fs.readFile(destination)).resolves.toEqual(contents);
    await expect(fs.readFile(stage)).resolves.toEqual(contents);
  });
});
