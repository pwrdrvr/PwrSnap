import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import {
  LOCAL_AGENT_CAPABILITIES,
  err,
  isLocalAgentCapability,
  ok,
  type LocalAgentCapability,
  type LocalAgentConsentPrompt,
  type LocalAgentRoleProfile,
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
  roleId: string | null;
  capabilities: readonly LocalAgentCapability[];
  maxCaptureAgeDays?: number | null;
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
type RoleReader = () => Promise<LocalAgentRoleProfile[]>;

/**
 * Native user-presence boundary for loopback OAuth. HTTP can create a pending
 * request, but only a renderer hosted by the exact BrowserWindow created here
 * can inspect or resolve it through IPC.
 */
export class LocalAgentConsentBroker {
  private readonly createWindow: ConsentWindowFactory;
  private readonly makeRequestId: () => string;
  private readonly readRoles: RoleReader;
  private readonly pendingByWindowId = new Map<number, PendingConsent>();

  constructor(options: {
    createWindow?: ConsentWindowFactory;
    makeRequestId?: () => string;
    readRoles?: RoleReader;
  } = {}) {
    this.createWindow = options.createWindow ?? createLocalAgentConsentWindow;
    this.makeRequestId = options.makeRequestId ?? randomUUID;
    this.readRoles = options.readRoles ?? (async () => []);
  }

  async request(input: LocalAgentConsentRequest): Promise<LocalAgentConsentDecision> {
    if (input.signal.aborted) {
      return { decision: "deny", sessionName: "", roleId: null, capabilities: [] };
    }
    const roles = await this.readRoles();
    if (input.signal.aborted) {
      return { decision: "deny", sessionName: "", roleId: null, capabilities: [] };
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
      })),
      roles: roles
        .filter((role) => role.permissions.every((capability) => requested.has(capability)))
        .map(cloneRole)
    };

    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.finish(
          window.id,
          { decision: "deny", sessionName: "", roleId: null, capabilities: [] },
          true
        );
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
        this.finish(
          window.id,
          { decision: "deny", sessionName: "", roleId: null, capabilities: [] },
          false
        );
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
      roleId: string | null;
      capabilities: readonly LocalAgentCapability[];
      maxCaptureAgeDays?: number | null;
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
    let selectedRole: LocalAgentRoleProfile | undefined;
    if (input.decision === "allow" && input.roleId !== null) {
      selectedRole = pending.value.prompt.roles.find((role) => role.id === input.roleId);
      if (selectedRole === undefined) {
        return consentError(
          "invalid_consent_role",
          "Select a PwrSnap role available to this authorization request"
        );
      }
    }
    const requested = new Set(
      pending.value.prompt.permissions
        .filter((permission) => permission.requested)
        .map((permission) => permission.capability)
    );
    const effectiveCapabilities = selectedRole?.permissions ?? capabilities;
    if (
      input.decision === "allow" &&
      effectiveCapabilities.some((capability) => !requested.has(capability))
    ) {
      return consentError(
        "consent_scope_escalation",
        "Approval cannot grant permissions the MCP client did not request"
      );
    }
    if (input.decision === "allow" && effectiveCapabilities.length === 0) {
      return consentError("empty_consent", "Select a PwrSnap role or custom permissions");
    }
    if (
      input.decision === "allow" &&
      selectedRole === undefined &&
      !isValidCaptureAge(input.maxCaptureAgeDays)
    ) {
      return consentError(
        "invalid_capture_age",
        "Custom access requires a valid capture-history limit"
      );
    }
    this.finish(
      pending.value.window.id,
      {
        decision: input.decision,
        sessionName: input.decision === "allow" ? sessionName : "",
        roleId: input.decision === "allow" ? (selectedRole?.id ?? null) : null,
        capabilities: input.decision === "allow" ? [...effectiveCapabilities] : [],
        ...(input.decision === "allow" && selectedRole === undefined
          ? { maxCaptureAgeDays: input.maxCaptureAgeDays }
          : {})
      },
      true
    );
    return ok(undefined);
  }

  denyAll(): void {
    for (const windowId of [...this.pendingByWindowId.keys()]) {
      this.finish(
        windowId,
        { decision: "deny", sessionName: "", roleId: null, capabilities: [] },
        true
      );
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
      (typeof req.roleId !== "string" && req.roleId !== null) ||
      !Array.isArray(req.capabilities)
    ) {
      return consentError("invalid_consent_request", "Consent decision payload is invalid");
    }
    return broker.decide(context, req);
  });
}

function isValidCaptureAge(value: unknown): value is number | null {
  return value === null || (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 36_500
  );
}

function cloneRole(role: LocalAgentRoleProfile): LocalAgentRoleProfile {
  return {
    ...role,
    permissions: [...role.permissions],
    budgets: {
      search: { ...role.budgets.search },
      "preview.read": { ...role.budgets["preview.read"] },
      "original.read": { ...role.budgets["original.read"] },
      edit: { ...role.budgets.edit },
      delete: { ...role.budgets.delete }
    }
  };
}

function consentError(code: string, message: string): Result<never, PwrSnapError> {
  return err({ kind: "validation", code, message });
}
