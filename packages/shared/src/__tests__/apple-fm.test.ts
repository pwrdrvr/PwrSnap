// The words Settings shows for Apple's on-device model, and the prompt it
// offers for the user's own agent. The prompt is the riskiest text in the
// feature: it is pasted into an agent that can run commands, so what it may
// and may not ask for is pinned here as properties over every state.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  APPLE_FM_LICENSE_COMMAND,
  APPLE_FM_LINKS,
  APPLE_FM_LINK_URLS,
  APPLE_FM_PROVIDER,
  APPLE_FM_STATES,
  appleFmAgentPrompt,
  appleFmStateCopy,
  appleFmTerminalCommand,
  isAppleFmOffered,
  isAppleFmProvider,
  isAppleFmReady,
  quotableAppleFmDetail,
  type AppleFmState,
  type AppleFmStatus
} from "../apple-fm";

function status(state: AppleFmState, detail: string | null = null): AppleFmStatus {
  return { state, modelLabel: null, detail, macosVersion: "26.5", checkedAt: 0 };
}

/** Every command a prompt may ask an agent to run. `sudo fm license` is the
 *  one the user is told to run THEMSELVES; it is checked separately. */
const READ_ONLY_COMMANDS: readonly RegExp[] = [
  /^\/usr\/bin\/fm license --status$/,
  /^\/usr\/bin\/fm license --show$/,
  /^\/usr\/bin\/fm models$/,
  /^\/usr\/bin\/fm config list$/,
  /^\/usr\/bin\/fm config path$/,
  /^\/usr\/bin\/fm config --help$/,
  /^sw_vers$/,
  /^sysctl -n machdep\.cpu\.brand_string$/,
  /^ls -l \/usr\/bin\/fm$/
];

