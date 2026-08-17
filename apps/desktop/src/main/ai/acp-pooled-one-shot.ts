// One-shot ACP runs on the SHARED pooled agent process. There is exactly ONE
// OS process per (agent, resolved binary) app-wide — see acp-agent-pool.ts —
// so enrichment and model listing must NOT spawn their own. These helpers open
// a throwaway session on the pooled client, run/observe it, then archive the
// session so the app-lifetime shared client doesn't accumulate dead session
// state. The process itself stays warm in the pool until app quit.
//
// Why not the kit's `AcpOneShotClient`: that class owns a PRIVATE transport —
// every instance is its own agent process, which is exactly the
// short-lived-second-instance shape the pool exists to prevent. It also
// registers client-level deny handlers that would clobber the pooled client's
// approval policy. So the (small) one-shot dance is reimplemented here against
// the shared client's public API, with two deliberate differences:
//
//   • `rawText` prefers the `agent_message_delta` stream (pure assistant
//     text). The coalesced `agent_message` folds surfaced thoughts into the
//     final text under the chat strategies' `surfaceThoughts` quirk —
//     reasoning prose that buries a JSON reply. (The old per-run client
//     suppressed thoughts via a cloned strategy; on a shared client the
//     strategy serves chat too, so suppression moves to event selection.)
//   • No client-level handler registration: the pooled approval policy
//     (approve PwrSnap's MCP tools, deny agent built-ins) already gives a
//     tool-less one-shot the right behavior, and `onApprovalRequest` /
//     `onToolCall` are single-handler registrations we must not clobber.

import type { DiscoveredAcpAgent, AcpRuntimeModel } from "@pwrdrvr/agent-acp";
import { modelsFromCapabilities } from "@pwrdrvr/agent-acp";
import type { NormalizedTokenUsage } from "@pwrdrvr/agent-core";
import { acquireAcpAgentClient } from "./acp-agent-pool";
import {
  markEnrichmentThread,
  unmarkEnrichmentThread,
  type EnrichmentRunDiagnostics
} from "./enrichment-sandbox";

/** The cancel signal the enrichment handler classifies on (`isAbort`) — a
 *  DOMException named AbortError, matching what Codex-side cancels surface. */
function abortError(): DOMException {
  return new DOMException("ACP one-shot aborted", "AbortError");
}

export type PooledAcpOneShotRequest = {
  /** Full prompt text — the caller folds in any system preamble + contract. */
  prompt: string;
  /** Local image file paths attached to the turn. */
  imagePaths?: readonly string[];
  /** Model id to select for the session. Omit/null for the agent default. */
  model?: string | null;
  /** Reasoning effort token (agent-specific). */
  effort?: string;
  abortSignal?: AbortSignal;
  /** Present when this one-shot is a capture-enrichment run. Registers the
   *  session in the enrichment-thread registry for the run's duration so the
   *  app-lifetime pooled approval handler — shared with chat, and given only a
   *  session id — can tell an enrichment escalation (error) from the chat
   *  agent's routine denied shell request (warn). */
  diagnostics?: EnrichmentRunDiagnostics;
};

export type PooledAcpOneShotResponse = {
  /** The agent's final assistant-message text. Caller parses + validates it. */
  rawText: string;
  threadId: string;
  turnId: string;
  /** The EFFECTIVE model (what the session actually ran) — "" when the agent
   *  advertises none. Never the requested id when the agent ignored it. */
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  tokenUsage: NormalizedTokenUsage | null;
};

/**
 * Run one prompt→reply turn in a throwaway session on the pooled client for
 * `agent`, spawning the shared process on first use. Concurrent runs (and
 * concurrent chat turns) are fine — sessions on one ACP process are
 * independent. On abort the in-flight turn is interrupted best-effort and the
 * run rejects IMMEDIATELY with an `AbortError` DOMException — the same signal
 * Codex cancels produce — so the enrichment handler routes a user cancel to
 * `cancelAiRun`, not `failAiRun`, and the caller never sees (or retries on)
 * the truncated text of a cancelled turn. The session is always archived
 * afterwards.
 */
