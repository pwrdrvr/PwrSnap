import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  __buildPrivilegedPrefixesForTest,
  __buildLexicalOnlyPrivilegedPrefixesForTest,
  __buildPrivilegedPolicyForTest,
  __canonicalDarwinTempDirForTest,
  __isExpectedDarwinTempDirForTest,
  __isPrivilegedPathForTest,
  __setPrivilegedPrefixesForTest,
  __setPrivilegedRootRealpathForTest,
  readSafePastedFile,
  UnsafePastedFileError
} from "../assertSafePastedFile";
import { __setVerifiedFileBeforeOpenHookForTest } from "../verified-file";
import { normalizeWindowsPathForPolicy } from "../windows-path";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pwrsnap-paste-test-"));
});

afterEach(async () => {
  __setVerifiedFileBeforeOpenHookForTest(null);
  __setPrivilegedPrefixesForTest(null);
  __setPrivilegedRootRealpathForTest(null);
  await rm(dir, { recursive: true, force: true });
});

describe("safe pasted files", () => {
  test("normal regular file returns the bytes read from the verified handle", async () => {
    const file = join(dir, "ok.png");
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(file, expected);
    await expect(readSafePastedFile(file)).resolves.toEqual(expected);
  });

  test("refuses an explicit leaf symlink", async () => {
    const target = join(dir, "target.png");
    const link = join(dir, "link.png");
    await writeFile(target, Buffer.from([0x89]));
    await symlink(target, link);
    await expect(readSafePastedFile(link)).rejects.toMatchObject({
      name: "UnsafePastedFileError",
      code: "symlink",
      sanitizedMessage: "Invalid file"
    });
  });

  test("refuses directories and missing files with stable codes", async () => {
    const subdir = join(dir, "subdir");
    await mkdir(subdir);
    await expect(readSafePastedFile(subdir)).rejects.toMatchObject({
      code: "not_regular_file"
    });
    await expect(readSafePastedFile(join(dir, "missing.png"))).rejects.toMatchObject({
      code: "stat_failed"
    });
  });

  test("refuses direct and traversal-spelled privileged paths", async () => {
    const privileged = join(dir, "privileged");
    await mkdir(privileged);
    __setPrivilegedPrefixesForTest([privileged]);
    const secret = join(privileged, "secret.png");
    await writeFile(secret, Buffer.from([0x89]));

    await expect(readSafePastedFile(secret)).rejects.toMatchObject({
      code: "privileged_path"
    });
    const traversal = join(dir, "unused", "..", "privileged", "secret.png");
    await expect(readSafePastedFile(traversal)).rejects.toMatchObject({
      code: "privileged_path"
    });
  });

  test("canonical path validation blocks a parent symlink into a privileged root", async () => {
    const privileged = join(dir, "privileged");
    const publicParent = join(dir, "wallpapers");
    await mkdir(privileged);
    await writeFile(join(privileged, "secret.png"), Buffer.from([0x89]));
    await symlink(privileged, publicParent, "dir");
    __setPrivilegedPrefixesForTest([privileged]);

    await expect(
      readSafePastedFile(join(publicParent, "secret.png"))
    ).rejects.toMatchObject({ code: "privileged_path" });
  });

  test("canonicalized privileged roots protect their real target too", async () => {
    const privileged = join(dir, "privileged-real");
    const privilegedAlias = join(dir, "privileged-alias");
    await mkdir(privileged);
    await writeFile(join(privileged, "secret.png"), Buffer.from([0x89]));
    await symlink(privileged, privilegedAlias, "dir");
    __setPrivilegedPrefixesForTest([privilegedAlias]);

    await expect(
      readSafePastedFile(join(privileged, "secret.png"))
    ).rejects.toMatchObject({ code: "privileged_path" });
  });

  test.each(["ENOENT", "ENOTDIR"])(
    "treats only %s privileged-root inspection as absence",
    async (code) => {
      const file = join(dir, "ordinary.png");
      await writeFile(file, Buffer.from([0x89]));
      __setPrivilegedPrefixesForTest([join(dir, "optional-secret-store")]);
      __setPrivilegedRootRealpathForTest(async () => {
        throw Object.assign(new Error("not present"), { code });
      });

      await expect(readSafePastedFile(file)).resolves.toEqual(
        Buffer.from([0x89])
      );
    }
  );

  test.each(["EACCES", "EIO", "EPERM", "EBUSY", undefined])(
    "fails closed for a %s privileged-root inspection failure",
    async (code) => {
      const privatePath = join(dir, "private-policy-root");
      const file = join(dir, "ordinary.png");
      await writeFile(file, Buffer.from([0x89]));
      __setPrivilegedPrefixesForTest([privatePath]);
      __setPrivilegedRootRealpathForTest(async () => {
        const failure = new Error(`inspection failed for ${privatePath}`);
        if (code !== undefined) Object.assign(failure, { code });
        throw failure;
      });

      let caught: unknown;
      try {
        await readSafePastedFile(file);
      } catch (cause) {
        caught = cause;
      }
      expect(caught).toMatchObject({
        name: "UnsafePastedFileError",
        code: "policy_inspection_failed",
        sanitizedMessage: "Invalid file"
      });
      expect(JSON.stringify(caught)).not.toContain(privatePath);
    }
  );

  test("re-canonicalizes a privileged root after its symlink is retargeted", async () => {
    const firstTarget = join(dir, "privileged-first");
    const secondTarget = join(dir, "privileged-second");
    const privilegedAlias = join(dir, "privileged-alias");
    await mkdir(firstTarget);
    await mkdir(secondTarget);
    await writeFile(join(firstTarget, "secret.png"), Buffer.from([0x89]));
    await writeFile(join(secondTarget, "secret.png"), Buffer.from([0x89]));
    await symlink(firstTarget, privilegedAlias, "dir");
    __setPrivilegedPrefixesForTest([privilegedAlias]);

    await expect(
      readSafePastedFile(join(firstTarget, "secret.png"))
    ).rejects.toMatchObject({ code: "privileged_path" });

    await unlink(privilegedAlias);
    await symlink(secondTarget, privilegedAlias, "dir");
    await expect(
      readSafePastedFile(join(secondTarget, "secret.png"))
    ).rejects.toMatchObject({ code: "privileged_path" });
  });

  test("re-canonicalizes a privileged root at the post-open boundary", async () => {
    const firstTarget = join(dir, "privileged-first");
    const secondTarget = join(dir, "privileged-second");
    const privilegedAlias = join(dir, "privileged-alias");
    const secret = join(secondTarget, "secret.png");
    await mkdir(firstTarget);
    await mkdir(secondTarget);
    await writeFile(secret, Buffer.from([0x89]));
    await symlink(firstTarget, privilegedAlias, "dir");
    __setPrivilegedPrefixesForTest([privilegedAlias]);
    __setVerifiedFileBeforeOpenHookForTest(async () => {
      await unlink(privilegedAlias);
      await symlink(secondTarget, privilegedAlias, "dir");
    });

    await expect(readSafePastedFile(secret)).rejects.toMatchObject({
      code: "privileged_path"
    });
  });

  test("re-canonicalizes a privileged-root symlink after it is retargeted", async () => {
    const firstRoot = join(dir, "first-root");
    const secondRoot = join(dir, "second-root");
    const rootAlias = join(dir, "root-alias");
    const ordinary = join(dir, "ordinary.png");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await writeFile(ordinary, Buffer.from([0x89]));
    await writeFile(join(secondRoot, "secret.png"), Buffer.from([0x89]));
    await symlink(firstRoot, rootAlias, "dir");
    __setPrivilegedPrefixesForTest([rootAlias]);

    await expect(readSafePastedFile(ordinary)).resolves.toEqual(Buffer.from([0x89]));
    await rm(rootAlias);
    await symlink(secondRoot, rootAlias, "dir");

    await expect(
      readSafePastedFile(join(secondRoot, "secret.png"))
    ).rejects.toMatchObject({ code: "privileged_path" });
  });

  test.runIf(process.platform === "win32")(
    "canonical path validation blocks a parent junction into a privileged root",
    async () => {
      const privileged = join(dir, "privileged");
      const junction = join(dir, "wallpapers");
      await mkdir(privileged);
      await writeFile(join(privileged, "secret.png"), Buffer.from([0x89]));
      await symlink(privileged, junction, "junction");
      __setPrivilegedPrefixesForTest([privileged]);

      await expect(readSafePastedFile(join(junction, "secret.png"))).rejects.toMatchObject({
        code: "privileged_path"
      });
    }
  );

  test("enforces the byte limit before reading", async () => {
    const file = join(dir, "large.png");
    await writeFile(file, Buffer.alloc(5));
    await expect(readSafePastedFile(file, { maxBytes: 4 })).rejects.toMatchObject({
      code: "size_cap_exceeded",
      sanitizedMessage: "Image is too large"
    });
  });

  test("UnsafePastedFileError messages and fields never expose a path", async () => {
    const missing = join(dir, "private-file-name.png");
    let caught: unknown;
    try {
      await readSafePastedFile(missing);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(UnsafePastedFileError);
    if (!(caught instanceof UnsafePastedFileError)) throw new Error("type guard");
    expect(caught.message).toBe(caught.sanitizedMessage);
    expect(caught.message).not.toContain(missing);
    expect(Object.values(caught)).not.toContain(missing);
  });
});

describe("cross-platform privileged roots", () => {
  test("Windows includes credential stores, GitHub CLI, system, and program roots", () => {
    const roots = __buildPrivilegedPrefixesForTest({
      platform: "win32",
      homeDir: "C:\\Users\\Alice",
      env: {
        APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
        SystemRoot: "C:\\Windows",
        ProgramData: "C:\\ProgramData",
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        ProgramW6432: "C:\\Program Files"
      }
    });

    for (const expected of [
      "C:\\Users\\Alice\\.ssh",
      "C:\\Users\\Alice\\.azure",
      "C:\\Users\\Alice\\.kube",
      "C:\\Users\\Alice\\.docker",
      "C:\\Users\\Alice\\.git-credentials",
      "C:\\Users\\Alice\\.npmrc",
      "C:\\Users\\Alice\\.terraform.d\\credentials.tfrc.json",
      "C:\\Users\\Alice\\.config\\gh",
      "C:\\Users\\Alice\\.config\\gcloud",
      "C:\\Users\\Alice\\.config\\containers\\auth.json",
      "C:\\Users\\Alice\\AppData\\Roaming\\GitHub CLI",
      "C:\\Users\\Alice\\AppData\\Roaming\\gnupg",
      "C:\\Users\\Alice\\AppData\\Roaming\\Microsoft\\Crypto",
      "C:\\Users\\Alice\\AppData\\Roaming\\Microsoft\\Credentials",
      "C:\\Users\\Alice\\AppData\\Roaming\\Microsoft\\SystemCertificates",
      "C:\\Users\\Alice\\AppData\\Local\\Microsoft\\Protect",
      "C:\\Users\\Alice\\AppData\\Local\\Microsoft\\TokenBroker",
      "C:\\Users\\Alice\\AppData\\Local\\Microsoft\\IdentityCache",
      "C:\\Users\\Alice\\AppData\\Local\\Microsoft\\Vault",
      "C:\\Users\\Alice\\AppData\\Roaming\\NuGet\\NuGet.Config",
      "C:\\Windows",
      "C:\\ProgramData",
      "C:\\Recovery",
      "C:\\System Volume Information",
      "C:\\Program Files",
      "C:\\Program Files (x86)"
    ]) {
      expect(roots).toContain(win32.normalize(expected));
    }
  });

  test("Windows system roots have safe same-volume fallbacks", () => {
    const roots = __buildPrivilegedPrefixesForTest({
      platform: "win32",
      homeDir: "D:\\Users\\Alice",
      env: {}
    });

    expect(roots).toEqual(
      expect.arrayContaining([
        "D:\\Windows",
        "D:\\ProgramData",
        "D:\\Recovery",
        "D:\\System Volume Information"
      ])
    );
  });

  test("Windows inaccessible protected defaults remain lexical deny roots without inspection", async () => {
    const options = {
      platform: "win32" as const,
      homeDir: "C:\\Users\\Alice",
      env: {
        SystemRoot: "C:\\Windows"
      }
    };
    const lexicalOnly = __buildLexicalOnlyPrivilegedPrefixesForTest(options);
    expect(lexicalOnly).toEqual([
      "C:\\Recovery",
      "C:\\System Volume Information"
    ]);

    const ordinaryCanonicalRoot = "C:\\Users\\Alice\\.ssh";
    const inspected: string[] = [];
    __setPrivilegedRootRealpathForTest(async (root) => {
      inspected.push(win32.normalize(root));
      if (lexicalOnly.includes(win32.normalize(root))) {
        throw Object.assign(new Error("protected by Windows"), {
          code: "EACCES"
        });
      }
      return win32.normalize(root);
    });

    const policy = await __buildPrivilegedPolicyForTest(
      [ordinaryCanonicalRoot, ...lexicalOnly],
      { platform: "win32", lexicalOnlyPrefixes: lexicalOnly }
    );

    expect(inspected).toEqual([ordinaryCanonicalRoot]);
    expect(policy.prefixes).toEqual(
      expect.arrayContaining([ordinaryCanonicalRoot, ...lexicalOnly])
    );
    expect(
      __isPrivilegedPathForTest(
        "C:\\System Volume Information\\tracking.log",
        policy
      )
    ).toBe(true);
    expect(
      __isPrivilegedPathForTest("C:\\Users\\Alice\\Pictures\\safe.png", policy)
    ).toBe(false);
  });

  test("Windows policy still fails closed when a canonicalized deny root cannot be inspected", async () => {
    const protectedRoot = "C:\\Users\\Alice\\.ssh";
    __setPrivilegedRootRealpathForTest(async () => {
      throw Object.assign(new Error("unexpected inspection failure"), {
        code: "EACCES"
      });
    });

    await expect(
      __buildPrivilegedPolicyForTest([protectedRoot], {
        platform: "win32",
        lexicalOnlyPrefixes: []
      })
    ).rejects.toMatchObject({
      name: "PrivilegedPolicyInspectionError"
    });
  });

  test("Windows containment is separator-aware and case-insensitive", () => {
    expect(
      __isPrivilegedPathForTest(
        "c:\\users\\alice\\appdata\\roaming\\GITHUB CLI\\hosts.yml",
        {
          platform: "win32",
          prefixes: ["C:\\Users\\Alice\\AppData\\Roaming\\GitHub CLI"]
        }
      )
    ).toBe(true);
    expect(
      __isPrivilegedPathForTest("C:\\Program Files-safe\\photo.png", {
        platform: "win32",
        prefixes: ["C:\\Program Files"]
      })
    ).toBe(false);

    const fileRootOptions = {
      platform: "win32" as const,
      prefixes: ["C:\\Users\\Alice\\.npmrc"]
    };
    expect(
      __isPrivilegedPathForTest(
        "c:\\users\\alice\\.NPMRC",
        fileRootOptions
      )
    ).toBe(true);
    expect(
      __isPrivilegedPathForTest(
        "C:\\Users\\Alice\\.npmrc-backup",
        fileRootOptions
      )
    ).toBe(false);
  });

  test("Windows normalizes equivalent drive and UNC namespaces", () => {
    expect(
      normalizeWindowsPathForPolicy("\\\\?\\C:\\Users\\Alice\\.ssh\\id_ed25519")
    ).toBe("C:\\Users\\Alice\\.ssh\\id_ed25519");
    expect(
      normalizeWindowsPathForPolicy("\\\\?\\UNC\\server\\images\\photo.png")
    ).toBe("\\\\server\\images\\photo.png");

    const options = {
      platform: "win32" as const,
      prefixes: ["C:\\Users\\Alice\\.ssh"]
    };
    expect(
      __isPrivilegedPathForTest(
        "\\\\?\\C:\\Users\\Alice\\.ssh\\id_ed25519",
        options
      )
    ).toBe(true);
    expect(
      __isPrivilegedPathForTest("\\??\\C:\\Users\\Alice\\.ssh\\config", options)
    ).toBe(true);
  });

  test("Windows fails closed for device namespaces and admin-share aliases", () => {
    const options = {
      platform: "win32" as const,
      prefixes: ["C:\\Users\\Alice\\.ssh"]
    };
    for (const candidate of [
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\secret",
      "\\\\.\\PhysicalDrive0",
      "C:\\Users\\Alice\\safe.png\nC:\\Users\\Alice\\.ssh\\config",
      "\\\\localhost\\C$\\Users\\Alice\\.ssh\\id_ed25519",
      "\\\\?\\UNC\\localhost\\C$\\Users\\Alice\\.ssh\\id_ed25519"
    ]) {
      expect(normalizeWindowsPathForPolicy(candidate)).toBeNull();
      expect(__isPrivilegedPathForTest(candidate, options)).toBe(true);
    }
    expect(
      __isPrivilegedPathForTest("\\\\server\\images\\photo.png", options)
    ).toBe(false);
  });

  test("macOS protects system and user keychains plus dot credential stores", () => {
    const roots = __buildPrivilegedPrefixesForTest({
      platform: "darwin",
      homeDir: "/Users/alice"
    });
    expect(roots).toEqual(
      expect.arrayContaining([
        "/private/etc",
        "/private/var",
        "/System",
        "/Library/Keychains",
        "/Users/alice/Library/Keychains",
        "/Users/alice/.ssh",
        "/Users/alice/.azure",
        "/Users/alice/.kube",
        "/Users/alice/.docker",
        "/Users/alice/.git-credentials",
        "/Users/alice/.npmrc",
        "/Users/alice/.config/gcloud",
        "/Users/alice/.config/gh"
      ])
    );
  });

  test("macOS permits only its canonical per-user temp dir beneath /private/var", () => {
    const options = {
      platform: "darwin" as const,
      prefixes: ["/private/var"],
      canonicalTempDir: "/private/var/folders/ab/user/T"
    };
    expect(
      __isPrivilegedPathForTest(
        "/private/var/folders/ab/user/T/pwrsnap/photo.png",
        options
      )
    ).toBe(false);
    expect(
      __isPrivilegedPathForTest(
        "/private/var/folders/ab/other/T/secret.png",
        options
      )
    ).toBe(true);
  });

  test("macOS temp carveout requires the owned private per-user T shape", async () => {
    const expected = "/private/var/folders/ab/user-token/T";
    expect(
      __isExpectedDarwinTempDirForTest(expected, {
        isDirectory: true,
        ownerUid: 501,
        currentUid: 501,
        mode: 0o40700
      })
    ).toBe(true);
    for (const [path, override] of [
      ["/private/var/tmp/hostile", {}],
      [`${expected}/nested`, {}],
      [expected, { ownerUid: 502 }],
      [expected, { mode: 0o40777 }],
      [expected, { isDirectory: false }]
    ] as const) {
      expect(
        __isExpectedDarwinTempDirForTest(path, {
          isDirectory: true,
          ownerUid: 501,
          currentUid: 501,
          mode: 0o40700,
          ...override
        })
      ).toBe(false);
    }

    const hostileTmpDir = join(dir, "hostile-tmpdir");
    await mkdir(hostileTmpDir, { mode: 0o700 });
    await expect(
      __canonicalDarwinTempDirForTest(hostileTmpDir)
    ).resolves.toBeNull();
  });
});