function backticked(prompt: string): string[] {
  return [...prompt.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

const stateArb = fc.constantFrom(...APPLE_FM_STATES);
// What macOS said is echoed into the prompt; it must not be able to change
// what the prompt asks for.
const detailArb = fc.option(fc.string({ maxLength: 200 }), { nil: null });

describe("provider selector", () => {
  test("only the exact selector names the on-device model", () => {
    expect(isAppleFmProvider(APPLE_FM_PROVIDER)).toBe(true);
    for (const other of ["", "codex", "apple", "apple:pcc", "apple:system ", "acp:apple", undefined, null]) {
      expect(isAppleFmProvider(other)).toBe(false);
    }
  });

  test("ready and offered are separate questions", () => {
    expect(isAppleFmReady(status("ready"))).toBe(true);
    for (const state of APPLE_FM_STATES) {
      expect(isAppleFmReady(status(state))).toBe(state === "ready");
      expect(isAppleFmOffered(status(state))).toBe(state !== "unsupported-platform");
    }
    expect(isAppleFmOffered(null)).toBe(false);
    expect(isAppleFmReady(null)).toBe(false);
  });
});

describe("state copy", () => {
  test("every state has words, and only `ready` reads as fine", () => {
    for (const state of APPLE_FM_STATES) {
      const copy = appleFmStateCopy(status(state));
      expect(copy.badge.length).toBeGreaterThan(0);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
      expect(copy.severity === "ok").toBe(state === "ready");
      // A state that is not fine always carries a word; colour alone never
      // says it (the sidebar dot is aria-hidden).
      if (state !== "ready" && state !== "unsupported-platform") expect(copy.chip).toBeDefined();
      for (const link of copy.links) expect(APPLE_FM_LINKS[link]).toBeDefined();
    }
  });

  test("the macOS version appears only when it is known", () => {
    expect(appleFmStateCopy(status("needs-macos")).body).toContain("macOS 26.5");
    expect(appleFmStateCopy({ ...status("needs-macos"), macosVersion: null }).body).not.toContain("runs macOS");
  });

  test("links are exact https pages on Apple's own hosts", () => {
    expect(APPLE_FM_LINK_URLS).toHaveLength(Object.keys(APPLE_FM_LINKS).length);
    for (const url of APPLE_FM_LINK_URLS) {
      // No query, no fragment, and one of Apple's two documentation hosts.
      expect(url).toMatch(/^https:\/\/(support|developer)\.apple\.com\/[A-Za-z0-9/_-]+$/);
    }
  });
});

describe("agent prompt", () => {
  test("a state with a step someone can take gets a prompt; the others do not", () => {
    for (const state of APPLE_FM_STATES) {
      const prompt = appleFmAgentPrompt(status(state));
      const expectsPrompt = state !== "ready" && state !== "unsupported-platform";
      expect(prompt !== null).toBe(expectsPrompt);
    }
  });

  test("property: a prompt only asks for read-only commands", () => {
    for (const state of APPLE_FM_STATES) {
      const prompt = appleFmAgentPrompt(status(state));
      if (prompt === null) continue;
      for (const command of backticked(prompt)) {
        // Not commands: the model's name, the tool's path, and the one
        // command the user is told to run themselves.
        if (command === "sudo fm license" || command === APPLE_FM_LICENSE_COMMAND) continue;
        if (command === "system" || command === "/usr/bin/fm") continue;
        expect(READ_ONLY_COMMANDS.some((allowed) => allowed.test(command))).toBe(true);
      }
    }
  });

  test("property: what macOS said cannot add a command or a line to the prompt", () => {
    fc.assert(
      fc.property(stateArb, detailArb, (state, detail) => {
        const plain = appleFmAgentPrompt(status(state));
        const quoted = appleFmAgentPrompt(status(state, detail));
        if (plain === null || quoted === null) {
          expect(quoted).toBe(plain);
          return;
        }
        // Same commands, same number of lines: the detail is one quoted
        // sentence inside an existing line, and nothing else.
        expect(backticked(quoted)).toEqual(backticked(plain));
        expect(quoted.split("\n")).toHaveLength(plain.split("\n").length);
        const clean = quotableAppleFmDetail(detail);
        expect(quoted.includes("The tool said:")).toBe(clean !== null && plain !== quoted);
      })
    );
  });

  test("property: every prompt forbids installing, changing settings and bypassing protections", () => {
    for (const state of APPLE_FM_STATES) {
      const prompt = appleFmAgentPrompt(status(state));
      if (prompt === null) continue;
      expect(prompt).toContain("Do not install anything");
      expect(prompt).toContain("bypass any macOS protection");
      expect(prompt).toContain("https://");
      // Nothing that turns a protection off or agrees silently.
      expect(prompt).not.toMatch(/csrutil|spctl|--no-verify|yes \||echo y|defaults write|xattr -d/i);
    }
  });

  test("the terms are the user's to agree to, never the agent's", () => {
    const prompt = appleFmAgentPrompt(status("license-required")) ?? "";
    expect(prompt).toContain("without agreeing to anything on my behalf");
    expect(prompt).toContain("Do not run it for me");
    // The only privileged command named is the one the tool itself prints.
    // The tool's own wording is quoted, and the form to actually run is the
    // full-path one Settings shows: sudo searches PATH, and a `fm` earlier on
    // it would run as root.
    expect(backticked(prompt).filter((command) => command.startsWith("sudo"))).toEqual([
      "sudo fm license",
      APPLE_FM_LICENSE_COMMAND
    ]);
    expect(prompt).toContain(`\`${APPLE_FM_LICENSE_COMMAND}\`; use that form`);
  });

  test("only the terms prompt names a privileged command", () => {
    for (const state of APPLE_FM_STATES) {
      if (state === "license-required") continue;
      expect(appleFmAgentPrompt(status(state)) ?? "").not.toContain("sudo");
    }
  });

  test("an older macOS is pointed at Software Update, not at unofficial installers", () => {
    const prompt = appleFmAgentPrompt(status("needs-macos")) ?? "";
    expect(prompt).toContain("Software Update");
    expect(prompt).toContain("Do not suggest beta software, unofficial installers or patchers");
    expect(prompt).toContain("macOS 26.5");
  });

  test("what macOS said is quoted for the agent", () => {
    const prompt = appleFmAgentPrompt(status("model-not-ready", "The model is not available. Try again later.")) ?? "";
    expect(prompt).toContain('The tool said: "The model is not available. Try again later."');
  });
});

describe("the Terminal step", () => {
  test("property: only missing terms offer a command, and it is always the same one", () => {
    fc.assert(
      fc.property(fc.constantFrom(...APPLE_FM_STATES), fc.option(fc.string(), { nil: null }), (state, detail) => {
        const command = appleFmTerminalCommand(status(state, detail));
        // What macOS said never changes the command: it is not parsed out of
        // the tool's sentence, so that sentence cannot put words in it.
        expect(command).toBe(state === "license-required" ? APPLE_FM_LICENSE_COMMAND : null);
      })
    );
  });

  test("is the command macOS names, with the tool's absolute path and nothing added", () => {
    expect(APPLE_FM_LICENSE_COMMAND).toBe("sudo /usr/bin/fm license");
    // sudo on macOS searches the user's PATH; only the full path pins the
    // binary that runs as root to the one on the sealed system volume.
    expect(APPLE_FM_LICENSE_COMMAND.replace("/usr/bin/fm", "fm")).toBe("sudo fm license");
    // No flag that would agree, or skip showing the terms.
    expect(APPLE_FM_LICENSE_COMMAND).not.toMatch(/--|\byes\b|accept|agree/);
  });

  test("the agent prompt for missing terms points at Apple's acceptable-use requirements", () => {
    // `fm license` links only to Apple's generic license index, so the page
    // that says what the model may be used for has to come from us.
    const url = APPLE_FM_LINKS.acceptableUse.url;
    expect(url).toBe(
      "https://developer.apple.com/support/terms/acceptable-use-requirements-for-the-foundation-models-framework/"
    );
    expect(APPLE_FM_LINK_URLS).toContain(url);
    expect(appleFmAgentPrompt(status("license-required", "Not agreed."))).toContain(url);
    // The screen links it once, from the Terminal step, not again under "From Apple".
    for (const state of APPLE_FM_STATES) {
      expect(appleFmStateCopy(status(state, null)).links).not.toContain("acceptableUse");
    }
  });
});
