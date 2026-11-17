import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTRACT, TARGETS, check, digest, releaseTag, verifyPayload, verifyReleaseManifest } from "./contract.mjs";

export const RELEASE_PIN = JSON.parse(readFileSync(new URL("./release-pin.json", import.meta.url), "utf8"));
export function validatePin(pin) {
  check(!pin.blocked, `dependency publication blocked: ${pin.blocked}`);
  releaseTag(pin.buildSha);
  check(/^[a-f0-9]{64}$/.test(pin.manifestSha256), "missing independently reviewed release manifest SHA-256");
  check(JSON.stringify(Object.keys(pin.archives ?? {}).sort()) === JSON.stringify(Object.keys(TARGETS).sort()), "pin both platform archive digests");
  for (const value of Object.values(pin.archives)) check(/^[a-f0-9]{64}$/.test(value), "missing independently reviewed archive SHA-256");
}
export function gh(argv, options = {}) {
  const result = (options.runner ?? spawnSync)("gh", argv, { encoding: "utf8", env: options.env ?? process.env, windowsHide: true });
  check(!result.error && result.status === 0, `gh ${argv.slice(0, 2).join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
export function verifyReleaseMetadata(release, pin, ref) {
  check(release.tag_name === releaseTag(pin.buildSha) && release.immutable === true && release.draft === false, "release must be published and immutable");
  check(ref.object?.type === "commit" && ref.object.sha === pin.buildSha, "release tag must resolve directly to pinned build source commit");
  const names = ["release-manifest.json", ...Object.keys(TARGETS).map((t) => `ffmpeg-${CONTRACT.version}-${t}.tar.gz`)];
  check(JSON.stringify(release.assets?.map((a) => a.name).sort()) === JSON.stringify(names.sort()), "release asset set mismatch/duplicate");
  for (const a of release.assets) {
    const expected = a.name === "release-manifest.json" ? pin.manifestSha256 : pin.archives[a.name.slice(`ffmpeg-${CONTRACT.version}-`.length, -7)];
    check(a.state === "uploaded" && a.digest === `sha256:${expected}` && Number.isSafeInteger(a.size) && a.size > 0, `release API asset digest/state mismatch: ${a.name}`);
  }
}
export function downloadControlledFfmpeg(target, destination, options = {}) {
  const pin = options.pin ?? RELEASE_PIN;
  validatePin(pin); // Before cache/network/extraction; incomplete pins never succeed.
  check(Object.hasOwn(TARGETS, target), `unsupported target ${target}`);
  const tag = releaseTag(pin.buildSha);
  const api = (path) => JSON.parse(gh(["api", `repos/${CONTRACT.repo}/${path}`], options));
  const release = api(`releases/tags/${tag}`);
  const ref = api(`git/ref/tags/${tag}`);
  verifyReleaseMetadata(release, pin, ref);
  const temp = mkdtempSync(join(options.tempRoot ?? tmpdir(), "pwrsnap-controlled-ffmpeg-"));
  try {
    gh(["release", "download", tag, "--repo", CONTRACT.repo, "--pattern", "release-manifest.json", "--dir", temp], options);
    const bytes = readFileSync(join(temp, "release-manifest.json"));
    check(digest(bytes) === pin.manifestSha256, "release manifest digest mismatch");
    const manifest = verifyReleaseManifest(JSON.parse(bytes), pin.buildSha);
    const asset = manifest.platforms[target];
    // Both archives must be pinned even when consuming one platform.
    for (const t of Object.keys(TARGETS)) check(manifest.platforms[t].sha256 === pin.archives[t], `${t} independent archive digest mismatch`);
    const metadata = release.assets.find((a) => a.name === asset.asset);
    check(metadata.size === asset.size, "release asset size mismatch");
    gh(["release", "download", tag, "--repo", CONTRACT.repo, "--pattern", asset.asset, "--dir", temp], options);
    const archive = join(temp, asset.asset);
    const archiveBytes = readFileSync(archive);
    check(archiveBytes.length === asset.size && digest(archiveBytes) === pin.archives[target], "downloaded archive digest/size mismatch");
    // Extraction only follows an independently reviewed archive hash. The
    // producer packs an exact regular-file allowlist, validated again below.
    mkdirSync(destination, { recursive: true });
    const result = (options.tarRunner ?? spawnSync)("tar", ["-xzf", archive, "-C", destination], { encoding: "utf8", windowsHide: true });
    check(!result.error && result.status === 0, `archive extraction failed: ${result.stderr ?? result.error}`);
    const files = verifyPayload(destination, target);
    check(JSON.stringify(files) === JSON.stringify(asset.files), "payload file digests differ from pinned release manifest");
    if (target === "macos-universal") chmodSync(join(destination, TARGETS[target].binary), 0o755);
    return { directory: destination, releaseManifest: manifest, manifestBytes: bytes };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--check-pin") {
    validatePin(RELEASE_PIN);
    process.exit(0);
  }
  const [target, destination, ...extra] = process.argv.slice(2);
  check(target && destination && extra.length === 0, "usage: node scripts/ffmpeg/download.mjs <target> <empty-destination>");
  downloadControlledFfmpeg(target, destination);
}
