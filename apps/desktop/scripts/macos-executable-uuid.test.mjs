import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { macExecutableIdentity, personalizeMacExecutableUuid, personalizeMacExecutableFile } from "./macos-executable-uuid.mjs";
import afterPack from "./afterpack-sign-appex.mjs";

const packager = {
  appInfo: { id: "com.pwrdrvr.pwrsnap", version: "1.1.6", productFilename: "PwrSnap" },
  config: { electronVersion: "41.10.7" }
};
const identity = macExecutableIdentity(packager);
function thin(cpu = 0x100000c, subtype = 0) {
  const bytes = Buffer.alloc(80, 0xab);
  [0xfeedfacf, cpu, subtype, 2, 1, 24, 0, 0, 0x1b, 24].forEach((n, i) => bytes.writeUInt32LE(n, i * 4));
  return bytes;
}
function fat(wide = false, slices = [thin(), thin(0x1000007, 3)]) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe);
  bytes.writeUInt32BE(slices.length, 4);
  slices.forEach((slice, i) => {
    const entry = 8 + i * (wide ? 32 : 20);
    const offset = 128 + i * 128;
    bytes.writeUInt32BE(slice.readUInt32LE(4), entry);
    bytes.writeUInt32BE(slice.readUInt32LE(8), entry + 4);
    if (wide) {
      bytes.writeBigUInt64BE(BigInt(offset), entry + 8);
      bytes.writeBigUInt64BE(BigInt(slice.length), entry + 16);
      bytes.writeUInt32BE(7, entry + 24);
    } else {
      bytes.writeUInt32BE(offset, entry + 8);
      bytes.writeUInt32BE(slice.length, entry + 12);
      bytes.writeUInt32BE(7, entry + 16);
    }
    slice.copy(bytes, offset);
  });
  return bytes;
}
const uuid = (bytes) => bytes.subarray(40, 56).toString("hex");

