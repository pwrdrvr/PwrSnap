import { describe, expect, test } from "vitest";
import { APPLE_FM_LINK_URLS } from "@pwrsnap/shared";
import { isAllowedExternalUrl } from "../external-url-allowlist";

describe("external URL allowlist — Apple's pages on the on-device model", () => {
  test("each linked page opens", () => {
    expect(APPLE_FM_LINK_URLS.length).toBeGreaterThan(0);
    for (const url of APPLE_FM_LINK_URLS) expect(isAllowedExternalUrl(url)).toBe(true);
  });

  test("the allowance is the exact URL, not the host", () => {
    for (const url of [
      "https://support.apple.com/",
      "https://support.apple.com/en-us/121116",
      "https://support.apple.com/en-us/121115?x=1",
      "https://support.apple.com/en-us/121115#frag",
      "http://support.apple.com/en-us/121115",
      "https://developer.apple.com/",
      "https://developer.apple.com/foundation-models-framework",
      "https://developer.apple.com/documentation/foundationmodels",
      "https://developer.apple.com.evil.example/foundation-models-framework/",
      "https://apple.com/"
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(false);
    }
  });
});
