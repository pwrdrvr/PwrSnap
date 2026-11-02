// E2E hermeticity for the macOS login keychain.
//
// `safeStorage` encrypts `pwrsnap-secrets.bin` with a key Chromium keeps in
// the login keychain as a generic password under "PwrSnap Safe Storage". The
// FIRST safeStorage call in a process fetches it, and macOS grants access by
// the requesting binary's code identity. Two consequences for tests:
//
//   1. An E2E run drives an UNSIGNED dev Electron whose cdhash changes on
//      every rebuild. Letting it create or open that item registers throwaway
//      identities on the same keychain entry the installed app uses, so a
//      later launch of the real app has to ask the user for their keychain
//      password. That is exactly how a developer machine ends up with a
//      scratch-worktree binary on the access list of the shipped app's item.
//   2. macOS blocks on that password dialog. In a headless or unattended run
//      there is nobody to answer it, so the spec hangs until it times out.
//
// Chromium's own answer is `--use-mock-keychain`: `OSCryptImpl::GetKeychain()`
// substitutes an in-memory `FakeKeychainV2`, so safeStorage still reports
// available and still round-trips within the process, but nothing reaches the
// real keychain. The key is per-process, so a value encrypted in one launch
// cannot be decrypted in the next — acceptable here because every E2E launch
// gets a throwaway `PWRSNAP_USER_DATA`, and no spec persists a secret across
// a relaunch.
//
// This is deliberately E2E-only. A plain `pnpm dev` run must keep using the
// real keychain: `app.setName("PwrSnap")` runs unconditionally, so dev shares
// `userData` — and therefore the same `pwrsnap-secrets.bin` — with the
// installed app. A dev process on a mock keychain would fail to read the
// user's real secrets and would re-encrypt them under a key that dies with
// the process.

import type { ChromiumCommandLine } from "./windows-chromium-startup-policy";

/** Chromium switch that swaps the real Keychain for an in-memory fake.
 *  Defined by `os_crypt::switches::kUseMockKeychain`, Apple-only. */
export const MOCK_KEYCHAIN_SWITCH = "use-mock-keychain";

export type DarwinKeychainStartupPolicyInput = {
  platform: NodeJS.Platform;
  isE2E: boolean;
};

/**
 * Apply the macOS keychain isolation policy before app readiness.
 *
 * Returns true when the mock keychain was requested, so the caller can log it.
 */
export function applyDarwinKeychainStartupPolicy(
  commandLine: ChromiumCommandLine,
  { platform, isE2E }: DarwinKeychainStartupPolicyInput
): boolean {
  // The switch is Apple-only in Chromium; appending it elsewhere would be an
  // unrecognized flag rather than a no-op worth shipping.
  if (platform !== "darwin") return false;
  if (!isE2E) return false;
  commandLine.appendSwitch(MOCK_KEYCHAIN_SWITCH);
  return true;
}
