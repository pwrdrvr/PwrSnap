// Apple's on-device Foundation Model as a caption backend.
//
// PwrSnap reaches the model through `/usr/bin/fm`, the Foundation Models
// command-line tool that ships with macOS 27. This module is the vocabulary
// main and the renderer share: the provider selector, the detected states,
// and the words Settings shows for each. Nothing here spawns anything.
//
// Every state below is one the tool itself reports (measured on macOS 27.2;
// see docs/solutions/2026-11-17-apple-fm-cli-captions-feasibility.md). The
// tool being present is NOT a state: it ships on Macs that cannot run the
// model.

/** `ai.defaults.enrichment.provider` (and `ai.enrichmentFallback.provider`)
 *  value that selects the on-device model. Captions only: chat surfaces
 *  refuse it. */
export const APPLE_FM_PROVIDER = "apple:system";

/** The model id recorded on a run, and the only one PwrSnap ever passes to
 *  `fm --model`. Never `pcc` (Private Cloud Compute leaves the Mac). */
export const APPLE_FM_MODEL_ID = "system";

/** Settings → AI Providers sub-screen id. */
export const APPLE_FM_SETTINGS_SUB = "apple";

export const APPLE_FM_DISPLAY_NAME = "Apple Intelligence";

/** What an administrator runs, in Terminal, to read and agree to Apple's
 *  terms for the tool. macOS's own sentence names `sudo fm license`; this is
 *  that command with the tool's full path, because sudo on macOS searches the
 *  user's PATH and a `fm` earlier on it would run as root. PwrSnap only
 *  offers it to copy. It never runs it, and never types it into Terminal. */
export const APPLE_FM_LICENSE_COMMAND = "sudo /usr/bin/fm license";

/** The Terminal step Settings offers for a state, or null when no command an
 *  administrator can type would fix it. Only missing terms qualify. */
export function appleFmTerminalCommand(status: AppleFmStatus): string | null {
  return status.state === "license-required" ? APPLE_FM_LICENSE_COMMAND : null;
}

export function isAppleFmProvider(provider: string | null | undefined): boolean {
  return provider === APPLE_FM_PROVIDER;
}

/**
 * What PwrSnap could establish about the on-device model.
 *
 * - `unsupported-platform`: not macOS. The provider is not shown at all.
 * - `needs-macos`: macOS, but `/usr/bin/fm` is absent (it ships with 27).
 * - `license-required`: Apple's Legal Notice & Terms for the tool have not
 *   been agreed to on this Mac. Only an administrator can, in Terminal.
 * - `provider-override`: the user's fm configuration names a default model
 *   provider. PwrSnap will not run a capture through fm in that state.
 * - `device-not-eligible` / `apple-intelligence-off` / `model-not-ready`:
 *   the three reasons macOS gives for an unavailable system model.
 * - `unavailable`: macOS gave a reason this build does not recognise;
 *   `detail` is its sentence, verbatim.
 * - `probe-failed`: the tool could not be run or its answer not read.
 * - `ready`: macOS reports the system model as available.
 */
export type AppleFmState =
  | "unsupported-platform"
  | "needs-macos"
  | "license-required"
  | "provider-override"
  | "device-not-eligible"
  | "apple-intelligence-off"
  | "model-not-ready"
  | "unavailable"
  | "probe-failed"
  | "ready";

export const APPLE_FM_STATES: readonly AppleFmState[] = [
  "unsupported-platform",
  "needs-macos",
  "license-required",
  "provider-override",
  "device-not-eligible",
  "apple-intelligence-off",
  "model-not-ready",
  "unavailable",
  "probe-failed",
  "ready"
];

export type AppleFmStatus = {
  state: AppleFmState;
  /** What macOS calls the model (e.g. "AFM 3 Core"), when ready and reported. */
  modelLabel: string | null;
  /** The tool's own sentence for a not-ready state, verbatim and bounded. */
  detail: string | null;
  /** `sw_vers`-style product version on macOS, else null. */
  macosVersion: string | null;
  /** Epoch ms of the probe that produced this answer. */
  checkedAt: number;
};

