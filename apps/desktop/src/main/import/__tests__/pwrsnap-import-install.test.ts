import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  closeImportArtifact,
  type ImportInstallFileOps,
  publishStagedImport,
  removeImportArtifact,
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
    link: fs.link,
    lstat: (path, options) => fs.lstat(path, options),
    mkdir: fs.mkdir,
    open: fs.open,
    unlink: fs.unlink
  };
}

describe("publishStagedImport", () => {
  test("copies from the verified descriptor after EXDEV", async () => {
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

    const published = await publishStagedImport(stage, destination, ops);
    expect(published.installMode).toBe("copied_cross_volume");
    await expect(fs.readFile(destination)).resolves.toEqual(contents);
    await expect(fs.readFile(stage.path)).resolves.toEqual(contents);
    expect((await fs.readdir(destinationDir)).filter((name) => name.startsWith("."))).toEqual([]);

    await closeImportArtifact(stage);
    await removeImportArtifact(stage);
  });

  test("cleans a partial destination-local descriptor copy and preserves staging", async () => {
    const contents = Buffer.from("validated bundle contents");
    const stage = await writeImportStage(join(workDir, "data"), contents);
    const destinationDir = join(workDir, "captures");
    const destination = join(destinationDir, "capture.pwrsnap");
    const ops = realFileOps();
    ops.link = async (source, target) => {
      if (source === stage.path) {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      }
      await fs.link(source, target);
    };
    const originalOpen = ops.open;
    ops.open = async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (path.includes(".import-") && path.includes("captures")) {
        return new Proxy(handle, {
          get(target, property) {
            if (property === "write") {
              return async () => {
                throw Object.assign(new Error("copy interrupted"), { code: "EIO" });
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
      return handle;
    };

    await expect(publishStagedImport(stage, destination, ops)).rejects.toMatchObject({
      code: "publish_copy_failed"
    });
    await expect(fs.readFile(stage.path)).resolves.toEqual(contents);
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(destinationDir)).filter((name) => name.startsWith("."))).toEqual([]);
    await closeImportArtifact(stage);
    await removeImportArtifact(stage);
  });

  test("refuses to overwrite an existing destination", async () => {
    const stage = await writeImportStage(join(workDir, "data"), Buffer.from("new"));
    const destination = join(workDir, "captures", "capture.pwrsnap");
    await fs.mkdir(join(workDir, "captures"), { recursive: true });
    await fs.writeFile(destination, "existing");

    await expect(publishStagedImport(stage, destination)).rejects.toMatchObject({
      code: "destination_exists"
    });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("existing");
    await closeImportArtifact(stage);
    await removeImportArtifact(stage);
  });

  test("never overwrites a destination created during publication", async () => {
    const stage = await writeImportStage(join(workDir, "data"), Buffer.from("new"));
    const destination = join(workDir, "captures", "capture.pwrsnap");
    const ops = realFileOps();
    ops.link = async (source, target) => {
      await fs.writeFile(destination, "racer", { flag: "wx" });
      await fs.link(source, target);
    };

    await expect(publishStagedImport(stage, destination, ops)).rejects.toMatchObject({
      code: "destination_exists"
    });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("racer");
    await closeImportArtifact(stage);
    await removeImportArtifact(stage);
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
    await closeImportArtifact(stage);
    await removeImportArtifact(stage);
  });

  test("rejects a replaced stage pathname and never publishes replacement bytes", async () => {
    const stage = await writeImportStage(join(workDir, "data"), Buffer.from("verified"));
    const destination = join(workDir, "captures", "capture.pwrsnap");
    const moved = `${stage.path}.original`;
    await fs.rename(stage.path, moved);
    await fs.writeFile(stage.path, "replacement");

    await expect(publishStagedImport(stage, destination)).rejects.toMatchObject({
      code: "stage_identity_changed"
    });
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await closeImportArtifact(stage);
  });

  test("detects a stage swap between verification and the same-volume link", async () => {
    const stage = await writeImportStage(join(workDir, "data"), Buffer.from("verified"));
    const destination = join(workDir, "captures", "capture.pwrsnap");
    const ops = realFileOps();
    ops.link = async (source, target) => {
      await fs.rename(source, `${source}.original`);
      await fs.writeFile(source, "replacement");
      await fs.link(source, target);
    };

    await expect(publishStagedImport(stage, destination, ops)).rejects.toMatchObject({
      code: "publish_identity_changed"
    });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("replacement");
    await closeImportArtifact(stage);
  });

  test("detects a destination-local temp swap before EXDEV publication", async () => {
    const stage = await writeImportStage(join(workDir, "data"), Buffer.from("verified"));
    const destination = join(workDir, "captures", "capture.pwrsnap");
    const ops = realFileOps();
    let linkCalls = 0;
    ops.link = async (source, target) => {
      linkCalls += 1;
      if (linkCalls === 1) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      await fs.rename(source, `${source}.original`);
      await fs.writeFile(source, "replacement");
      await fs.link(source, target);
    };

    await expect(publishStagedImport(stage, destination, ops)).rejects.toMatchObject({
      code: "publish_identity_changed"
    });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("replacement");
    await closeImportArtifact(stage);
    await removeImportArtifact(stage);
  });

  test("identity-bound cleanup refuses to unlink a raced replacement", async () => {
    const stage = await writeImportStage(join(workDir, "data"), Buffer.from("verified"));
    const moved = `${stage.path}.original`;
    await fs.rename(stage.path, moved);
    await fs.writeFile(stage.path, "replacement");

    await expect(removeImportArtifact(stage)).rejects.toMatchObject({
      code: "cleanup_identity_changed"
    });
    await expect(fs.readFile(stage.path, "utf8")).resolves.toBe("replacement");
    await closeImportArtifact(stage);
  });
});
