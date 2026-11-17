import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS, verifyPayload, verifyReleaseManifest } from "./contract.mjs";
import { TEST_SHA, payloadFixture, releaseFixture } from "./contract-fixtures.mjs";

test("release source, all platform digests, provenance and file inventory are mandatory", () => {
  assert.doesNotThrow(() => verifyReleaseManifest(releaseFixture(), TEST_SHA));
  const mutations = [
    (m) => { m.buildSha = "4".repeat(40); },
    (m) => { m.sourceSha256 = "4".repeat(64); },
    (m) => { m.sourceRun.headSha = "4".repeat(40); },
    (m) => { m.sourceRun.workflow = "untrusted.yml"; },
    (m) => { m.sourceRun.attempt = 0; },
    (m) => { delete m.platforms["macos-universal"]; },
    (m) => { m.platforms["windows-x64"].sha256 = ""; },
    (m) => { delete m.platforms["windows-x64"].files["SOURCE-OFFER.txt"]; },
    (m) => { m.platforms["macos-universal"].files["manifest.json"].size = 0; }
  ];
  for (const mutate of mutations) {
    const m = releaseFixture(); mutate(m);
    assert.throws(() => verifyReleaseManifest(m, TEST_SHA), /Controlled FFmpeg/);
  }
});
for (const target of Object.keys(TARGETS)) {
  test(`${target} rejects license, codec, binary, source and unsafe payload changes`, () => {
    const root = mkdtempSync(join(tmpdir(), "ffmpeg-contract-"));
    try {
      const mutateManifest = (change, error) => {
        const m = payloadFixture(root, target); change(m);
        writeFileSync(join(root, "manifest.json"), JSON.stringify(m));
        assert.throws(() => verifyPayload(root, target), error);
      };
      mutateManifest((m) => { m.forbiddenConfigFlags = []; }, /forbiddenConfigFlags/);
      mutateManifest((m) => { m.configuration += " --enable-gpl"; m.forbiddenConfigFlags = []; }, /forbidden configuration/);
      mutateManifest((m) => { m.requiredDecoders = []; }, /requiredDecoders/);
      mutateManifest((m) => { m.requiredEncoders = []; }, /requiredEncoders/);
      if (target === "windows-x64") mutateManifest((m) => { m.requiredDevices = []; }, /requiredDevices/);
      mutateManifest((m) => { m.pkgConfig = "autodetect"; }, /pkgConfig/);
      mutateManifest((m) => { m.licensePosture = "GPL"; }, /licensePosture/);
      mutateManifest((m) => { m.sourceTarballSha256 = "0".repeat(64); }, /sourceTarballSha256/);
      mutateManifest((m) => { m.sha256 = "0".repeat(64); }, /binary digest/);
      for (const name of ["SOURCE-OFFER.txt", "LGPL-NOTICE.txt"]) {
        payloadFixture(root, target); writeFileSync(join(root, name), "");
        assert.throws(() => verifyPayload(root, target), /incomplete/);
      }
      payloadFixture(root, target);
      assert.throws(() => verifyPayload(root, target), /source archive digest/);
      writeFileSync(join(root, "unexpected"), "bad");
      assert.throws(() => verifyPayload(root, target), /unexpected\/missing/);
      rmSync(join(root, "unexpected"));
      if (process.platform === "win32") return;
      rmSync(join(root, "SOURCE-OFFER.txt"));
      symlinkSync(join(root, "manifest.json"), join(root, "SOURCE-OFFER.txt"));
      assert.throws(() => verifyPayload(root, target), /symlink/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