describe("macOS main executable UUID", () => {
  test("changes only LC_UUID, leaves input untouched, and is idempotent", () => {
    const source = thin();
    const original = Buffer.from(source);
    const result = personalizeMacExecutableUuid(source, identity);
    expect(source).toEqual(original);
    expect(uuid(result)).not.toBe(uuid(source));
    expect(result.subarray(0, 40)).toEqual(source.subarray(0, 40));
    expect(result.subarray(56)).toEqual(source.subarray(56));
    expect(personalizeMacExecutableUuid(result, identity)).toEqual(result);
    expect(result[46] >> 4).toBe(8);
    expect(result[48] >> 6).toBe(2);
  });
  test("separates apps, app releases, Electron versions and architectures", () => {
    const identities = [identity,
      macExecutableIdentity({ ...packager, appInfo: { ...packager.appInfo, id: "com.pwrdrvr.pwragent" } }),
      macExecutableIdentity({ ...packager, appInfo: { ...packager.appInfo, version: "1.1.7" } }),
      macExecutableIdentity({ ...packager, config: { electronVersion: "42.0.0" } })];
    const values = identities.map((id) => uuid(personalizeMacExecutableUuid(thin(), id)));
    values.push(uuid(personalizeMacExecutableUuid(thin(0x1000007, 3), identity)));
    values.push(uuid(personalizeMacExecutableUuid(thin(0x100000c, 2), identity)));
    expect(new Set(values).size).toBe(6);
  });
  test.each([false, true])("universal wide=%s matches thin slices and repeated merge hooks", (wide) => {
    const slices = [thin(), thin(0x1000007, 3)];
    const source = fat(wide, slices);
    const result = personalizeMacExecutableUuid(source, identity);
    slices.forEach((slice, i) => expect(result.subarray(128 + i * 128, 208 + i * 128))
      .toEqual(personalizeMacExecutableUuid(slice, identity)));
    expect(result.subarray(0, 128)).toEqual(source.subarray(0, 128));
    expect(personalizeMacExecutableUuid(result, identity)).toEqual(result);
    expect(personalizeMacExecutableUuid(fat(wide, slices.map((s) => personalizeMacExecutableUuid(s, identity))), identity)).toEqual(result);
  });
  test.each([
    ["truncated", () => Buffer.alloc(4)],
    ["wrong magic", () => Buffer.alloc(64)],
    ["not executable", () => { const b = thin(); b.writeUInt32LE(6, 12); return b; }],
    ["missing UUID", () => { const b = thin(); b.writeUInt32LE(0x19, 32); return b; }],
    ["duplicate UUID", () => { const b = thin(); b.writeUInt32LE(2, 16); b.writeUInt32LE(48, 20); b.copy(b, 56, 32, 56); return b; }],
    ["short UUID", () => { const b = thin(); b.writeUInt32LE(16, 36); return b; }],
    ["command overrun", () => { const b = thin(); b.writeUInt32LE(80, 36); return b; }],
    ["empty fat", () => { const b = fat(); b.writeUInt32BE(0, 4); return b; }],
    ["overlapping slices", () => { const b = fat(); b.writeUInt32BE(128, 36); return b; }],
    ["slice over table", () => { const b = fat(); b.writeUInt32BE(8, 16); return b; }],
    ["slice out of bounds", () => { const b = fat(); b.writeUInt32BE(500, 16); return b; }],
    ["unsafe fat64 offset", () => { const b = fat(true); b.writeBigUInt64BE(2n ** 60n, 16); return b; }],
    ["architecture mismatch", () => { const b = fat(); b.writeUInt32BE(7, 8); return b; }]
  ])("rejects %s without mutating input", (_name, fixture) => {
    const input = fixture();
    const original = Buffer.from(input);
    expect(() => personalizeMacExecutableUuid(input, identity)).toThrow();
    expect(input).toEqual(original);
  });
  test("requires all identity fields", () => {
    expect(() => macExecutableIdentity({ ...packager, config: {} })).toThrow(/Missing/);
    expect(() => macExecutableIdentity({ ...packager, appInfo: { ...packager.appInfo, id: "" } })).toThrow(/Missing/);
    expect(() => macExecutableIdentity({ ...packager, appInfo: { ...packager.appInfo, version: "" } })).toThrow(/Missing/);
  });
  test("hook patches only staged main executable even without PlugIns, and skips Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "pwrsnap-uuid-"));
    try {
      const contents = join(root, "PwrSnap.app", "Contents");
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await mkdir(join(contents, "Frameworks"));
      const main = join(contents, "MacOS", "PwrSnap");
      const framework = join(contents, "Frameworks", "Electron Framework");
      await writeFile(main, thin(), { mode: 0o755 });
      await writeFile(framework, thin());
      await afterPack({ electronPlatformName: "win32" });
      await afterPack({ electronPlatformName: "darwin", appOutDir: root, packager });
      expect(await readFile(main)).toEqual(personalizeMacExecutableUuid(thin(), identity));
      expect(await readFile(framework)).toEqual(thin());
      const before = await stat(main);
      await personalizeMacExecutableFile(main, identity);
      expect((await stat(main)).mtimeMs).toBe(before.mtimeMs);
      expect((await stat(main)).mode & 0o777).toBe(0o755);
      await writeFile(main, Buffer.alloc(4));
      await expect(afterPack({ electronPlatformName: "darwin", appOutDir: root, packager })).rejects.toThrow();
      expect(await readFile(main)).toEqual(Buffer.alloc(4));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform !== "darwin")("real thin/universal Mach-O stays signable and Apple tools read the new UUID", async () => {
    const root = await mkdtemp(join(tmpdir(), "pwrsnap-uuid-native-"));
    try {
      const source = join(root, "main.c");
      await writeFile(source, "int main(void) { return 0; }\n");
      const outputs = [];
      for (const arch of ["arm64", "x86_64"]) {
        const binary = join(root, arch);
        execFileSync("xcrun", ["clang", "-arch", arch, source, "-o", binary]);
        outputs.push(binary);
      }
      const universal = join(root, "universal");
      execFileSync("xcrun", ["lipo", "-create", ...outputs, "-output", universal]);
      const old = execFileSync("xcrun", ["dwarfdump", "--uuid", universal], { encoding: "utf8" });
      for (const binary of [...outputs, universal]) {
        await personalizeMacExecutableFile(binary, identity);
        execFileSync("codesign", ["--force", "--sign", "-", binary]);
        execFileSync("codesign", ["--verify", "--strict", binary]);
        // Idempotency must also preserve a newly applied signature.
        await personalizeMacExecutableFile(binary, identity);
        execFileSync("codesign", ["--verify", "--strict", binary]);
      }
      const current = execFileSync("xcrun", ["dwarfdump", "--uuid", universal], { encoding: "utf8" });
      expect(current).not.toBe(old);
      for (const binary of outputs) {
        const line = execFileSync("xcrun", ["dwarfdump", "--uuid", binary], { encoding: "utf8" });
        expect(current).toContain(line.split(" ")[1]);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