/** `appleFm:test` result: one text prompt, timed. No capture is involved. */
export type AppleFmTestResult = { ms: number; modelLabel: string | null };

/** `EVENT_CHANNELS.appleFmStatusChanged` payload. `null` = the cached answer
 *  was invalidated (a caption run failed for a setup reason) and macOS has
 *  not been asked again yet: what a window holds is stale. */
export type AppleFmStatusChangedEvent = { status: AppleFmStatus | null };

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Validate a status that crossed a process boundary. Null when it is not one. */
export function parseAppleFmStatus(value: unknown): AppleFmStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.state !== "string" || !(APPLE_FM_STATES as readonly string[]).includes(v.state)) {
    return null;
  }
  if (!isStringOrNull(v.modelLabel) || !isStringOrNull(v.detail) || !isStringOrNull(v.macosVersion)) {
    return null;
  }
  if (typeof v.checkedAt !== "number" || !Number.isFinite(v.checkedAt)) return null;
  return {
    state: v.state as AppleFmState,
    modelLabel: v.modelLabel,
    detail: v.detail,
    macosVersion: v.macosVersion,
    checkedAt: v.checkedAt
  };
}

/** Validate the broadcast payload. Null when it is malformed, which a
 *  subscriber ignores rather than treating as "invalidated". */
export function parseAppleFmStatusChangedEvent(payload: unknown): AppleFmStatusChangedEvent | null {
  if (typeof payload !== "object" || payload === null || !("status" in payload)) return null;
  const raw = (payload as { status: unknown }).status;
  if (raw === null) return { status: null };
  const status = parseAppleFmStatus(raw);
  return status === null ? null : { status };
}

/**
 * Which of two answers a window should hold. A read and a broadcast can
 * arrive in either order, so the later CHECK wins, not the later arrival:
 * an older answer never replaces a newer one.
 */
export function newerAppleFmStatus(
  current: AppleFmStatus | null | undefined,
  incoming: AppleFmStatus
): AppleFmStatus {
  if (current === null || current === undefined) return incoming;
  return incoming.checkedAt >= current.checkedAt ? incoming : current;
}

/**
 * What Settings holds after `appleFm:status` itself failed (the request, not
 * the model). On a Mac that is a `probe-failed` status carrying the error, so
 * the provider stays listed with "Check failed" and "Check again" stays
 * reachable. Off macOS there is no provider to show, so whatever was held
 * (nothing, or "not a Mac") is kept and the row stays absent.
 */
export function appleFmStatusAfterFailedRead(input: {
  platform: string | undefined;
  message: string;
  previous: AppleFmStatus | null;
  now: number;
}): AppleFmStatus | null {
  if (input.platform !== "darwin") return input.previous;
  return {
    state: "probe-failed",
    modelLabel: null,
    detail: quotableAppleFmDetail(input.message),
    macosVersion: input.previous?.macosVersion ?? null,
    checkedAt: input.now
  };
}

export function isAppleFmReady(status: AppleFmStatus | null | undefined): boolean {
  return status?.state === "ready";
}

/** Whether the provider is shown at all. Only "this is not a Mac" hides it. */
export function isAppleFmOffered(status: AppleFmStatus | null | undefined): boolean {
  return status !== null && status !== undefined && status.state !== "unsupported-platform";
}

// ---- Official references ---------------------------------------------------
// Each URL was fetched from Apple on 2026-11-17. `app:openExternal` allows
// exactly these and nothing else on the two hosts.

