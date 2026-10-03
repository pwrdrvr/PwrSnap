// AI Providers → one Direct API connection, or a new one.
//
// A NEW connection is a stepped page, each step saving as it passes (Claude
// Design board 2a/2b):
//
//   1. Where      — name, protocol, base URL, and the exact request URL.
//   2. Sign in    — no auth, a write-only API key, or OAuth.
//   3. Models     — the endpoint's list, ticked into PwrSnap's pickers, with
//                   image input answered per model (Yes / No / Unknown).
//   4. Use it for — optional job defaults.
//
// A SAVED connection is a provider screen like Codex's or an agent's (board
// 3a): the "Default for" strip, then Endpoint, Credential and Models cards,
// each read-only until its Edit. The stepper is for getting somewhere; once
// there, the page answers "what is this and is it working", and a card that
// still needs something opens on its own.
//
// Main owns the configuration (`customModels:*`); this page never holds a
// key after handing it over, and never infers what a model can do from its
// name or its endpoint.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  apiUrlSchema,
  builtInAcpAgentDisplayName,
  connectionSettingsSub,
  customOAuthSchema,
  customProviderId,
  customEnrichmentConcurrency,
  DEFAULT_CUSTOM_MAX_OUTPUT_TOKENS,
  isLoopbackApiUrl,
  type AiSurfaceId,
  type CustomAuth,
  type CustomConnection,
  type CustomConnectionInput,
  type CustomEnrichmentReasoning,
  type CustomModel,
  type CustomModelDiscovery,
  type CustomModelInput,
  type CustomOAuth,
  type CustomProtocol,
  type SecretStatus,
  type Settings,
  type SettingsPatch
} from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import { useAiProvidersContext } from "../AiProvidersContext";
import { AI_SURFACE_LABELS, statusBadgeClass } from "../ai-provider-status";
import { Card, ProviderDefaultsStrip, Row, SegmentedControl, Switch, type SegmentOption } from "../components";
import {
  CONNECTION_TEMPLATES,
  LOCAL_SERVER_PORTS,
  PROTOCOL_LABELS,
  connectionSecret,
  plural,
  requestUrl,
  suggestModelName,
  whereLabel,
  type ConnectionStatus,
  type ConnectionTemplate
} from "../direct-api-status";
import { useSettingsContext } from "../SettingsContext";
import { setActivePage } from "../useActivePage";
import { formatLastSetAt } from "./ai-format";
import { ChatgptConnectionPage } from "./ChatgptConnection";

type StepId = "where" | "auth" | "models" | "jobs";
type Note = { tone: "ok" | "warn" | "bad"; text: ReactNode };
/** The endpoint's model list, remembered for the connection it was read
 *  from — a list read before the address changed is not this one's. */
export type Discovery =
  | { key: string; kind: "loading" }
  | { key: string; kind: "done"; result: CustomModelDiscovery }
  | { key: string; kind: "error"; message: string; rejected: boolean };

const PROTOCOL_OPTIONS: readonly SegmentOption<CustomProtocol>[] = [
  { id: "openai-chat", label: PROTOCOL_LABELS["openai-chat"] },
  { id: "openai-responses", label: PROTOCOL_LABELS["openai-responses"] },
  { id: "anthropic-messages", label: PROTOCOL_LABELS["anthropic-messages"] }
];
const AUTH_OPTIONS: readonly SegmentOption<CustomAuth["type"]>[] = [
  { id: "none", label: "No auth" },
  { id: "api-key", label: "API key" },
  { id: "oauth", label: "OAuth" }
];
/** Jobs in the order the step lists them. */
const JOB_ORDER: readonly AiSurfaceId[] = ["libraryChat", "sizzleChat", "enrichment"];

function endpointKey(c: CustomConnection): string {
  return JSON.stringify([c.baseUrl.replace(/\/+$/, ""), c.protocol, c.auth]);
}
function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
function messageOf(r: { ok: false; error: { message: string } }): string {
  return r.error.message;
}

/** The endpoint's model list for `connection`, read on request. Both
 *  layouts use it: the sign-in check IS a listing (no model runs). */
export function useDiscovery(connection: CustomConnection | null): {
  current: Discovery | null;
  runDiscover: () => Promise<Discovery | null>;
} {
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const seqRef = useRef(0);
  const listFor = connection === null ? null : endpointKey(connection);
  const current = discovery !== null && discovery.key === listFor ? discovery : null;
  const runDiscover = async (): Promise<Discovery | null> => {
    if (connection === null) return null;
    const key = endpointKey(connection);
    const seq = ++seqRef.current;
    setDiscovery({ key, kind: "loading" });
    const r = await dispatch("customModels:discover", { connectionId: connection.id });
    const next: Discovery = r.ok ? { key, kind: "done", result: r.value }
      : { key, kind: "error", message: messageOf(r), rejected: r.error.code === "custom_model_unauthorized" };
    if (seq === seqRef.current) setDiscovery(next);
    return next;
  };
  return { current, runDiscover };
}

export function ConnectionPage({ connectionId }: { connectionId: string | null }): ReactElement {
  const { settings } = useSettingsContext();
  const { connections } = useAiProvidersContext();
  if (connectionId === null) return <NewConnection />;
  const status = connections.find((c) => c.connection.id === connectionId);
  if (status === undefined) {
    return (
      <>
        <PageHeader title="Connection" sub={settings === null ? "Loading…" : "This connection was removed."} />
        {settings !== null ? (
          <button className="pss__key-btn" type="button" onClick={() => setActivePage("ai")}>
            Back to AI Providers
          </button>
        ) : null}
      </>
    );
  }
  if (status.connection.auth.type === "chatgpt") return <ChatgptConnectionPage status={status} />;
  return <SavedConnection status={status} />;
}

// ---- A new connection: the stepper ------------------------------------------

