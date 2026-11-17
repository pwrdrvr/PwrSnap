import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT, digest, releaseTag } from "./contract.mjs";
import { TEST_SHA, releaseFixture } from "./contract-fixtures.mjs";
import { RELEASE_PIN, downloadControlledFfmpeg, validatePin, verifyReleaseMetadata } from "./download.mjs";
const manifest = releaseFixture();
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const pin = { buildSha: TEST_SHA, manifestSha256: digest(bytes), archives: { "macos-universal": "2".repeat(64), "windows-x64": "2".repeat(64) } };
const metadata = () => ({ tag_name: releaseTag(TEST_SHA), immutable: true, draft: false, assets: [
  { name: "release-manifest.json", state: "uploaded", digest: `sha256:${pin.manifestSha256}`, size: bytes.length },
  ...Object.values(manifest.platforms).map((p) => ({ name: p.asset, state: "uploaded", digest: `sha256:${p.sha256}`, size: p.size }))
] });
const ref = () => ({ object: { type: "commit", sha: TEST_SHA } });
describe("durable controlled dependency download", () => {
  test("incomplete publication blocks before any network or extraction", () => {
    if (RELEASE_PIN.blocked) expect(() => validatePin(RELEASE_PIN)).toThrow(/publication blocked/);
    const runner = vi.fn(); const tarRunner = vi.fn();
    expect(() => downloadControlledFfmpeg("windows-x64", "unused", { pin: { blocked: "producer assets not published" }, runner, tarRunner })).toThrow(/producer assets not published/);
    expect(runner).not.toHaveBeenCalled(); expect(tarRunner).not.toHaveBeenCalled();
    expect(() => validatePin({ ...pin, archives: { "windows-x64": pin.archives["windows-x64"] } })).toThrow(/both platform/);
  });
  test("requires immutable publication, exact tag commit and independent API digests", () => {
    expect(() => verifyReleaseMetadata(metadata(), pin, ref())).not.toThrow();
    for (const change of [
      (r) => { r.immutable = false; }, (r) => { r.draft = true; },
      (r) => { r.assets.pop(); }, (r) => { r.assets.push(r.assets[0]); },
      (r) => { r.assets[0].digest = "sha256:" + "0".repeat(64); },
      (r) => { r.assets[1].state = "new"; }
    ]) {
      const r = metadata(); change(r);
      expect(() => verifyReleaseMetadata(r, pin, ref())).toThrow(/Controlled FFmpeg/);
    }
    expect(() => verifyReleaseMetadata(metadata(), pin, { object: { type: "commit", sha: "0".repeat(40) } })).toThrow(/pinned build/);
    expect(() => verifyReleaseMetadata(metadata(), pin, { object: { type: "tag", sha: TEST_SHA } })).toThrow(/directly/);
  });
  test.each(["manifest", "archive"])("tampered %s stops before extraction with no Actions fallback", (tamper) => {
    const temp = mkdtempSync(join(tmpdir(), "ffmpeg-download-"));
    const calls = []; const tarRunner = vi.fn();
    const runner = vi.fn((_program, argv) => {
      calls.push(argv);
      if (argv[0] === "api") return { status: 0, stdout: JSON.stringify(argv[1].includes("git/ref") ? ref() : metadata()) };
      expect(argv.slice(0, 2)).toEqual(["release", "download"]);
      expect(argv).toContain(CONTRACT.repo);
      const name = argv[argv.indexOf("--pattern") + 1];
      const dir = argv[argv.indexOf("--dir") + 1];
      writeFileSync(join(dir, name), name === "release-manifest.json" && tamper !== "manifest" ? bytes : "tampered");
      return { status: 0, stdout: "" };
    });
    try {
      expect(() => downloadControlledFfmpeg("windows-x64", join(temp, "payload"), { pin, tempRoot: temp, runner, tarRunner })).toThrow(tamper === "manifest" ? /manifest digest/ : /archive digest\/size/);
      expect(tarRunner).not.toHaveBeenCalled();
      expect(calls.some((a) => a[0] === "run")).toBe(false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