export async function runPooledAcpOneShot(input: {
  agent: DiscoveredAcpAgent;
  /** Scratch cwd for the pooled client (see `acpPoolScratchCwd`). */
  cwd: string;
  request: PooledAcpOneShotRequest;
}): Promise<PooledAcpOneShotResponse> {
  const { agent, request } = input;
  // Inside a function so each call re-reads the signal — `aborted` flips
  // across the awaits below, which inline narrowing would reason away.
  const throwIfAborted = (): void => {
    if (request.abortSignal?.aborted === true) throw abortError();
  };
  throwIfAborted();
  const client = await acquireAcpAgentClient(agent, input.cwd);
  // A cancel during the acquire (a cold pool pays the multi-second agent
  // spawn here) arrives before any session exists — bail before opening one.
  throwIfAborted();
  const thread = await client.startThread(
    request.model !== undefined && request.model !== null ? { model: request.model } : {}
  );
  if (request.diagnostics !== undefined) {
    markEnrichmentThread(thread.threadId, request.diagnostics);
  }
  let finalText = "";
  const deltas: string[] = [];
  let usage: NormalizedTokenUsage | null = null;
  let turnError: string | null = null;
  let settle: (status: string) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const done = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // If startTurn throws while an abort races in, `done`'s rejection would
  // otherwise be unhandled — mark it handled up front.
  done.catch(() => undefined);
  const unsubscribe = client.onEvent((event) => {
    if (!("threadId" in event) || event.threadId !== thread.threadId) return;
    if (event.kind === "agent_message") {
      // The normalizer also emits `agent_message` for user_message_chunk
      // echoes (role "user"); a prompt echo must never become the reply.
      if (event.message.role === "assistant") finalText = event.message.text;
    } else if (event.kind === "agent_message_delta") deltas.push(event.delta);
    else if (event.kind === "token_usage") usage = event.usage;
    else if (event.kind === "error") turnError = event.message;
    else if (event.kind === "turn_completed") settle(event.status);
  });
  const onAbort = (): void => {
    // Reject FIRST (a settled promise ignores the later turn_completed), then
    // best-effort stop the agent — session/cancel timing varies by agent, and
    // an agent that honors it instantly must not turn the cancel into a
    // plain "turn cancelled" failure. A cancelled turn's partial output must
    // never flow onward as a reply.
    fail(abortError());
    void client.interruptTurn(thread.threadId).catch(() => undefined);
  };
  request.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    // A cancel during session/new landed before the listener above existed,
    // and adding an "abort" listener to an already-aborted signal never fires
    // it retroactively — re-check now that the listener covers what follows
    // (inside the try, so the just-opened session is still archived).
    throwIfAborted();
    const { turnId } = await client.startTurn({
      threadId: thread.threadId,
      input: {
        text: request.prompt,
        ...(request.imagePaths !== undefined && request.imagePaths.length > 0
          ? { imagePaths: request.imagePaths }
          : {})
      },
      ...(request.effort !== undefined ? { reasoning: request.effort } : {})
    });
    const status = await done;
    if (status !== "completed") {
      throw new Error(turnError ?? `ACP one-shot turn ${status}`);
    }
    const rawText = deltas.length > 0 ? deltas.join("") : finalText;
    return {
      rawText,
      threadId: thread.threadId,
      turnId,
      model: thread.model ?? "",
      modelProvider: thread.modelProvider ?? agent.backendId,
      serviceTier: thread.serviceTier ?? null,
      tokenUsage: usage
    };
  } finally {
    request.abortSignal?.removeEventListener("abort", onAbort);
    unmarkEnrichmentThread(thread.threadId);
    unsubscribe();
    // Drop the throwaway session locally (ACP has no remote delete); without
    // this every one-shot leaks an AcpSessionState for the app's lifetime.
    await client.archiveThread(thread.threadId).catch(() => undefined);
  }
}

/**
 * Read the agent's advertised models via a throwaway session on the pooled
 * client (ACP agents report runtime capabilities on `session/new`). Returns []
 * when the agent advertises none. `onRuntimeCapabilities` is a single-handler
 * registration, but nothing else in PwrSnap registers it on the pooled client
 * (chat surfaces run `backendClientShared` and skip client-level handlers), so
 * the temporary subscribe/unsubscribe here can't clobber anyone.
 */
export async function listPooledAcpModels(input: {
  agent: DiscoveredAcpAgent;
  /** Scratch cwd for the pooled client (see `acpPoolScratchCwd`). */
  cwd: string;
}): Promise<AcpRuntimeModel[]> {
  const client = await acquireAcpAgentClient(input.agent, input.cwd);
  let models: AcpRuntimeModel[] = [];
  const unsubscribe = client.onRuntimeCapabilities((event) => {
    const observed = modelsFromCapabilities(event.runtimeCapabilities);
    if (observed.length > 0) models = observed;
  });
  let threadId: string | null = null;
  try {
    const thread = await client.startThread();
    threadId = thread.threadId;
    return models;
  } finally {
    unsubscribe();
    if (threadId !== null) {
      await client.archiveThread(threadId).catch(() => undefined);
    }
  }
}