export const APPLE_FM_LINKS = {
  requirements: {
    label: "Apple Intelligence requirements",
    url: "https://support.apple.com/en-us/121115"
  },
  availability: {
    label: "Why a model can be unavailable",
    url: "https://developer.apple.com/documentation/foundationmodels/detecting-available-apple-foundation-models"
  },
  tool: {
    label: "Apple's Foundation Models and the fm tool",
    url: "https://developer.apple.com/foundation-models-framework/"
  },
  // What Apple's terms let the model be used for. `fm license` links only to
  // Apple's generic license index, so this page is hard to find on one's own.
  // Fetched 2026-11-18.
  acceptableUse: {
    label: "Apple's acceptable use requirements for the model",
    url: "https://developer.apple.com/support/terms/acceptable-use-requirements-for-the-foundation-models-framework/"
  }
} as const;

export type AppleFmLinkId = keyof typeof APPLE_FM_LINKS;

export const APPLE_FM_LINK_URLS: readonly string[] = Object.values(APPLE_FM_LINKS).map(
  (link) => link.url
);

// ---- Words for each state --------------------------------------------------

export type AppleFmStateCopy = {
  /** Hub badge and status-block badge. */
  badge: string;
  /** Tiny sidebar word for a state that is not fine; absent when ready. */
  chip?: string;
  title: string;
  body: string;
  /** `needs` = the Mac cannot run it as it is (grey unless captions depend
   *  on it); `attention` = a step is missing (amber); `ok` = ready. */
  severity: "ok" | "attention" | "needs";
  /** Short reason shown beside a disabled menu entry. */
  reason: string;
  links: readonly AppleFmLinkId[];
};

export function appleFmStateCopy(status: AppleFmStatus): AppleFmStateCopy {
  switch (status.state) {
    case "ready":
      return {
        badge: "Ready",
        title: "The on-device model is ready",
        body: "macOS reports the model as available. Captions run on this Mac; no account, key or network is involved.",
        severity: "ok",
        reason: "ready",
        links: []
      };
    case "license-required":
      return {
        badge: "Agree to terms",
        chip: "terms",
        title: "Apple's terms haven't been agreed to on this Mac",
        body: "Apple's Foundation Models command-line tool won't answer until its Legal Notice & Terms are agreed to. That takes an administrator, in Terminal, once per Mac. PwrSnap never agrees for you.",
        severity: "attention",
        reason: "terms not agreed",
        // The acceptable-use page is linked from the Terminal step itself, beside
        // the command that shows the terms, so it is not repeated here.
        links: ["tool"]
      };
    case "model-not-ready":
      return {
        badge: "Not ready",
        chip: "wait",
        title: "The on-device model isn't ready yet",
        body: "macOS downloads and prepares the model by itself, when network, battery and load allow. There is nothing to install. Check again later.",
        severity: "attention",
        reason: "model not ready",
        links: ["requirements", "availability"]
      };
    case "apple-intelligence-off":
      return {
        badge: "Off in macOS",
        chip: "off",
        title: "macOS says Apple Intelligence is not enabled",
        body: "The on-device model is part of Apple Intelligence. macOS reports it as not enabled on this Mac, which can also mean a language, region or management restriction.",
        severity: "attention",
        reason: "off in macOS",
        links: ["requirements", "availability"]
      };
    case "provider-override":
      return {
        badge: "Check fm config",
        chip: "config",
        title: "The fm tool is set to use another model provider",
        body: "This Mac's fm configuration names a default model provider. PwrSnap only uses the on-device model through fm, and will not run a capture through it while a default provider is set.",
        severity: "attention",
        reason: "fm uses another provider",
        links: ["tool"]
      };
    case "device-not-eligible":
      return {
        badge: "Not supported",
        chip: "n/a",
        title: "macOS says this Mac doesn't support Apple Intelligence",
        body: "Apple lists a Mac with M1 or later, a supported language and region, and free storage. Some of those can be changed; the chip can't.",
        severity: "needs",
        reason: "not supported on this Mac",
        links: ["requirements"]
      };
    case "needs-macos":
      return {
        badge: "Needs macOS 27",
        chip: "macos 27",
        title: "Needs macOS 27 or later",
        body:
          "PwrSnap reaches the on-device model through a tool that ships with macOS 27." +
          (status.macosVersion !== null ? ` This Mac runs macOS ${status.macosVersion}.` : "") +
          " There is nothing to turn on here yet.",
        severity: "needs",
        reason: "needs macOS 27",
        links: ["requirements"]
      };
    case "unavailable":
      return {
        badge: "Unavailable",
        chip: "check",
        title: "macOS reports the on-device model as unavailable",
        body: "macOS gave a reason PwrSnap doesn't recognise. Its own words are below.",
        severity: "attention",
        reason: "unavailable",
        links: ["requirements", "availability"]
      };
    case "probe-failed":
      return {
        badge: "Check failed",
        chip: "check",
        title: "PwrSnap couldn't check the on-device model",
        body: "The fm tool didn't answer, or answered in a way PwrSnap couldn't read. Check again; if it keeps failing, the detail below says what happened.",
        severity: "attention",
        reason: "check failed",
        links: ["tool"]
      };
    case "unsupported-platform":
      return {
        badge: "macOS only",
        title: "Apple's on-device model is part of macOS",
        body: "It is not available on this operating system.",
        severity: "needs",
        reason: "macOS only",
        links: []
      };
  }
}

