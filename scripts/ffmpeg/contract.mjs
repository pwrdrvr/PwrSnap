import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Owned build-harness contract only. Never reads/extracts FFmpeg source code.
export const CONTRACT = Object.freeze({
  repo: "pwrdrvr/pwrsnap-ffmpeg-builds",
  version: "8.1.1",
  sourceSha256: "b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3",
  buildProfile: "pwrsnap-lgpl-clean-v1"
});
export const TARGETS = Object.freeze({
  "macos-universal": { platform: "macos", arch: "universal", binary: "ffmpeg", encoders: ["h264_videotoolbox", "aac"], devices: [] },
  "windows-x64": { platform: "windows", arch: "x64", binary: "ffmpeg.exe", encoders: ["h264_mf", "aac"], devices: ["gdigrab"] }
});
export const DECODERS = ["png", "mjpeg", "h264", "aac", "mp3"];
export const FORBIDDEN = ["--enable-gpl", "--enable-nonfree", "--enable-libx264", "--enable-libx265", "--enable-libvidstab", "--enable-libfdk-aac"];
export const LICENSE_POSTURE = "LGPL-clean FFmpeg build profile: no GPL, no nonfree, no libx264/libx265/libvidstab/libfdk-aac.";
export const sourceFile = `ffmpeg-${CONTRACT.version}.tar.xz`;
export const sourceUrl = `https://ffmpeg.org/releases/${sourceFile}`;
export const packageName = (target) => `ffmpeg-${CONTRACT.version}-${target}`;
export const releaseTag = (sha) => {
  check(/^[a-f0-9]{40}$/.test(sha), "invalid build source commit SHA");
  return `ffmpeg-build-${sha}`;
};
export function check(condition, message) {
  if (!condition) throw new Error(`Controlled FFmpeg: ${message}`);
}
export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function filesFor(target) {
  check(Object.hasOwn(TARGETS, target), `unsupported target ${target}`);
  return [TARGETS[target].binary, "manifest.json", "SOURCE-OFFER.txt", "LGPL-NOTICE.txt", `source/${sourceFile}`, `source/${sourceFile}.sha256`].sort();
}
export function inventory(directory, prefix = "") {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const relative = `${prefix}${name}`;
    const stat = lstatSync(path);
    check(!stat.isSymbolicLink(), `symlink forbidden: ${relative}`);
    if (stat.isDirectory()) return inventory(path, `${relative}/`);
    check(stat.isFile() && stat.nlink === 1, `non-regular or hard-linked file: ${relative}`);
    return [relative];
  }).sort();
}
export function verifyPayload(directory, target) {
  const expected = filesFor(target);
  check(JSON.stringify(inventory(directory)) === JSON.stringify(expected), `unexpected/missing payload files for ${target}`);
  const read = (name) => readFileSync(join(directory, name));
  const m = JSON.parse(read("manifest.json"));
  const t = TARGETS[target];
  for (const [key, value] of Object.entries({ schemaVersion: 1, packageName: packageName(target), version: CONTRACT.version, sourceUrl, sourceSha256: CONTRACT.sourceSha256, sourceTarballSha256: CONTRACT.sourceSha256, buildProfile: CONTRACT.buildProfile, pkgConfig: "disabled-shim-v1", platform: t.platform, arch: t.arch, binary: t.binary, licensePosture: LICENSE_POSTURE })) {
    check(m[key] === value, `${target} manifest ${key} mismatch`);
  }
  check(typeof m.configuration === "string" && m.configuration.length > 0, "missing configuration");
  for (const flag of FORBIDDEN) check(!m.configuration.includes(flag), `forbidden configuration ${flag}`);
  for (const flag of ["--disable-autodetect", "--enable-zlib", "--disable-network", "--enable-static", "--disable-shared"]) {
    check(m.configuration.split(/\s+/).includes(flag), `missing configuration ${flag}`);
  }
  for (const [key, values] of Object.entries({ requiredEncoders: t.encoders, requiredDecoders: DECODERS, requiredDevices: t.devices, forbiddenConfigFlags: FORBIDDEN })) {
    check(Array.isArray(m[key]) && values.every((v) => m[key].includes(v)), `incomplete ${key} contract`);
  }
  check(m.sha256 === digest(read(t.binary)), `${target} binary digest mismatch`);
  const offer = read("SOURCE-OFFER.txt").toString();
  for (const text of [`FFmpeg ${CONTRACT.version}`, `${t.platform}/${t.arch}`, sourceUrl, CONTRACT.sourceSha256, "./source/"]) check(offer.includes(text), `incomplete source offer: ${text}`);
  const notice = read("LGPL-NOTICE.txt").toString();
  for (const text of ["LGPL", "./source/", "SOURCE-OFFER.txt", ...FORBIDDEN.slice(0, 2), "libx264", "libx265", "libvidstab", "libfdk-aac"]) check(notice.includes(text), `incomplete LGPL notice: ${text}`);
  check(digest(read(`source/${sourceFile}`)) === CONTRACT.sourceSha256, "source archive digest mismatch");
  check(read(`source/${sourceFile}.sha256`).toString().trim() === `${CONTRACT.sourceSha256}  ${sourceFile}`, "source checksum mismatch");
  return Object.fromEntries(expected.map((file) => {
    const bytes = read(file);
    return [file, { sha256: digest(bytes), size: bytes.length }];
  }));
}
export function verifyReleaseManifest(manifest, sha) {
  check(manifest.schemaVersion === 1 && manifest.buildSha === sha && manifest.tag === releaseTag(sha), "release source identity mismatch");
  for (const [key, value] of Object.entries(CONTRACT)) check(manifest[key] === value, `release ${key} mismatch`);
  const run = manifest.sourceRun;
  check(run && Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.attempt) && run.attempt > 0 && run.headSha === sha && run.workflow === ".github/workflows/build.yml", "invalid build provenance");
  check(JSON.stringify(Object.keys(manifest.platforms ?? {}).sort()) === JSON.stringify(Object.keys(TARGETS).sort()), "release must contain every supported platform");
  for (const target of Object.keys(TARGETS)) {
    const p = manifest.platforms[target];
    check(p.asset === `${packageName(target)}.tar.gz` && /^[a-f0-9]{64}$/.test(p.sha256) && Number.isSafeInteger(p.size) && p.size > 0, `invalid ${target} asset`);
    check(JSON.stringify(Object.keys(p.files ?? {}).sort()) === JSON.stringify(filesFor(target)), `incomplete ${target} release inventory`);
    for (const file of Object.values(p.files)) check(/^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.size) && file.size > 0, "invalid file digest/size");
  }
  return manifest;
}