function NewConnection(): ReactElement {
  const { settings, secrets, patch } = useSettingsContext();
  const { connections } = useAiProvidersContext();
  // A new connection exists from step 1 on; the route stays on "new" so the
  // flow keeps its place, and this remembers which one it made.
  const [created, setCreated] = useState<CustomConnection | null>(null);
  const [template, setTemplate] = useState<ConnectionTemplate | null>(null);
  const [open, setOpen] = useState<ReadonlySet<StepId>>(new Set());

  const status = created === null ? undefined : connections.find((c) => c.connection.id === created.id);
  // Until the settings broadcast lands, the connection step 1 just made.
  const connection = status?.connection ?? created;
  const models = status?.models ?? [];
  const secret = connection === null ? null : connectionSecret(secrets, connection.id);
  const credentialReady = connection === null ? false
    : connection.auth.type === "none" ? true : secret?.configured === true;
  const { current, runDiscover } = useDiscovery(connection);

  const whereDone = connection !== null;
  const modelsDone = models.length > 0;
  // A stored credential the endpoint turned down (401/403) is not a finished
  // sign-in: the step reopens rather than sending the operator on to models.
  const rejected = current?.kind === "error" && current.rejected;
  const signedIn = credentialReady && !rejected;
  const next: StepId = !whereDone ? "where" : !signedIn ? "auth" : !modelsDone ? "models" : "jobs";
  const locked = (step: StepId): boolean =>
    step === "auth" ? !whereDone : step === "models" ? !whereDone || !credentialReady : step === "jobs" ? !modelsDone : false;
  const expanded = (step: StepId): boolean => !locked(step) && (step === next || open.has(step));
  const setStepOpen = (step: StepId, on: boolean): void => {
    setOpen((prev) => {
      const out = new Set(prev);
      if (on) out.add(step); else out.delete(step);
      return out;
    });
  };
  const stateOf = (step: StepId, done: boolean): StepState =>
    locked(step) ? "locked" : step === next ? "current" : done ? "done" : "idle";

  const where = connection === null ? null : whereLabel(connection.baseUrl);
  const listSuffix = current === null ? "" : current.kind === "loading" ? " · listing models…"
    : current.kind === "error" ? " · listing failed" : ` · listed ${plural(current.result.models.length, "model")}`;
  const authSummary = connection === null ? "after Where"
    : rejected ? `${connection.auth.type === "oauth" ? "sign-in" : "key"} turned down by the endpoint`
    : !credentialReady
    ? (connection.auth.type === "oauth" ? "not signed in" : "no key yet")
    : connection.auth.type === "none" ? (where?.local ? "not needed on this computer" : "no auth") + listSuffix
    : connection.auth.type === "oauth" ? `Signed in · ${formatLastSetAt(secret?.lastSetAt ?? null)}${listSuffix}`
    : `API key · saved ${formatLastSetAt(secret?.lastSetAt ?? null)}${listSuffix}`;
  const routedJobs = JOB_ORDER.filter((surface) =>
    models.some((m) => settings?.ai.defaults[surface].provider === customProviderId(m.id)));

  const sub = `${template !== null ? `Started from ${template.name}. ` : ""}Every step saves as it passes — leave at any point and the connection is still here, marked with what it still needs.`;

  return (
    <>
      <PageHeader title="New connection" sub={sub} />

      <Step n={1} title="Where" state={stateOf("where", whereDone)}
        summary={connection === null ? "" : `${PROTOCOL_LABELS[connection.protocol]} · ${where?.local ? "this computer" : where?.text}`}
        right={whereDone ? <ToggleButton open={expanded("where")} label="Edit" onToggle={(on) => setStepOpen("where", on)} /> : null}>
        {expanded("where") ? (
          <WhereStep
            connection={connection}
            credentialConfigured={secret?.configured === true}
            template={template}
            onTemplate={setTemplate}
            onSaved={(saved) => {
              if (created === null) setCreated(saved);
              setStepOpen("where", false);
            }}
            onCancel={whereDone ? () => setStepOpen("where", false) : null}
          />
        ) : null}
      </Step>

      <Step n={2} title="Sign in" state={stateOf("auth", signedIn)} summary={authSummary}
        summaryOk={current?.kind === "done" && credentialReady}
        right={whereDone && signedIn ? (
          <ToggleButton open={expanded("auth")} label="Change" onToggle={(on) => setStepOpen("auth", on)} />
        ) : null}>
        {expanded("auth") && connection !== null ? (
          <AuthStep
            key={endpointKey(connection)}
            connection={connection}
            secret={secret}
            initialKind={template?.auth === "oauth" && connection.auth.type === "api-key" && !credentialReady ? "oauth" : connection.auth.type}
            rejected={rejected ? (current?.kind === "error" ? current.message : null) : null}
            onCheck={runDiscover}
            onDone={() => setStepOpen("auth", false)}
          />
        ) : null}
      </Step>

      <Step n={3} title="Models" state={stateOf("models", modelsDone)}
        summary={locked("models") ? "after sign in" : `${models.length} saved${current?.kind === "done" ? ` of ${current.result.models.length} listed` : ""}`}
        right={!locked("models") ? (
          <>
            {expanded("models") ? <ListAgainButton discovery={current} onDiscover={runDiscover} /> : null}
            {modelsDone ? <ToggleButton open={expanded("models")} label="Edit" onToggle={(on) => setStepOpen("models", on)} /> : null}
          </>
        ) : null}>
        {expanded("models") && connection !== null ? (
          <ModelsStep
            connection={connection}
            models={models}
            discovery={current}
            onDiscover={runDiscover}
            onSaved={() => setStepOpen("models", false)}
          />
        ) : null}
      </Step>

      <Step n={4} title="Use it for" state={stateOf("jobs", routedJobs.length > 0)}
        summary={routedJobs.length > 0 ? `Default for ${routedJobs.map((s) => AI_SURFACE_LABELS[s]).join(" · ")}` : "optional — or later in AI Features"}>
        {expanded("jobs") && settings !== null ? <JobsStep models={models} settings={settings} patch={patch} /> : null}
      </Step>

      <div className="pss__dapi-actions">
        {connection === null ? (
          <button className="pss__key-btn" type="button" onClick={() => setActivePage("ai")}>
            Cancel
          </button>
        ) : (
          <RemoveConnection connection={connection} models={models} label="Discard connection" />
        )}
        <span className="pss__dapi-spacer" />
        {next === "jobs" && connection !== null ? (
          <button className="pss__key-btn is-primary" type="button"
            onClick={() => setActivePage("ai", connectionSettingsSub(connection.id))}>
            Done
          </button>
        ) : null}
      </div>
    </>
  );
}

// ---- A saved connection: a provider screen ----------------------------------

type SectionId = "endpoint" | "credential" | "models";

