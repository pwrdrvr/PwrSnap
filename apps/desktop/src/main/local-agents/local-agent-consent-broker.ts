import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import {
  LOCAL_AGENT_CAPABILITIES,
  err,
  isLocalAgentCapability,
  ok,
  type LocalAgentCapability,
  type LocalAgentConsentPrompt,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import { bus, type CommandContext } from "../command-bus";
import { createLocalAgentConsentWindow } from "../window";
import {
  LOCAL_AGENT_CAPABILITY_DETAILS,
  LOCAL_AGENT_CAPABILITY_LABELS
} from "./local-agent-oauth";

export type LocalAgentConsentRequest = {
  clientId: string;
  clientName: string;
  requestedCapabilities: readonly LocalAgentCapability[];
  signal: AbortSignal;
};

export type LocalAgentConsentDecision = {
  decision: "allow" | "deny";
  sessionName: string;
  capabilities: readonly LocalAgentCapability[];
};

type ConsentWindow = Pick<BrowserWindow, "id" | "close" | "isDestroyed" | "once">;

type PendingConsent = {
  prompt: LocalAgentConsentPrompt;
  window: ConsentWindow;
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (decision: LocalAgentConsentDecision) => void;
};

type ConsentWindowFactory = () => ConsentWindow;

/**
 * Native user-presence boundary for loopback OAuth. HTTP can create a pending
 * request, but only a renderer hosted by the exact BrowserWindow created here
 * can inspect or resolve it through IPC.
 */
export class LocalAgentConsentBroker {
  private readonly createWindow: ConsentWindowFactory;
  private readonly makeRequestId: () => string;
  private readonly pendingByWindowId = new Map<number, PendingConsent>();

  constructor(options: {
    createWindow?: ConsentWindowFactory;
    makeRequestId?: () => string;
  } = {}) {
    this.createWindow = options.createWindow ?? createLocalAgentConsentWindow;
    this.makeRequestId = options.makeRequestId ?? randomUUID;
  }

  request(input: LocalAgentConsentRequest): Promise<LocalAgentConsentDecision> {
    if (input.signal.aborted) {
      return Promise.resolve({ decision: "deny", sessionName: "", capabilities: [] });
    }
    const window = this.createWindow();
    const requestId = this.makeRequestId();
    const requested = new Set(input.requestedCapabilities);
    const prompt: LocalAgentConsentPrompt = {
      requestId,
      clientName: input.clientName,
      suggestedSessionName: input.clientName,
      permissions: LOCAL_AGENT_CAPABILITIES.map((capability) => ({
        capability,
        label: LOCAL_AGENT_CAPABILITY_LABELS[capability],
        detail: LOCAL_AGENT_CAPABILITY_DETAILS[capability],
        requested: requested.has(capability)
      }))
    };

    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.finish(window.id, { decision: "deny", sessionName: "", capabilities: [] }, true);
      };
      const pending: PendingConsent = {
        prompt,
        window,
        signal: input.signal,
        onAbort,
        resolve
      };
      this.pendingByWindowId.set(window.id, pending);
      input.signal.addEventListener("abort", onAbort, { once: true });
      window.once("closed", () => {
        this.finish(window.id, { decision: "deny", sessionName: "", capabilities: [] }, false);
      });
    });
  }

  read(context: CommandContext): Result<LocalAgentConsentPrompt, PwrSnapError> {
    const pending = this.pendingForTrustedWindow(context);
    return pending.ok ? ok(pending.value.prompt) : pending;
  }

  decide(
    context: CommandContext,
    input: {
      requestId: string;
      decision: "allow" | "deny";
      sessionName: string;
      capabilities: readonly LocalAgentCapability[];
    }
  ): Result<void, PwrSnapError> {
    const pending = this.pendingForTrustedWindow(context);
    if (!pending.ok) return pending;
    if (input.requestId !== pending.value.prompt.requestId) {
      return consentError("consent_request_mismatch", "Consent request does not match this window");
    }
    if (input.decision !== "allow" && input.decision !== "deny") {
      return consentError("invalid_consent_decision", "Consent decision is invalid");
    }
    if (!Array.isArray(input.capabilities) || !input.capabilities.every(isLocalAgentCapability)) {
      return consentError("invalid_consent_capability", "Consent contains an unknown permission");
    }
    const capabilities = [...new Set(input.capabilities)];
    const sessionName = input.sessionName.trim();
    if (input.decision === "allow" && (sessionName.length === 0 || sessionName.length > 200)) {
      return consentError(
        "invalid_session_name",
        "Session Name must be between 1 and 200 characters"
      );
    }
    if (input.decision === "allow" && capabilities.length === 0) {
      return consentError("empty_consent", "Select at least one PwrSnap permission");
    }
    this.finish(
      pending.value.window.id,
      {
        decision: input.decision,
        sessionName: input.decision === "allow" ? sessionName : "",
        capabilities: input.decision === "allow" ? capabilities : []
      },
      true
    );
    return ok(undefined);
  }

  denyAll(): void {
    for (const windowId of [...this.pendingByWindowId.keys()]) {
      this.finish(windowId, { decision: "deny", sessionName: "", capabilities: [] }, true);
    }
  }

  private pendingForTrustedWindow(
    context: CommandContext
  ): Result<PendingConsent, PwrSnapError> {
    if (context.principal !== "ipc" || context.sourceWindowId === undefined) {
      return consentError("untrusted_consent_source", "Consent requires a PwrSnap approval window");
    }
    const pending = this.pendingByWindowId.get(context.sourceWindowId);
    if (pending === undefined) {
      return consentError("untrusted_consent_window", "This window does not own a consent request");
    }
    return ok(pending);
  }

  private finish(
    windowId: number,
    decision: LocalAgentConsentDecision,
    closeWindow: boolean
  ): void {
    const pending = this.pendingByWindowId.get(windowId);
    if (pending === undefined) return;
    this.pendingByWindowId.delete(windowId);
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(decision);
    if (closeWindow && !pending.window.isDestroyed()) pending.window.close();
  }
}

export function registerLocalAgentConsentHandlers(
  broker: LocalAgentConsentBroker
): void {
  bus.register("localAgents:consentRead", async (_req, context) => broker.read(context));
  bus.register("localAgents:consentDecide", async (req, context) => {
    if (
      typeof req !== "object" ||
      req === null ||
      typeof req.requestId !== "string" ||
      typeof req.sessionName !== "string" ||
      !Array.isArray(req.capabilities)
    ) {
      return consentError("invalid_consent_request", "Consent decision payload is invalid");
    }
    return broker.decide(context, req);
  });
}

function consentError(code: string, message: string): Result<never, PwrSnapError> {
  return err({ kind: "validation", code, message });
}
