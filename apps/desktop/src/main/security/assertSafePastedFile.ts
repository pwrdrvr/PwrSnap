import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  posix,
  win32,
  type PlatformPath
} from "node:path";
import { PASTE_IMAGE_MAX_BYTES } from "@pwrsnap/shared";
import {
  readVerifiedFileSnapshot,
  VerifiedFileError,
  type VerifiedFileErrorCode
} from "./verified-file";

type PrivilegedPathPlatform = "darwin" | "win32" | "linux";
type Environment = Readonly<Record<string, string | undefined>>;

export type PrivilegedPrefixBuildOptions = {
  platform: PrivilegedPathPlatform;
  homeDir: string;
  env?: Environment;
};

function pathApiFor(platform: PrivilegedPathPlatform): PlatformPath {
  return platform === "win32" ? win32 : posix;
}

function envValue(
  env: Environment,
  ...names: readonly string[]
): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== "" && wanted.has(key.toLowerCase())) {
      return value;
    }
  }
  return undefined;
}

function uniqueNormalized(
  values: readonly string[],
  platform: PrivilegedPathPlatform
): readonly string[] {
  const pathApi = pathApiFor(platform);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = pathApi.resolve(value);
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/** Pure cross-platform builder, exported so Windows policy is testable on CI. */
export function __buildPrivilegedPrefixesForTest(
  options: PrivilegedPrefixBuildOptions
): readonly string[] {
  const { platform, homeDir } = options;
  const env = options.env ?? {};
  const pathApi = pathApiFor(platform);
  const roots: string[] = [
    pathApi.resolve(homeDir, ".ssh"),
    pathApi.resolve(homeDir, ".aws"),
    pathApi.resolve(homeDir, ".gnupg"),
    pathApi.resolve(homeDir, ".config", "gh")
  ];

  if (platform === "darwin") {
    roots.push(
      "/private/etc",
      "/private/var",
      "/System",
      "/Library/Keychains",
      "/Volumes/.timemachine.local",
      pathApi.resolve(homeDir, "Library", "Keychains")
    );
  }

  if (platform === "win32") {
    const homeVolumeRoot = pathApi.parse(homeDir).root;
    const appData =
      envValue(env, "APPDATA") ??
      pathApi.resolve(homeDir, "AppData", "Roaming");
    const localAppData =
      envValue(env, "LOCALAPPDATA") ??
      pathApi.resolve(homeDir, "AppData", "Local");
    const systemRoot =
      envValue(env, "SystemRoot", "WINDIR") ??
      pathApi.resolve(homeVolumeRoot, "Windows");
    const systemVolumeRoot = pathApi.parse(systemRoot).root || homeVolumeRoot;
    const programData =
      envValue(env, "ProgramData", "ALLUSERSPROFILE") ??
      pathApi.resolve(systemVolumeRoot, "ProgramData");

    roots.push(
      pathApi.resolve(appData, "GitHub CLI"),
      pathApi.resolve(appData, "gnupg"),
      systemRoot,
      programData,
      pathApi.resolve(systemVolumeRoot, "Recovery"),
      pathApi.resolve(systemVolumeRoot, "System Volume Information")
    );
    for (const dataRoot of [appData, localAppData]) {
      roots.push(
        pathApi.resolve(dataRoot, "Microsoft", "Credentials"),
        pathApi.resolve(dataRoot, "Microsoft", "Protect"),
        pathApi.resolve(dataRoot, "Microsoft", "Vault")
      );
    }

    for (const value of [
      envValue(env, "ProgramFiles"),
      envValue(env, "ProgramFiles(x86)"),
      envValue(env, "ProgramW6432")
    ]) {
      if (value !== undefined) roots.push(value);
    }
  }

  return uniqueNormalized(roots, platform);
}

function isWithin(
  candidatePath: string,
  rootPath: string,
  platform: PrivilegedPathPlatform
): boolean {
  const pathApi = pathApiFor(platform);
  let candidate = pathApi.resolve(candidatePath);
  let root = pathApi.resolve(rootPath);
  if (platform === "win32" || platform === "darwin") {
    candidate = candidate.toLowerCase();
    root = root.toLowerCase();
  }
  if (candidate === root) return true;
  const prefix = root.endsWith(pathApi.sep) ? root : root + pathApi.sep;
  return candidate.startsWith(prefix);
}

export type PrivilegedPathCheckOptions = {
  platform: PrivilegedPathPlatform;
  prefixes: readonly string[];
  canonicalTempDir?: string | null;
};

/** Pure containment check, including the narrowly scoped macOS temp carveout. */
export function __isPrivilegedPathForTest(
  candidatePath: string,
  options: PrivilegedPathCheckOptions
): boolean {
  const { platform, prefixes } = options;
  const canonicalTempDir = options.canonicalTempDir ?? null;
  for (const prefix of prefixes) {
    // macOS resolves /var/folders/... into /private/var/folders/.... Pasted
    // files created in this process's canonical per-user tmpdir are legitimate;
    // no other descendant of the otherwise-privileged /private/var is allowed.
    if (
      platform === "darwin" &&
      posix.resolve(prefix) === "/private/var" &&
      canonicalTempDir !== null &&
      isWithin(candidatePath, canonicalTempDir, platform)
    ) {
      continue;
    }
    if (isWithin(candidatePath, prefix, platform)) return true;
  }
  return false;
}

function runtimePlatform(): PrivilegedPathPlatform {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

function defaultPrefixes(): readonly string[] {
  return __buildPrivilegedPrefixesForTest({
    platform: runtimePlatform(),
    homeDir: homedir(),
    env: process.env
  });
}

let testPrefixOverride: readonly string[] | null = null;

/** Test-only override. An empty array intentionally disables prefix checks. */
export function __setPrivilegedPrefixesForTest(
  prefixes: readonly string[] | null
): void {
  testPrefixOverride = prefixes;
}

async function canonicalizeIfPresent(rootPath: string): Promise<string | null> {
  try {
    return await realpath(rootPath);
  } catch {
    return null;
  }
}

async function buildPolicy(
  prefixes: readonly string[]
): Promise<PrivilegedPathCheckOptions> {
  const platform = runtimePlatform();
  const canonical = await Promise.all(prefixes.map(canonicalizeIfPresent));
  const roots = uniqueNormalized(
    [
      ...prefixes,
      ...canonical.filter((value): value is string => value !== null)
    ],
    platform
  );
  const canonicalTempDir =
    platform === "darwin" ? await canonicalizeIfPresent(tmpdir()) : null;
  return { platform, prefixes: roots, canonicalTempDir };
}

async function effectivePolicy(): Promise<PrivilegedPathCheckOptions> {
  // Re-canonicalize on every read. A privileged root can itself be a symlink;
  // retaining its prior target would make a later retarget stale the policy.
  return await buildPolicy(testPrefixOverride ?? defaultPrefixes());
}

export type UnsafePastedFileErrorCode =
  | "privileged_path"
  | VerifiedFileErrorCode;

export class UnsafePastedFileError extends Error {
  readonly code: UnsafePastedFileErrorCode;
  /** Safe for renderer/bus responses; never contains an absolute path. */
  readonly sanitizedMessage: string;

  constructor(code: UnsafePastedFileErrorCode, sanitizedMessage: string) {
    super(sanitizedMessage);
    this.name = "UnsafePastedFileError";
    this.code = code;
    this.sanitizedMessage = sanitizedMessage;
  }
}

function unsafeMessage(code: UnsafePastedFileErrorCode): string {
  return code === "size_cap_exceeded" ? "Image is too large" : "Invalid file";
}

function translateVerifiedError(cause: unknown): never {
  if (cause instanceof UnsafePastedFileError) throw cause;
  if (cause instanceof VerifiedFileError) {
    throw new UnsafePastedFileError(cause.code, unsafeMessage(cause.code));
  }
  throw new UnsafePastedFileError("read_failed", "Invalid file");
}

function pastedPathValidator(): (candidatePath: string) => Promise<void> {
  return async (candidatePath: string): Promise<void> => {
    // The privileged root can itself be a symlink. Rebuild at every
    // pre/post-open validation boundary so a mid-verification retarget cannot
    // leave the canonical policy pointing at its former destination.
    const policy = await effectivePolicy();
    if (__isPrivilegedPathForTest(candidatePath, policy)) {
      throw new UnsafePastedFileError("privileged_path", "Invalid file");
    }
  };
}

/**
 * Read pasted/dropped bytes through the same securely opened handle that was
 * validated. The allocation and read are bounded by the opened file size.
 */
export async function readSafePastedFile(
  filePath: string,
  options: { maxBytes?: number } = {}
): Promise<Buffer> {
  const validatePath = pastedPathValidator();
  try {
    return await readVerifiedFileSnapshot(filePath, {
      maxBytes: options.maxBytes ?? PASTE_IMAGE_MAX_BYTES,
      validatePath
    });
  } catch (cause) {
    translateVerifiedError(cause);
  }
}