function SavedConnection({ status }: { status: ConnectionStatus }): ReactElement {
  const { settings, secrets } = useSettingsContext();
  const { connection, models } = status;
  const [editing, setEditing] = useState<ReadonlySet<SectionId>>(new Set());
  const secret = connectionSecret(secrets, connection.id);
  const credentialReady = connection.auth.type === "none" || secret?.configured === true;
  const { current, runDiscover } = useDiscovery(connection);
  const rejected = current?.kind === "error" && current.rejected;
  const where = whereLabel(connection.baseUrl);

  // The card that still needs something is open without an Edit — and
  // cannot be closed until it has it.
  const needs: SectionId | null = !credentialReady || rejected ? "credential" : models.length === 0 ? "models" : null;
  const isOpen = (s: SectionId): boolean => s === needs || editing.has(s);
  const setSection = (s: SectionId, on: boolean): void => {
    setEditing((prev) => {
      const out = new Set(prev);
      if (on) out.add(s); else out.delete(s);
      return out;
    });
  };
  const toggle = (s: SectionId, label: string): ReactNode =>
    s === needs ? null : <ToggleButton open={isOpen(s)} label={label} onToggle={(on) => setSection(s, on)} />;

  const routed = settings === null ? [] : (["enrichment", "libraryChat", "sizzleChat"] as const).filter((surface) =>
    models.some((m) => settings.ai.defaults[surface].provider === customProviderId(m.id)));
  const badge = rejected
    ? { tone: "bad" as const, text: connection.auth.type === "oauth" ? "Sign-in rejected" : "Key rejected" }
    : { tone: status.tone, text: status.badge };
  const auth = connection.auth;
  const credentialTitle = auth.type === "none" ? "No sign-in" : auth.type === "api-key" ? "API key" : "OAuth sign-in";

  return (
    <>
      <PageHeader
        title={connection.name}
        sub="Called by PwrSnap directly, with no agent in between. Chat gets the conversation and the image you're viewing, with no editing tools and no reasoning control."
        right={<span className={"pss__badge" + statusBadgeClass(badge.tone)}>{badge.text}</span>}
      />
      <ProviderDefaultsStrip routed={routed} onEdit={() => setActivePage("ai-features", "default-agents")} />

      <Card eyebrow="CONNECTION" title="Endpoint" headerAction={toggle("endpoint", "Edit")}>
        {isOpen("endpoint") ? (
          <div className="pss__dapi-edit">
            <WhereStep
              connection={connection}
              credentialConfigured={secret?.configured === true}
              template={null}
              onTemplate={() => undefined}
              onSaved={() => setSection("endpoint", false)}
              onCancel={() => setSection("endpoint", false)}
            />
          </div>
        ) : (
          <>
            <Row label="Where requests go" sub={where.local
              ? "This computer. Requests never leave it."
              : auth.type === "none" ? "Over HTTPS to this address." : "Over HTTPS. The credential is bound to this address: point the connection somewhere else and it asks for a new one."}>
              <span className="pss__dapi-chips">
                <span className="pss__dapi-cap">{PROTOCOL_LABELS[connection.protocol].toUpperCase()}</span>
                <span className={"pss__dapi-cap" + (where.local ? " is-local" : "")}>{where.text}</span>
              </span>
              <RequestPreview baseUrl={connection.baseUrl} protocol={connection.protocol} />
            </Row>
            <Row label="Parallel enrichments" sub="Captures this connection works on at once, shared by all its models. Default: 1 on this computer, 2 elsewhere.">
              <span className="pss__dapi-value">
                {customEnrichmentConcurrency(connection)} at a time{connection.enrichmentConcurrency === undefined ? " (default)" : ""}
              </span>
            </Row>
          </>
        )}
      </Card>

      <Card eyebrow="CREDENTIAL" title={credentialTitle} headerAction={toggle("credential", "Change")}>
        {isOpen("credential") ? (
          <div className="pss__dapi-edit">
            <AuthStep
              key={endpointKey(connection)}
              connection={connection}
              secret={secret}
              initialKind={auth.type}
              rejected={rejected && current?.kind === "error" ? current.message : null}
              onCheck={runDiscover}
              onDone={() => setSection("credential", false)}
            />
          </div>
        ) : (
          <Row label={auth.type === "none" ? "Sign-in" : auth.type === "api-key" ? "Key" : "Sign-in"}
            sub={auth.type === "none"
              ? "Nothing is sent but the request itself."
              : `Encrypted on this computer and never shown again. Shared by ${models.length === 1 ? "the model" : `all ${models.length} models`} on this connection.`}
            {...(auth.type !== "none" ? { tag: "keychain" } : {})}>
            <CredentialCheck connection={connection} secret={secret} discovery={current} onCheck={runDiscover} />
          </Row>
        )}
      </Card>

      <Card eyebrow="MODELS" title={`${plural(models.length, "model")} in pickers`}
        headerAction={
          <>
            {isOpen("models") ? <ListAgainButton discovery={current} onDiscover={runDiscover} /> : null}
            {credentialReady ? toggle("models", "Edit") : null}
          </>
        }>
        <div className="pss__dapi-edit">
          {!credentialReady ? (
            <p className="pss__dapi-hint">Models are listed from the endpoint once {auth.type === "oauth" ? "you sign in" : "the key is saved"}.</p>
          ) : isOpen("models") ? (
            <ModelsStep
              connection={connection}
              models={models}
              discovery={current}
              onDiscover={runDiscover}
              onSaved={() => setSection("models", false)}
            />
          ) : settings !== null ? (
            <SavedModels models={models} settings={settings} />
          ) : null}
        </div>
      </Card>

      <div className="pss__dapi-actions">
        <RemoveConnection connection={connection} models={models} label="Remove connection" />
      </div>
    </>
  );
}

function CredentialCheck({ connection, secret, discovery, onCheck }: {
  connection: CustomConnection;
  secret: SecretStatus | null;
  discovery: Discovery | null;
  onCheck: () => Promise<Discovery | null>;
}): ReactElement {
  const { auth } = connection;
  const cmd = auth.type === "none" ? (isLoopbackApiUrl(connection.baseUrl) ? "Not needed on this computer" : "No authentication")
    : auth.type === "api-key" ? `•••• saved ${formatLastSetAt(secret?.lastSetAt ?? null)}`
    : `Signed in ${formatLastSetAt(secret?.lastSetAt ?? null)}`;
  const result = discovery === null ? { text: "Test asks the endpoint for its model list. No model runs, so it costs nothing.", tone: "" }
    : discovery.kind === "loading" ? { text: "Asking the endpoint for its model list…", tone: "" }
    : discovery.kind === "done" ? { text: `Reached it · listed ${plural(discovery.result.models.length, "model")}`, tone: " is-ok" }
    : { text: discovery.message, tone: " is-bad" };
  return (
    <div className="pss__test">
      <span className="pss__test-icon" aria-hidden="true">{auth.type === "none" ? "—" : auth.type === "api-key" ? "••" : "↗"}</span>
      <div className="pss__test-l">
        <span className="pss__test-cmd">{cmd}</span>
        <span className={"pss__test-sub pss__dapi-check" + result.tone} role="status" title={result.text}>{result.text}</span>
      </div>
      <div className="pss__test-r">
        <button className="pss__test-btn" type="button" disabled={discovery?.kind === "loading"} onClick={() => { void onCheck(); }}>
          {discovery?.kind === "loading" ? "Testing…" : "Test"}
        </button>
      </div>
    </div>
  );
}

