// Sign in with ChatGPT's "Manage usage" and "Learn more" are required by
// OpenAI's UI guidelines. Before the allowlist knew them, both buttons did
// nothing: `app:openExternal` refused the URL and the renderer had no error
// to show. They are allowed as exact URLs, never as hosts.
import { describe, expect, test } from "vitest";
import { CHATGPT_PLAN_HELP_URL, CHATGPT_USAGE_URL } from "@pwrsnap/shared";
import { isAllowedExternalUrl } from "../external-url-allowlist";

describe("ChatGPT plan links", () => {
  test("the two pages the plan UI opens are allowed", () => {
    expect(isAllowedExternalUrl(CHATGPT_USAGE_URL)).toBe(true);
    expect(isAllowedExternalUrl(CHATGPT_PLAN_HELP_URL)).toBe(true);
  });

  test("nothing else on those hosts is", () => {
    for (const url of [
      "https://chatgpt.com/",
      "https://chatgpt.com/settings",
      `${CHATGPT_USAGE_URL}?next=https://fixture.example`,
      `${CHATGPT_USAGE_URL}#fixture`,
      `${CHATGPT_USAGE_URL}/../../c/fixture`,
      CHATGPT_USAGE_URL.replace("https:", "http:"),
      "https://help.openai.com/en/articles/",
      `${CHATGPT_PLAN_HELP_URL}?fixture=1`,
      "https://chatgpt.com.fixture.example/settings/usage"
    ]) expect(isAllowedExternalUrl(url), url).toBe(false);
  });
});