// ---- The copyable prompt for the user's own agent --------------------------
//
// Offered instead of a manual: the user's agent can look at this Mac, and
// PwrSnap cannot do more than read what macOS reports. Rules every prompt
// keeps, pinned by apple-fm.test.ts:
//   - only commands the fm tool documents itself, plus read-only system ones;
//   - the agent is told not to agree to Apple's terms for the user, install
//     anything, change settings, or bypass a macOS protection;
//   - a state with no step an agent could take gets no prompt (null).

const PROMPT_INTRO =
  "PwrSnap wants to use Apple's on-device model for captions through the Foundation Models command-line tool (/usr/bin/fm).";

const PROMPT_GUARD =
  "Do not install anything, change system settings for me, or bypass any macOS protection. Tell me what to change and let me do it.";

/** The tool's sentence, made safe to quote inside a prompt: backticks,
 *  quotes and line breaks are what would let quoted text read as an
 *  instruction or a command of the prompt's own, so they are removed. */
export function quotableAppleFmDetail(detail: string | null): string | null {
  if (detail === null) return null;
  const clean = detail
    .replace(/[`"\u201c\u201d\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return clean.length > 0 ? clean : null;
}

export function appleFmAgentPrompt(status: AppleFmStatus): string | null {
  const detail = quotableAppleFmDetail(status.detail);
  const said = detail !== null ? ` The tool said: "${detail}"` : "";
  switch (status.state) {
    case "license-required":
      return [
        `${PROMPT_INTRO} PwrSnap reports that Apple's Legal Notice & Terms for that tool have not been agreed to on this Mac.${said}`,
        "",
        "Please help me, without agreeing to anything on my behalf:",
        "1. Run `/usr/bin/fm license --status` and `/usr/bin/fm license --show`, and show me the output so I can read the terms myself.",
        `   Apple's acceptable use requirements for the model, which say what it may be used for, are at ${APPLE_FM_LINKS.acceptableUse.url}. Point me to them as well; the tool's own license output does not link to them.`,
        `2. The tool says to run \`sudo fm license\` in Terminal. With the tool's full path that is \`${APPLE_FM_LICENSE_COMMAND}\`; use that form, because sudo searches my PATH. Tell me what it does (the agreement applies to every user on this Mac) and let me run it myself. Do not run it for me.`,
        "3. When I say I've done it, run `/usr/bin/fm license --status` and `/usr/bin/fm models`, and tell me whether `system` is available.",
        "",
        PROMPT_GUARD,
        `References: ${APPLE_FM_LINKS.tool.url} and ${APPLE_FM_LINKS.acceptableUse.url}`
      ].join("\n");
    case "model-not-ready":
    case "apple-intelligence-off":
    case "unavailable":
      return [
        `${PROMPT_INTRO} macOS reports the on-device model as unavailable.${said}`,
        "",
        "Please check, read-only, and tell me what is most likely holding it up:",
        "1. `/usr/bin/fm models` and `sw_vers`.",
        "2. Free space on the startup disk. Apple lists up to 14 GB for the models on some Macs and up to 8 GB on others.",
        "3. Whether the Mac is on power and a network, and whether a macOS update was installed recently (the models are downloaded again after updates).",
        "4. Whether the device language and the Siri language are the same supported language, and whether the Mac is managed by an organisation that restricts Apple Intelligence.",
        "",
        "macOS downloads the model by itself. Do not try to force a download.",
        PROMPT_GUARD,
        `References: ${APPLE_FM_LINKS.requirements.url} and ${APPLE_FM_LINKS.availability.url}`
      ].join("\n");
    case "provider-override":
      return [
        `${PROMPT_INTRO} PwrSnap reports that this Mac's fm configuration names a default model provider, so it will not run captures through fm.`,
        "",
        "Please help me decide what to do:",
        "1. Run `/usr/bin/fm config list` and `/usr/bin/fm config path`, and show me the output.",
        "2. Explain what the configured default model provider is and what else on this Mac might rely on it.",
        "3. Show me what `/usr/bin/fm config --help` says about changing it. Do not change the configuration for me; I'll decide.",
        "",
        PROMPT_GUARD,
        `Reference: ${APPLE_FM_LINKS.tool.url}`
      ].join("\n");
    case "device-not-eligible":
      return [
        `${PROMPT_INTRO} macOS reports that this Mac does not support Apple Intelligence.${said}`,
        "",
        "Please check, read-only, which of Apple's requirements this Mac misses:",
        "1. `sw_vers`, and the chip (`sysctl -n machdep.cpu.brand_string`).",
        "2. Free space on the startup disk.",
        "3. The device language and region, and the Siri language.",
        "",
        "Tell me plainly if the hardware cannot run it, so I stop trying.",
        PROMPT_GUARD,
        `Reference: ${APPLE_FM_LINKS.requirements.url}`
      ].join("\n");
    case "probe-failed":
      return [
        `${PROMPT_INTRO} PwrSnap could not read the tool's answer.${said}`,
        "",
        "Please run these and show me the output, including any error:",
        "1. `sw_vers` and `ls -l /usr/bin/fm`.",
        "2. `/usr/bin/fm license --status`.",
        "3. `/usr/bin/fm models`.",
        "",
        PROMPT_GUARD,
        `Reference: ${APPLE_FM_LINKS.tool.url}`
      ].join("\n");
    case "needs-macos":
      return [
        `${PROMPT_INTRO} That tool ships with macOS 27, and PwrSnap did not find it on this Mac${
          status.macosVersion !== null ? `, which runs macOS ${status.macosVersion}` : ""
        }.`,
        "",
        "Please check whether this Mac can get there, and guide me:",
        "1. Run `sw_vers` and `sysctl -n machdep.cpu.brand_string`, and confirm `/usr/bin/fm` is absent with `ls -l /usr/bin/fm`.",
        "2. Tell me whether this Mac model can run macOS 27 and Apple Intelligence, using Apple's own pages. Apple lists a Mac with M1 or later.",
        "3. If it can, walk me through updating with Software Update in System Settings. I'll start the update myself.",
        "",
        "Do not suggest beta software, unofficial installers or patchers. If this Mac cannot run it, say so plainly.",
        PROMPT_GUARD,
        `Reference: ${APPLE_FM_LINKS.requirements.url}`
      ].join("\n");
    case "unsupported-platform":
    case "ready":
      return null;
  }
}
