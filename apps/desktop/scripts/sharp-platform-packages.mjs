import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const targetTokenPattern = /^[a-z0-9][a-z0-9-]*$/;
const sharpNativePackagePattern = /^sharp(?:-libvips)?-/;

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateTargetToken(label, value) {
  if (typeof value !== "string" || !targetTokenPattern.test(value)) {
    throw new Error(`invalid Sharp target ${label}: ${String(value)}`);
  }
  return value;
}

const shippedTargetArches = {
  win32: ["x64", "arm64"],
  darwin: ["x64", "arm64", "universal"]
};

/**
 * Native @img packages Sharp needs for one packaged runtime target.
 *
 * Windows Sharp packages bundle libvips in the binding package. Darwin uses a
 * separate libvips package, and the universal app carries both Darwin slices.
 * Keeping this mapping explicit makes an upstream layout change, or a target
 * nobody mapped, fail closed instead of silently shipping an incomplete app.
 *
 * Everything else matching `isSharpNativePackage` is foreign to the target.
 * That includes `sharp-wasm32`, which `.pnpmfile.cjs` installs on Linux only
 * and which THIRD_PARTY_LICENSES does not disclose.
 */
export function sharpNativePackagesForTarget({ platform, arch }) {
  const targetPlatform = validateTargetToken("platform", platform);
  const targetArch = validateTargetToken("arch", arch);
  if (!shippedTargetArches[targetPlatform]?.includes(targetArch)) {
    throw new Error(`unsupported Sharp package target: ${targetPlatform}/${targetArch}`);
  }
  if (targetPlatform === "darwin" && targetArch === "universal") {
    return ["arm64", "x64"].flatMap((sliceArch) =>
      sharpNativePackagesForTarget({ platform: targetPlatform, arch: sliceArch })
    );
  }

  const binding = `sharp-${targetPlatform}-${targetArch}`;
  if (targetPlatform === "win32") {
    return [binding];
  }
  return [binding, `sharp-libvips-${targetPlatform}-${targetArch}`];
}

export function isSharpNativePackage(packageName) {
  return sharpNativePackagePattern.test(packageName);
}

/**
 * True for a native package that some shipped target uses. A release stage may
 * legitimately hold another target's slice (pnpm-workspace.yaml's
 * supportedArchitectures installs every Darwin and win32 slice), and pruning
 * one is routine. A native package outside this set (sharp-wasm32, a linux
 * slice) means the install changed underneath the release, so it is refused.
 */
export function isShippedSharpNativePackage(packageName) {
  return Object.entries(shippedTargetArches).some(([platform, arches]) =>
    arches.some((arch) => sharpNativePackagesForTarget({ platform, arch }).includes(packageName))
  );
}

/**
 * Build a deterministic keep/remove plan without touching the filesystem.
 * Non-native packages in the @img scope (notably @img/colour) are retained.
 */
export function partitionSharpNativePackages(packageNames, target) {
  const available = [...new Set(packageNames)].sort(compareStrings);
  const required = sharpNativePackagesForTarget(target);
  const allowed = new Set(required);
  const native = available.filter(isSharpNativePackage);
  const missing = required.filter((name) => !native.includes(name));

  return {
    kept: available.filter((name) => !isSharpNativePackage(name) || allowed.has(name)),
    removed: native.filter((name) => !allowed.has(name)),
    required,
    missing
  };
}

export function listImgPackageNames(nodeModulesDir) {
  const imgScope = join(nodeModulesDir, "@img");
  if (!existsSync(imgScope)) return [];

  return readdirSync(imgScope, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort(compareStrings);
}

export function inspectSharpNativePackages({ nodeModulesDir, platform, arch }) {
  return partitionSharpNativePackages(listImgPackageNames(nodeModulesDir), {
    platform,
    arch
  });
}

/**
 * Remove wrong-target Sharp native payloads from one deployed node_modules.
 * The desired target is checked before the first deletion so a broken deploy
 * cannot be converted into a partially-pruned stage.
 */
export function pruneSharpNativePackages({ nodeModulesDir, platform, arch }) {
  const imgScope = join(nodeModulesDir, "@img");
  if (!existsSync(imgScope)) {
    throw new Error(`staged @img package scope missing at ${imgScope}`);
  }

  const plan = inspectSharpNativePackages({ nodeModulesDir, platform, arch });
  if (plan.missing.length > 0) {
    throw new Error(
      `required Sharp target package(s) missing for ${platform}/${arch}: ` +
        plan.missing.map((name) => `@img/${name}`).join(", ")
    );
  }

  for (const packageName of plan.removed) {
    rmSync(join(imgScope, packageName), { recursive: true, force: true });
  }

  const after = inspectSharpNativePackages({ nodeModulesDir, platform, arch });
  if (after.missing.length > 0 || after.removed.length > 0) {
    throw new Error(
      `Sharp target pruning postcondition failed for ${platform}/${arch}: ` +
        `missing=${after.missing.join(",") || "<none>"}, ` +
        `foreign=${after.removed.join(",") || "<none>"}`
    );
  }

  return plan;
}
