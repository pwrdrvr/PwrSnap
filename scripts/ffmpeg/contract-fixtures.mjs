// Tiny synthetic payloads; tests never download or open FFmpeg source code.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTRACT, TARGETS, DECODERS, FORBIDDEN, LICENSE_POSTURE, digest, filesFor, packageName, releaseTag, sourceFile, sourceUrl } from "./contract.mjs";
export const TEST_SHA = "1".repeat(40);
export function releaseFixture() {
  return {
    schemaVersion: 1, ...CONTRACT, buildSha: TEST_SHA, tag: releaseTag(TEST_SHA),
    sourceRun: { id: 123, attempt: 1, headSha: TEST_SHA, workflow: ".github/workflows/build.yml" },
    platforms: Object.fromEntries(Object.keys(TARGETS).map((t) => [t, {
      asset: `${packageName(t)}.tar.gz`, sha256: "2".repeat(64), size: 123,
      files: Object.fromEntries(filesFor(t).map((f) => [f, { sha256: "3".repeat(64), size: 1 }]))
    }]))
  };
}
export function payloadFixture(directory, target) {
  const t = TARGETS[target];
  const m = {
    schemaVersion: 1, packageName: packageName(target), version: CONTRACT.version,
    sourceUrl, sourceSha256: CONTRACT.sourceSha256, sourceTarballSha256: CONTRACT.sourceSha256,
    buildProfile: CONTRACT.buildProfile, pkgConfig: "disabled-shim-v1", platform: t.platform, arch: t.arch, binary: t.binary,
    licensePosture: LICENSE_POSTURE, sha256: digest(Buffer.from("synthetic binary")),
    configuration: "configuration: --disable-autodetect --enable-zlib --disable-network --enable-static --disable-shared",
    forbiddenConfigFlags: [...FORBIDDEN], requiredEncoders: [...t.encoders], requiredDecoders: [...DECODERS], requiredDevices: [...t.devices]
  };
  for (const file of filesFor(target)) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file === t.binary ? "synthetic binary" : "synthetic source archive");
  }
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(directory, "SOURCE-OFFER.txt"), `FFmpeg ${CONTRACT.version} ${t.platform}/${t.arch} ${sourceUrl} ${CONTRACT.sourceSha256} ./source/`);
  writeFileSync(join(directory, "LGPL-NOTICE.txt"), `LGPL ./source/ SOURCE-OFFER.txt ${FORBIDDEN.join(" ")}`);
  writeFileSync(join(directory, `source/${sourceFile}.sha256`), `${CONTRACT.sourceSha256}  ${sourceFile}\n`);
  return m;
}