export function SavedModels({ models, settings }: { models: readonly CustomModel[]; settings: Settings }): ReactElement {
  const [tests, setTests] = useState<Readonly<Record<string, { ok: boolean | null; text: string }>>>({});
  const test = async (m: CustomModel): Promise<void> => {
    setTests((prev) => ({ ...prev, [m.id]: { ok: null, text: "Asking it to reply…" } }));
    const r = await dispatch("customModels:test", { id: m.id });
    setTests((prev) => ({ ...prev, [m.id]: r.ok ? { ok: true, text: `Replied · ${r.value.ms} ms` } : { ok: false, text: messageOf(r) } }));
  };
  return (
    <div className="pss__dapi-models" role="table" aria-label="Models">
      <div className="pss__dapi-mrow is-view is-head" role="row">
        <span>Model</span><span>Image input</span><span>Default for</span><span />
      </div>
      {models.map((m) => {
        const used = JOB_ORDER.filter((s) => settings.ai.defaults[s].provider === customProviderId(m.id));
        const result = tests[m.id];
        return (
          <div key={m.id} className="pss__dapi-mrow is-view" role="row">
            <span className="pss__dapi-mname">
              <span>{m.displayName}</span>
              <span className="pss__dapi-mid" title={m.modelId}>{m.modelId}</span>
            </span>
            <span className="pss__dapi-caps">
              <span className={"pss__dapi-cap" + (m.capabilities.vision === true ? " is-yes" : "")}>
                {m.capabilities.vision === null ? "UNKNOWN" : m.capabilities.vision ? "YES" : "NO"}
              </span>
              {!m.capabilities.streaming ? <span className="pss__dapi-cap">NO STREAM</span> : null}
              {m.enrichmentReasoning ? <span className="pss__dapi-cap">ENRICHMENT {m.enrichmentReasoning.toUpperCase()}</span> : null}
            </span>
            <span className={"pss__dapi-used" + (used.length === 0 ? " is-none" : "")}>
              {used.length > 0 ? used.map((s) => AI_SURFACE_LABELS[s]).join(", ") : "Not used"}
            </span>
            <button className="pss__dapi-test" type="button" disabled={result?.ok === null}
              title="Asks the model to reply — a few tokens on your provider's bill" onClick={() => { void test(m); }}>
              Test
            </button>
            {result !== undefined ? (
              <span className={"pss__dapi-result" + (result.ok === true ? " is-ok" : result.ok === false ? " is-bad" : "")} role="status">
                {result.text}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function RemoveConnection({ connection, models, label }: {
  connection: CustomConnection;
  models: readonly CustomModel[];
  label: string;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (): Promise<void> => {
    const r = await dispatch("customModels:removeConnection", { connectionId: connection.id });
    if (!r.ok) { setError(messageOf(r)); return; }
    setActivePage("ai");
  };
  const what = `${plural(models.length, "model")}${connection.auth.type === "none" ? "" : " and its credential"}`;
  return (
    <>
      {confirming ? (
        <>
          <span className="pss__dapi-hint">
            Remove {connection.name}, its {what}? Jobs set to these models stop until you pick another.
          </span>
          <button className="pss__key-btn is-danger" type="button" onClick={() => { void remove(); }}>Remove</button>
          <button className="pss__key-btn" type="button" onClick={() => setConfirming(false)}>Keep</button>
        </>
      ) : (
        <button className="pss__key-btn is-danger" type="button" onClick={() => setConfirming(true)}>{label}</button>
      )}
      {error !== null ? <p className="pss__dapi-hint pss__opt-sub--error" role="alert">{error}</p> : null}
    </>
  );
}

// ---- Chrome -----------------------------------------------------------------

export function PageHeader({ title, sub, right }: { title: string; sub: string; right?: ReactNode }): ReactElement {
  return (
    <div className="pss__main-hdr">
      <div className="pss__main-hdr-l">
        <div className="pss__main-eyebrow">AI Providers · Direct API</div>
        <h1 className="pss__main-title">{title}</h1>
        <p className="pss__main-sub">{sub}</p>
      </div>
      {right}
    </div>
  );
}

type StepState = "done" | "current" | "locked" | "idle";

function Step({ n, title, state, summary, summaryOk, right, children }: {
  n: number;
  title: string;
  state: StepState;
  summary: string;
  summaryOk?: boolean;
  right?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className={`pss__dapi-step is-${state}`} aria-label={`Step ${n}: ${title}`}>
      <div className="pss__dapi-step-h">
        <span className="pss__dapi-step-n" aria-hidden="true">{state === "done" ? "✓" : n}</span>
        <span className="pss__dapi-step-t">{title}</span>
        <span className={"pss__dapi-step-s" + (summaryOk === true ? " is-ok" : "")}>{summary}</span>
        {right !== undefined && right !== null ? <span className="pss__dapi-step-r">{right}</span> : null}
      </div>
      {children !== null && children !== false ? <div className="pss__dapi-step-b">{children}</div> : null}
    </section>
  );
}

export function ToggleButton({ open, label, onToggle }: { open: boolean; label: string; onToggle: (open: boolean) => void }): ReactElement {
  return (
    <button className="pss__top-btn" type="button" aria-expanded={open} onClick={() => onToggle(!open)}>
      {open ? "Close" : label}
    </button>
  );
}

export function ListAgainButton({ discovery, onDiscover }: { discovery: Discovery | null; onDiscover: () => Promise<Discovery | null> }): ReactElement {
  return (
    <button className="pss__top-btn" type="button" disabled={discovery?.kind === "loading"} onClick={() => { void onDiscover(); }}>
      {discovery?.kind === "loading" ? "Listing…" : "List again"}
    </button>
  );
}

function RequestPreview({ baseUrl, protocol }: { baseUrl: string; protocol: CustomProtocol }): ReactElement {
  const preview = requestUrl(baseUrl, protocol);
  return (
    <div className="pss__dapi-req">
      <span className="pss__dapi-m">POST</span>
      <span className="pss__dapi-u">{preview.base}<b>{preview.path}</b></span>
      <span className="pss__dapi-l">what PwrSnap will call</span>
    </div>
  );
}

function NoteView({ note }: { note: Note | null }): ReactElement | null {
  if (note === null) return null;
  const glyph = note.tone === "ok" ? "✓" : note.tone === "warn" ? "!" : "×";
  return (
    <div className={`pss__dapi-note is-${note.tone}`} role={note.tone === "bad" ? "alert" : "status"}>
      <span className="pss__dapi-g" aria-hidden="true">{glyph}</span>
      <div>{note.text}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="pss__dapi-field">
      <span className="pss__dapi-k">{label}</span>
      {children}
    </label>
  );
}

// ---- 1 · Where --------------------------------------------------------------

function WhereStep({ connection, credentialConfigured, template, onTemplate, onSaved, onCancel }: {
  connection: CustomConnection | null;
  credentialConfigured: boolean;
  template: ConnectionTemplate | null;
  onTemplate: (template: ConnectionTemplate) => void;
  onSaved: (connection: CustomConnection) => void;
  onCancel: (() => void) | null;
}): ReactElement {
  const [name, setName] = useState(connection?.name ?? "");
  const [protocol, setProtocol] = useState<CustomProtocol>(connection?.protocol ?? "openai-chat");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "https://");
  const [concurrency, setConcurrency] = useState<string>(connection?.enrichmentConcurrency?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const url = baseUrl.trim();
  const urlOk = apiUrlSchema.safeParse(url).success;
  const urlTouched = url !== "" && url !== "https://" && url !== "http://";
  const local = isLoopbackApiUrl(url);
  const concurrencyValue = concurrency === "" ? undefined : Number(concurrency);
  const concurrencyOk = concurrencyValue === undefined || (Number.isInteger(concurrencyValue) && concurrencyValue >= 1 && concurrencyValue <= 16);
  const changed = connection === null || name.trim() !== connection.name || protocol !== connection.protocol || url !== connection.baseUrl
    || concurrencyValue !== connection.enrichmentConcurrency;
  const repoints = connection !== null && connection.auth.type !== "none" && credentialConfigured && trimSlash(url) !== trimSlash(connection.baseUrl);

  const pick = (t: ConnectionTemplate): void => {
    if (name.trim() === "" || CONNECTION_TEMPLATES.some((x) => x.name === name.trim())) setName(t.name);
    setProtocol(t.protocol);
    setBaseUrl(t.baseUrl);
    onTemplate(t);
  };
  const setPort = (port: number): void => {
    setBaseUrl((current) => current.replace(/^(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]))(?::[0-9]+)?/i, `$1:${port}`));
  };
  const save = async (): Promise<void> => {
    setBusy(true); setNote(null);
    // A new connection starts with the sign-in type its starting point
    // suggests; step 2 is where it is chosen for real. OAuth needs its
    // endpoints before it can be saved, so it starts as a key.
    const auth: CustomAuth = connection?.auth
      ?? (template?.auth === "none" || (template === null && local) ? { type: "none" } : { type: "api-key" });
    const input: CustomConnectionInput = {
      ...(connection !== null ? { id: connection.id } : {}),
      name: name.trim(), baseUrl: url, protocol, auth,
      ...(concurrencyValue !== undefined ? { enrichmentConcurrency: concurrencyValue } : {})
    };
    const r = await dispatch("customModels:saveConnection", { connection: input });
    setBusy(false);
    if (!r.ok) { setNote({ tone: "bad", text: messageOf(r) }); return; }
    onSaved(r.value);
  };

  return (
    <>
      {connection === null ? (
        <div className="pss__dapi-quick" role="group" aria-label="Start from">
          <span className="pss__dapi-k">Start from</span>
          {CONNECTION_TEMPLATES.map((t) => (
            <button key={t.id} type="button" className={template?.id === t.id ? "is-active" : ""} aria-pressed={template?.id === t.id} onClick={() => pick(t)}>
              {t.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="pss__dapi-grid2">
        <Field label="Name">
          <input className="pss__input is-text" value={name} maxLength={120} placeholder="What PwrSnap calls it" spellCheck={false}
            onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="pss__dapi-field">
          <span className="pss__dapi-k">Protocol</span>
          <SegmentedControl options={PROTOCOL_OPTIONS} value={protocol} onChange={setProtocol} />
        </div>
      </div>
      <Field label="Base URL">
        <input className="pss__input" value={baseUrl} spellCheck={false} autoComplete="off" aria-invalid={urlTouched && !urlOk}
          onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label="Parallel enrichments">
        <input className="pss__input" type="number" min={1} max={16} step={1}
          value={concurrency} placeholder={`Default: ${customEnrichmentConcurrency({ baseUrl: url })}`}
          aria-invalid={!concurrencyOk} onChange={(e) => setConcurrency(e.target.value)} />
      </Field>
      <p className="pss__dapi-hint">
        Shared by all models on this connection. Default: 1 on this computer, 2 elsewhere.
        Changes apply after its current queue drains. Waiting items expire after 15 minutes when their turn arrives.
      </p>
      {urlTouched && !urlOk ? (
        <p className="pss__dapi-hint pss__opt-sub--error">
          Use HTTPS — or plain HTTP only on this computer (127.0.0.1 or localhost) — with no user name, query string or fragment.
        </p>
      ) : null}
      {local ? (
        <div className="pss__dapi-quick" role="group" aria-label="Common ports">
          <span className="pss__dapi-k">Common ports</span>
          {LOCAL_SERVER_PORTS.map((p) => (
            <button key={p.port} type="button" onClick={() => setPort(p.port)}>{p.label} :{p.port}</button>
          ))}
        </div>
      ) : null}
      <RequestPreview baseUrl={urlOk ? url : "https://…"} protocol={protocol} />
      {repoints ? (
        <NoteView note={{ tone: "warn", text: <>Changing the address deletes the saved key — it only ever goes to the address it was saved for. You'll enter it again in the next step.</> }} />
      ) : null}
      <NoteView note={note} />
      <div className="pss__dapi-actions">
        <button className="pss__key-btn is-primary" type="button" disabled={busy || !changed || !urlOk || !concurrencyOk || name.trim() === ""}
          onClick={() => { void save(); }}>
          {busy ? "Saving…" : connection === null ? "Continue" : "Save"}
        </button>
        {onCancel !== null ? <button className="pss__key-btn" type="button" onClick={onCancel}>Cancel</button> : null}
      </div>
    </>
  );
}

// ---- 2 · Sign in ------------------------------------------------------------

type OAuthDraft = Record<"authorizationUrl" | "tokenUrl" | "revocationUrl" | "clientId" | "scopes" | "resource" | "callbackPort", string>;

function oauthDraft(oauth: CustomOAuth | null): OAuthDraft {
  return {
    authorizationUrl: oauth?.authorizationUrl ?? "",
    tokenUrl: oauth?.tokenUrl ?? "",
    revocationUrl: oauth?.revocationUrl ?? "",
    clientId: oauth?.clientId ?? "",
    scopes: oauth?.scopes ?? "",
    resource: oauth?.resource ?? "",
    callbackPort: String(oauth?.callbackPort ?? 0)
  };
}
function oauthFromDraft(d: OAuthDraft): CustomOAuth | null {
  const parsed = customOAuthSchema.safeParse({
    authorizationUrl: d.authorizationUrl.trim(),
    tokenUrl: d.tokenUrl.trim(),
    clientId: d.clientId.trim(),
    scopes: d.scopes.trim(),
    callbackPort: Number(d.callbackPort.trim() || "0"),
    ...(d.revocationUrl.trim() !== "" ? { revocationUrl: d.revocationUrl.trim() } : {}),
    ...(d.resource.trim() !== "" ? { resource: d.resource.trim() } : {})
  });
  return parsed.success ? parsed.data : null;
}

function AuthStep({ connection, secret, initialKind, rejected, onCheck, onDone }: {
  connection: CustomConnection;
  secret: SecretStatus | null;
  initialKind: CustomAuth["type"];
  /** Why the endpoint turned the stored credential down, if it did. */
  rejected: string | null;
  onCheck: () => Promise<Discovery | null>;
  onDone: () => void;
}): ReactElement {
  const saved = connection.auth;
  const configured = saved.type !== "none" && secret?.configured === true;
  const [kind, setKind] = useState<CustomAuth["type"]>(initialKind);
  const [draft, setDraft] = useState<OAuthDraft>(oauthDraft(saved.type === "oauth" ? saved.oauth : null));
  const [replacing, setReplacing] = useState(rejected !== null);
  const [busy, setBusy] = useState<null | "save" | "login" | "check">(null);
  const [note, setNote] = useState<Note | null>(rejected === null ? null : {
    tone: "bad",
    text: <><b>{saved.type === "oauth" ? "The endpoint turned the sign-in down." : "The endpoint turned this key down."}</b> {rejected}</>
  });
  const keyRef = useRef<HTMLInputElement | null>(null);
  const local = isLoopbackApiUrl(connection.baseUrl);

  const saveAuth = async (auth: CustomAuth): Promise<boolean> => {
    const r = await dispatch("customModels:saveConnection", { connection: { ...connection, auth } });
    if (!r.ok) setNote({ tone: "bad", text: messageOf(r) });
    return r.ok;
  };
  const checked = (d: Discovery | null, prefix: string): void => {
    if (d?.kind === "error" && d.rejected) {
      setNote({ tone: "bad", text: <><b>The endpoint turned it down.</b> {d.message}</> });
    } else if (d?.kind === "done") {
      setNote({ tone: "ok", text: <><b>{prefix}</b> The endpoint listed {plural(d.result.models.length, "model")}.</> });
    } else if (d?.kind === "error") {
      setNote({ tone: "warn", text: <><b>{prefix}</b> Listing its models failed: {d.message} Some endpoints don't list models — you can add them by id in the next step.</> });
    }
  };

  const saveKey = async (): Promise<void> => {
    const value = keyRef.current?.value.trim() ?? "";
    if (value === "") { setNote({ tone: "bad", text: "Paste the key first." }); return; }
    if (keyRef.current !== null) keyRef.current.value = "";
    setBusy("save"); setNote(null);
    try {
      if (saved.type !== "api-key" && !(await saveAuth({ type: "api-key" }))) return;
      const r = await dispatch("customModels:setKey", { connectionId: connection.id, value });
      if (!r.ok) { setNote({ tone: "bad", text: messageOf(r) }); return; }
      setReplacing(false);
      const d = await onCheck();
      checked(d, "Key saved.");
      if (d?.kind === "error" && d.rejected) { setReplacing(true); return; }
      onDone();
    } finally { setBusy(null); }
  };
  const signIn = async (): Promise<void> => {
    const oauth = oauthFromDraft(draft);
    if (oauth === null) {
      setNote({ tone: "bad", text: "Check the OAuth fields: the authorization and token URLs must be HTTPS (or HTTP on this computer), a client ID is required, and the port is 0–65535." });
      return;
    }
    setBusy("login");
    setNote({ tone: "warn", text: "Finish signing in in your browser. PwrSnap waits up to 3 minutes." });
    try {
      if ((saved.type !== "oauth" || JSON.stringify(saved.oauth) !== JSON.stringify(oauth)) && !(await saveAuth({ type: "oauth", oauth }))) return;
      const r = await dispatch("customModels:login", { connectionId: connection.id });
      if (!r.ok) { setNote({ tone: "bad", text: messageOf(r) }); return; }
      const d = await onCheck();
      checked(d, "Signed in.");
      if (!(d?.kind === "error" && d.rejected)) onDone();
    } finally { setBusy(null); }
  };
  const useNoAuth = async (): Promise<void> => {
    setBusy("save"); setNote(null);
    try {
      if (!(await saveAuth({ type: "none" }))) return;
      checked(await onCheck(), "Saved.");
      onDone();
    } finally { setBusy(null); }
  };
  const check = async (): Promise<void> => {
    setBusy("check"); setNote(null);
    try { checked(await onCheck(), "Reached it."); } finally { setBusy(null); }
  };
  const forget = async (): Promise<void> => {
    const r = await dispatch("customModels:logout", { connectionId: connection.id });
    setNote(r.ok
      ? { tone: "ok", text: saved.type === "oauth" ? "Signed out on this computer. PwrSnap asked the provider to revoke the tokens where it can; revoke access there too if you need to be sure." : "Key deleted." }
      : { tone: "bad", text: messageOf(r) });
  };
  const oauthField = (k: keyof OAuthDraft, label: string, placeholder = ""): ReactElement => (
    <Field label={label}>
      <input className="pss__input" value={draft[k]} placeholder={placeholder} spellCheck={false} autoComplete="off"
        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
    </Field>
  );

  return (
    <>
      <SegmentedControl options={AUTH_OPTIONS} value={kind} onChange={(k) => { setKind(k); setNote(null); }} />

      {kind === "api-key" ? (
        saved.type === "api-key" && configured && !replacing ? (
          <div className="pss__dapi-actions">
            <span className="pss__dapi-hint">Key saved {formatLastSetAt(secret?.lastSetAt ?? null)}. It is never shown again.</span>
            <span className="pss__dapi-spacer" />
            <button className="pss__key-btn" type="button" onClick={() => setReplacing(true)}>Replace</button>
            <button className="pss__key-btn" type="button" disabled={busy !== null} onClick={() => { void check(); }}>
              {busy === "check" ? "Testing…" : "Test"}
            </button>
            <button className="pss__key-btn is-danger" type="button" onClick={() => { void forget(); }}>Delete key</button>
          </div>
        ) : (
          <>
            <div className="pss__keyrow">
              <input ref={keyRef} className="pss__input" type="password" autoComplete="new-password" spellCheck={false}
                aria-label="API key" placeholder={configured ? "Paste the new key" : "Paste the key"}
                onKeyDown={(e) => { if (e.key === "Enter") void saveKey(); }} />
              <button className="pss__key-btn is-primary" type="button" disabled={busy !== null} onClick={() => { void saveKey(); }}>
                {busy === "save" ? "Saving…" : "Save & test"}
              </button>
              {replacing ? <button className="pss__key-btn" type="button" onClick={() => setReplacing(false)}>Cancel</button> : null}
            </div>
            <p className="pss__dapi-hint">
              Stored encrypted on this computer and never shown again. The test asks the endpoint for its model list — no model runs, so it costs nothing.
              {saved.type !== "api-key" && configured ? " Switching to a key signs this connection out." : ""}
            </p>
          </>
        )
      ) : null}

      {kind === "oauth" ? (
        <>
          <div className="pss__dapi-oauth">
            {oauthField("authorizationUrl", "Authorization URL", "https://…/authorize")}
            {oauthField("tokenUrl", "Token URL", "https://…/token")}
            {oauthField("clientId", "Client ID")}
            {oauthField("scopes", "Scopes", "space separated")}
            {oauthField("revocationUrl", "Revocation URL (optional)")}
            {oauthField("resource", "Resource (optional)")}
            {oauthField("callbackPort", "Callback port")}
          </div>
          <p className="pss__dapi-hint">
            Register a public client (no secret) with redirect <code>http://127.0.0.1:{draft.callbackPort.trim() === "" || draft.callbackPort.trim() === "0" ? "PORT" : draft.callbackPort.trim()}/oauth/callback</code>. Port 0 picks a free port each time, which only works if your provider allows any loopback port. PwrSnap signs in with PKCE in your browser.
          </p>
          <div className="pss__dapi-actions">
            <button className="pss__key-btn is-primary" type="button" disabled={busy !== null} onClick={() => { void signIn(); }}>
              {busy === "login" ? "Waiting for the browser…" : configured && saved.type === "oauth" ? "Sign in again" : "Save & sign in"}
            </button>
            {busy === "login" ? (
              <button className="pss__key-btn" type="button" onClick={() => { void forget(); }}>Cancel sign-in</button>
            ) : configured && saved.type === "oauth" ? (
              <button className="pss__key-btn is-danger" type="button" onClick={() => { void forget(); }}>Sign out</button>
            ) : null}
          </div>
        </>
      ) : null}

      {kind === "none" ? (
        <>
          <p className="pss__dapi-hint">
            {local
              ? "Requests stay on this computer. Nothing is sent but the request itself."
              : "Only for an endpoint that needs no sign-in: nothing is sent but the request itself."}
            {saved.type !== "none" && configured ? " Switching deletes the saved credential." : ""}
          </p>
          <div className="pss__dapi-actions">
            {saved.type !== "none" ? (
              <button className="pss__key-btn is-primary" type="button" disabled={busy !== null} onClick={() => { void useNoAuth(); }}>
                {busy === "save" ? "Saving…" : "Use no auth"}
              </button>
            ) : (
              <button className="pss__key-btn" type="button" disabled={busy !== null} onClick={() => { void check(); }}>
                {busy === "check" ? "Checking…" : "Check connection"}
              </button>
            )}
          </div>
        </>
      ) : null}

      <NoteView note={note} />
    </>
  );
}

// ---- 3 · Models -------------------------------------------------------------

type Row = {
  modelId: string;
  /** Set for a saved model: keeping it keeps every job routed to it. */
  id?: string;
  checked: boolean;
  displayName: string;
  vision: boolean | null;
  /** Where the image-input answer came from. */
  source: string;
  reasoningSupport: { disableThinking: boolean; effort: boolean } | null;
  enrichmentReasoning: CustomEnrichmentReasoning | null;
};
type RowEdit = Partial<Pick<Row, "checked" | "displayName" | "vision" | "enrichmentReasoning">>;

export function ModelsStep({ connection, models, discovery, onDiscover, onSaved }: {
  connection: CustomConnection;
  models: readonly CustomModel[];
  discovery: Discovery | null;
  onDiscover: () => Promise<Discovery | null>;
  onSaved: () => void;
}): ReactElement {
  const [edits, setEdits] = useState<Readonly<Record<string, RowEdit>>>({});
  const [manual, setManual] = useState<readonly string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [tests, setTests] = useState<Readonly<Record<string, { ok: boolean | null; text: string }>>>({});
  const first = models[0];
  const [maxTokens, setMaxTokens] = useState(String(first?.maxOutputTokens ?? DEFAULT_CUSTOM_MAX_OUTPUT_TOKENS));
  const [streaming, setStreaming] = useState(first?.capabilities.streaming ?? true);

  // List once on arrival; "List again" is the explicit refresh.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || discovery !== null) return;
    asked.current = true;
    void onDiscover();
  }, [discovery, onDiscover]);

  const listed = discovery?.kind === "done" ? discovery.result.models : [];
  const savedIds = new Set(models.map((m) => m.modelId));
  const base: Row[] = [
    ...models.map((m) => ({ modelId: m.modelId, id: m.id, checked: true, displayName: m.displayName, vision: m.capabilities.vision, source: "",
      reasoningSupport: listed.find((l) => l.id === m.modelId)?.reasoning ?? null, enrichmentReasoning: m.enrichmentReasoning ?? null })),
    ...manual.filter((m) => !savedIds.has(m)).map((m) => ({ modelId: m, checked: true, displayName: suggestModelName(connection.baseUrl, m), vision: null, source: "",
      reasoningSupport: null, enrichmentReasoning: null })),
    ...listed.filter((l) => !savedIds.has(l.id) && !manual.includes(l.id)).map((l) => ({
      modelId: l.id, checked: false, displayName: suggestModelName(connection.baseUrl, l.id, l.displayName), vision: l.vision,
      source: l.vision === null ? "not advertised" : "listed by endpoint",
      reasoningSupport: l.reasoning ?? null, enrichmentReasoning: null
    }))
  ];
  const rows = base.map((r) => {
    const e = edits[r.modelId];
    return e === undefined ? r : { ...r, ...e, source: e.vision !== undefined ? "set by you" : r.source };
  });
  const namesOk = rows.every((r) => !r.checked || r.displayName.trim().length > 0);
  const tokens = Number(maxTokens);
  const tokensOk = Number.isInteger(tokens) && tokens >= 1 && tokens <= 131072;
  const settingsChanged = first !== undefined && (tokens !== first.maxOutputTokens || streaming !== first.capabilities.streaming);
  const dirty = rows.some((r) => {
    const saved = models.find((m) => m.modelId === r.modelId);
    return saved === undefined ? r.checked
      : !r.checked || r.displayName.trim() !== saved.displayName || r.vision !== saved.capabilities.vision ||
        r.enrichmentReasoning !== (saved.enrichmentReasoning ?? null);
  }) || settingsChanged;
  const q = filter.trim().toLowerCase();
  const shown = q === "" ? rows : rows.filter((r) => r.checked || r.modelId.toLowerCase().includes(q) || r.displayName.toLowerCase().includes(q));
  const unknownOnly = listed.length > 0 && listed.every((l) => l.vision === null);

  const edit = (modelId: string, e: RowEdit): void => setEdits((prev) => ({ ...prev, [modelId]: { ...prev[modelId], ...e } }));
  const save = async (): Promise<void> => {
    if (!namesOk) return;
    setBusy(true); setNote(null);
    const inputs: CustomModelInput[] = rows.filter((r) => r.checked).map((r) => ({
      ...(r.id !== undefined ? { id: r.id } : {}),
      modelId: r.modelId,
      displayName: r.displayName.trim(),
      capabilities: { vision: r.vision, streaming },
      maxOutputTokens: tokens,
      ...(r.enrichmentReasoning ? { enrichmentReasoning: r.enrichmentReasoning } : {})
    }));
    const r = await dispatch("customModels:setModels", { connectionId: connection.id, models: inputs });
    setBusy(false);
    if (!r.ok) { setNote({ tone: "bad", text: messageOf(r) }); return; }
    setEdits({}); setManual([]);
    onSaved();
  };
  const test = async (m: CustomModel): Promise<void> => {
    setTests((prev) => ({ ...prev, [m.id]: { ok: null, text: "Asking it to reply…" } }));
    const r = await dispatch("customModels:test", { id: m.id });
    setTests((prev) => ({ ...prev, [m.id]: r.ok ? { ok: true, text: `Replied · ${r.value.ms} ms` } : { ok: false, text: messageOf(r) } }));
  };
  const addManual = (): void => {
    const id = adding?.trim() ?? "";
    if (id === "" || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) return;
    if (rows.some((r) => r.modelId === id)) edit(id, { checked: true });
    else setManual((prev) => [...prev, id]);
    setAdding(null);
  };

  return (
    <>
      <p className="pss__dapi-hint">
        Tick the models you want in PwrSnap's pickers; they all share this connection's credential.
        {unknownOnly ? " This endpoint's model list doesn't say which models accept images, so those start as Unknown until you answer." : ""}
        {" "}Unknown is fine for chat, text only. Captions need Yes — PwrSnap will not guess from a model's name.
        {connection.protocol === "openai-chat" && isLoopbackApiUrl(connection.baseUrl)
          ? " Enrichment thinking choices appear when the local model reports support for them."
          : ""}
      </p>
      {discovery?.kind === "loading" ? <p className="pss__dapi-hint" role="status">Listing models…</p> : null}
      {discovery?.kind === "error" ? (
        <NoteView note={{ tone: "warn", text: <>Couldn't list this endpoint's models: {discovery.message} Add them by id below.</> }} />
      ) : null}
      {rows.length > 10 ? (
        <input className="pss__input" value={filter} placeholder={`Filter ${rows.length} models`} aria-label="Filter models"
          spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
      ) : null}
      {rows.length > 0 ? (
        <div className="pss__dapi-models" role="table" aria-label="Models">
          <div className="pss__dapi-mrow is-head" role="row">
            <span /><span>Model id</span><span>Image input</span><span>Name in pickers</span><span />
          </div>
          {shown.map((r) => {
            const savedModel = r.id !== undefined ? models.find((m) => m.id === r.id) : undefined;
            const result = savedModel !== undefined ? tests[savedModel.id] : undefined;
            return (
              <div key={r.modelId} className={"pss__dapi-mrow" + (r.checked ? "" : " is-off")} role="row">
                <input type="checkbox" checked={r.checked} aria-label={`Use ${r.modelId}`}
                  onChange={(e) => edit(r.modelId, { checked: e.target.checked })} />
                <span className="pss__dapi-mid" title={r.modelId}>{r.modelId}</span>
                <span className="pss__dapi-caps">
                  <VisionTri value={r.vision} label={r.modelId} onChange={(vision) => edit(r.modelId, { vision })} />
                  {r.source !== "" ? <span className="pss__dapi-src">{r.source}</span> : null}
                  {r.checked && connection.protocol === "openai-chat" && isLoopbackApiUrl(connection.baseUrl) &&
                    (r.reasoningSupport !== null || r.enrichmentReasoning !== null) ? (
                    <label className="pss__dapi-reasoning">
                      <span>Enrichment thinking</span>
                      <select className="pss__input" value={r.enrichmentReasoning ?? ""} onChange={(e) =>
                        edit(r.modelId, { enrichmentReasoning: e.target.value === "" ? null : e.target.value as CustomEnrichmentReasoning })}>
                        <option value="">Server default</option>
                        {r.reasoningSupport?.effort ? <option value="low">Low</option> : null}
                        {r.reasoningSupport?.effort ? <option value="medium">Medium</option> : null}
                        {r.reasoningSupport?.disableThinking ? <option value="off">Off</option> : null}
                        {r.enrichmentReasoning !== null &&
                          !(r.enrichmentReasoning === "off" ? r.reasoningSupport?.disableThinking : r.reasoningSupport?.effort) ? (
                          <option value={r.enrichmentReasoning}>{r.enrichmentReasoning} (support not verified)</option>
                        ) : null}
                      </select>
                    </label>
                  ) : null}
                </span>
                {r.checked ? (
                  <input className="pss__input" value={r.displayName} maxLength={120} placeholder="Enter a display name" aria-required="true" aria-invalid={r.displayName.trim() === ""} aria-label={`Name for ${r.modelId}`}
                    onChange={(e) => edit(r.modelId, { displayName: e.target.value })} />
                ) : <span className="pss__dapi-none">—</span>}
                {savedModel !== undefined ? (
                  <button className="pss__dapi-test" type="button" disabled={result?.ok === null}
                    title="Asks the model to reply — a few tokens on your provider's bill" onClick={() => { void test(savedModel); }}>
                    Test
                  </button>
                ) : <span />}
                {result !== undefined ? (
                  <span className={"pss__dapi-result" + (result.ok === true ? " is-ok" : result.ok === false ? " is-bad" : "")} role="status">
                    {result.text}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {adding === null ? (
        <div className="pss__dapi-actions">
          <button className="pss__key-btn" type="button" onClick={() => setAdding("")}>+ Add a model by id</button>
          <span className="pss__dapi-hint">For endpoints that list nothing, or models they don't list.</span>
        </div>
      ) : (
        <div className="pss__dapi-add">
          <input className="pss__input" autoFocus value={adding} placeholder="Exact model id, as the endpoint expects it" spellCheck={false}
            aria-label="Model id" onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addManual(); if (e.key === "Escape") setAdding(null); }} />
          <button className="pss__key-btn" type="button" disabled={adding.trim() === ""} onClick={addManual}>Add</button>
          <button className="pss__key-btn" type="button" onClick={() => setAdding(null)}>Cancel</button>
        </div>
      )}
      {/* Plan usage fixes both: it always streams and takes no output limit. */}
      {connection.auth.type === "chatgpt" ? null : <details className="pss__dapi-details">
        <summary>Output limit and streaming</summary>
        <div className="pss__dapi-grid3">
          <Field label="Max output tokens">
            <input className="pss__input" type="number" min={1} max={131072} value={maxTokens} aria-invalid={!tokensOk}
              onChange={(e) => setMaxTokens(e.target.value)} />
          </Field>
          <div className="pss__dapi-field">
            <span className="pss__dapi-k">Stream responses</span>
            <span className="pss__switch-row">
              <Switch on={streaming} onChange={setStreaming} label="Stream responses" />
            </span>
          </div>
        </div>
        <p className="pss__dapi-hint">Applies to every model saved here. Turn streaming off for a server that can't send server-sent events.</p>
      </details>}
      {!namesOk ? <p className="pss__dapi-hint">Enter a display name for each selected model. If the endpoint does not supply one, choose a name here.</p> : null}
      <NoteView note={note} />
      <div className="pss__dapi-actions">
        <button className="pss__key-btn is-primary" type="button" disabled={busy || !dirty || !tokensOk || !namesOk} onClick={() => { void save(); }}>
          {busy ? "Saving…" : `Save ${plural(rows.filter((r) => r.checked).length, "model")}`}
        </button>
        {dirty ? (
          <button className="pss__key-btn" type="button" onClick={() => {
            setEdits({}); setManual([]);
            setMaxTokens(String(first?.maxOutputTokens ?? DEFAULT_CUSTOM_MAX_OUTPUT_TOKENS));
            setStreaming(first?.capabilities.streaming ?? true);
          }}>Revert</button>
        ) : null}
      </div>
    </>
  );
}

function VisionTri({ value, label, onChange }: { value: boolean | null; label: string; onChange: (v: boolean | null) => void }): ReactElement {
  const option = (v: boolean | null, text: string): ReactElement => (
    <button type="button" className={(v === null ? "is-q" : "") + (value === v ? " is-on" : "")} aria-pressed={value === v}
      onClick={() => onChange(v)}>
      {text}
    </button>
  );
  return (
    <span className="pss__dapi-tri" role="group" aria-label={`Image input for ${label}`}>
      {option(true, "Yes")}
      {option(false, "No")}
      {option(null, "Unknown")}
    </span>
  );
}

// ---- 4 · Use it for ---------------------------------------------------------

function providerLabel(settings: Settings, provider: string | undefined): string {
  if (provider === undefined || provider === "" || provider === "codex") return "Codex";
  if (provider.startsWith("acp:")) return builtInAcpAgentDisplayName(provider.slice("acp:".length));
  if (provider.startsWith("custom:")) {
    const m = settings.ai.customModels?.find((x) => customProviderId(x.id) === provider);
    return m?.displayName ?? "a removed model";
  }
  return provider;
}

function JobsStep({ models, settings, patch }: {
  models: readonly CustomModel[];
  settings: Settings;
  patch: (p: SettingsPatch) => Promise<void>;
}): ReactElement {
  const assign = (surface: AiSurfaceId, model: CustomModel): void => {
    const defaults: NonNullable<NonNullable<SettingsPatch["ai"]>["defaults"]> = {};
    defaults[surface] = { provider: customProviderId(model.id), model: "", reasoning: "" };
    void patch({ ai: { defaults } });
  };
  return (
    <>
      <div className="pss__dapi-grid3">
        {JOB_ORDER.map((surface) => {
          const provider = settings.ai.defaults[surface].provider;
          const mine = models.find((m) => customProviderId(m.id) === provider);
          const options = surface === "enrichment" ? models.filter((m) => m.capabilities.vision === true) : models;
          return (
            <div key={surface} className="pss__dapi-field">
              <span className="pss__dapi-k">{AI_SURFACE_LABELS[surface]}</span>
              <select className="pss__select" value={mine?.id ?? ""} disabled={options.length === 0}
                aria-label={AI_SURFACE_LABELS[surface]}
                onChange={(e) => {
                  const m = options.find((x) => x.id === e.target.value);
                  if (m !== undefined) assign(surface, m);
                }}>
                {mine === undefined ? <option value="">{providerLabel(settings, provider)} (unchanged)</option> : null}
                {options.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
              {surface === "enrichment" && options.length === 0 ? (
                <span className="pss__dapi-hint">Captions need a model with Image input: Yes.</span>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="pss__dapi-hint">
        Optional. Direct API chat has no tools and no reasoning controls. Change any of these later in{" "}
        <button type="button" className="pss__text-link" onClick={() => setActivePage("ai-features", "default-agents")}>
          AI Features
        </button>
        .
      </p>
    </>
  );
}
