import { useEffect, useRef, useState, type ReactElement } from "react";
import { customProviderId, type CustomModel, type CustomOAuth, type CustomModelStatus } from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import { useSettingsContext } from "../SettingsContext";
import { Card } from "../components";

function freshModel(): CustomModel {
  return { id: crypto.randomUUID(), displayName: "", modelId: "", baseUrl: "http://127.0.0.1:18080/v1",
    protocol: "openai-chat", auth: { type: "none" }, capabilities: { vision: false, streaming: true }, maxOutputTokens: 4096 };
}
const emptyOAuth: CustomOAuth = { authorizationUrl: "", tokenUrl: "", clientId: "", scopes: "", callbackPort: 0 };

/** Deliberately plain editor. Public schema and API adapters live outside the view. */
export function CustomModelsCard(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const [draft, setDraft] = useState<CustomModel | null>(null);
  const [status, setStatus] = useState<CustomModelStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const models = settings?.ai.customModels ?? [];
  const saved = models.find((m) => m.id === draft?.id);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const epoch = useRef(0);
  useEffect(() => { epoch.current += 1; setStatus(null); setMessage(""); }, [draft?.id]);
  useEffect(() => {
    if (!saved) return;
    let current = true;
    void dispatch("customModels:status", { id: saved.id }).then((r) => { if (current && r.ok) setStatus(r.value); });
    return () => { current = false; };
  }, [saved, busy]);
  const run = async (task: (report: (message: string) => void) => Promise<void>): Promise<void> => {
    const current = ++epoch.current; setBusy(true); setMessage("");
    try { await task((text) => { if (current === epoch.current) setMessage(text); }); } catch { if (current === epoch.current) setMessage("The operation could not be completed."); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const change = (next: Partial<CustomModel>): void => { if (draft) setDraft({ ...draft, ...next }); };
  const oauthChange = (next: Partial<CustomOAuth>): void => {
    if (draft?.auth.type === "oauth") change({ auth: { ...draft.auth, oauth: { ...draft.auth.oauth, ...next } } });
  };
  const field = (label: string, value: string, onChange: (v: string) => void): ReactElement => (
    <label className="pss__ai-surface-field"><span>{label}</span><input className="pss__input" value={value} disabled={busy}
      autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} /></label>
  );
  return <Card eyebrow="DIRECT API" title="Custom models">
    <p className="pss__opt-sub">Connect directly from PwrSnap. Chat supports conversation and attached images; editing tools are unavailable. Enrichment requires image support. API billing and access depend on your provider, independently of agent subscriptions.</p>
    <div className="pss__role-controls">
      {models.map((m) => <button key={m.id} className="pss__top-btn" disabled={busy} onClick={() => setDraft(m)}>{m.displayName}</button>)}
      <button className="pss__top-btn" disabled={busy} onClick={() => setDraft(freshModel())}>Add custom model</button>
    </div>
    {draft && <div className="pss__custom-model-editor" key={draft.id}>
      {field("Display name", draft.displayName, (displayName) => change({ displayName }))}
      {field("Exact model ID", draft.modelId, (modelId) => change({ modelId }))}
      {field("API base URL (include /v1 when required)", draft.baseUrl, (baseUrl) => change({ baseUrl }))}
      <label className="pss__ai-surface-field"><span>API protocol</span><select className="pss__select" disabled={busy} value={draft.protocol}
        onChange={(e) => change({ protocol: e.target.value as CustomModel["protocol"] })}>
        <option value="openai-chat">OpenAI-compatible Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option>
      </select></label>
      <p className="pss__opt-sub">Chat Completions uses /chat/completions. Legacy text-only /completions is not supported.</p>
      <label><input type="checkbox" disabled={busy} checked={draft.capabilities.vision} onChange={(e) => change({ capabilities: { ...draft.capabilities, vision: e.target.checked } })} /> Image input supported</label>
      <label><input type="checkbox" disabled={busy} checked={draft.capabilities.streaming} onChange={(e) => change({ capabilities: { ...draft.capabilities, streaming: e.target.checked } })} /> Stream responses</label>
      <label className="pss__ai-surface-field"><span>Maximum output tokens</span><input type="number" className="pss__input" min={1} max={131072} value={draft.maxOutputTokens} disabled={busy} onChange={(e) => change({ maxOutputTokens: Number(e.target.value) })} /></label>
      <label className="pss__ai-surface-field"><span>Authentication</span><select className="pss__select" disabled={busy} value={draft.auth.type} onChange={(e) => {
        const id = crypto.randomUUID();
        change({ auth: e.target.value === "none" ? { type: "none" } : e.target.value === "api-key" ? { type: "api-key", credentialId: id } : { type: "oauth", credentialId: id, oauth: { ...emptyOAuth } } });
      }}><option value="none">None (local endpoints)</option><option value="api-key">API key</option><option value="oauth">OAuth (registered native application)</option></select></label>
      {draft.auth.type !== "none" && <>
        <label className="pss__ai-surface-field"><span>Credential</span><select className="pss__select" value={draft.auth.credentialId} disabled={busy} onChange={(e) => {
          const owner = models.find((m) => m.auth.type !== "none" && m.auth.credentialId === e.target.value);
          if (owner && owner.auth.type !== "none") change({ auth: owner.auth });
        }}><option value={draft.auth.credentialId}>This credential</option>{models.filter((m) => m.id !== draft.id && m.auth.type === draft.auth.type && m.baseUrl === draft.baseUrl && m.auth.type !== "none" && m.auth.credentialId !== (draft.auth.type === "none" ? "" : draft.auth.credentialId)).map((m) => <option key={m.id} value={m.auth.type === "none" ? "" : m.auth.credentialId}>Share with {m.displayName}</option>)}</select></label>
        <button className="pss__top-btn" disabled={busy} onClick={() => { if (draft.auth.type !== "none") change({ auth: { ...draft.auth, credentialId: crypto.randomUUID() } }); }}>Use a new credential</button>
        <p className="pss__opt-sub">{status?.configured ? "Credential saved in secure storage." : "No credential configured."} {status && status.sharedBy > 1 ? `Shared by ${status.sharedBy} models; replacing or signing out affects all of them.` : ""} Changing the endpoint requires a new credential.</p>
      </>}
      {draft.auth.type === "oauth" && <>
        <p className="pss__opt-sub">Supply documented OAuth endpoints and a public native client ID registered with your provider. Callback: http://127.0.0.1:PORT/oauth/callback. Port 0 chooses a random port and requires the provider to allow loopback port variation. Client-secret authentication is not supported.</p>
        {field("Authorization URL", draft.auth.oauth.authorizationUrl, (authorizationUrl) => oauthChange({ authorizationUrl }))}
        {field("Token URL", draft.auth.oauth.tokenUrl, (tokenUrl) => oauthChange({ tokenUrl }))}
        {field("Client ID", draft.auth.oauth.clientId, (clientId) => oauthChange({ clientId }))}
        {field("Scopes (space separated)", draft.auth.oauth.scopes, (scopes) => oauthChange({ scopes }))}
        {field("Revocation URL (optional)", draft.auth.oauth.revocationUrl ?? "", (revocationUrl) => oauthChange({ revocationUrl: revocationUrl || undefined }))}
        {field("Resource URL (optional)", draft.auth.oauth.resource ?? "", (resource) => oauthChange({ resource: resource || undefined }))}
        <label className="pss__ai-surface-field"><span>Callback port</span><input className="pss__input" type="number" min={0} max={65535} value={draft.auth.oauth.callbackPort} disabled={busy} onChange={(e) => oauthChange({ callbackPort: Number(e.target.value) })} /></label>
      </>}
      <div className="pss__role-controls">
        <button className="pss__top-btn" disabled={busy || !dirty} onClick={() => { void run(async (report) => {
          const r = await dispatch("customModels:save", { model: draft }); report(r.ok ? "Model saved." : r.error.message); if (r.ok) setDraft(r.value);
        }); }}>Save model</button>
        <button className="pss__top-btn is-danger" disabled={busy || !saved} onClick={() => { void run(async (report) => {
          const r = await dispatch("customModels:remove", { id: draft.id }); if (r.ok) setDraft(null); else report(r.error.message);
        }); }}>Remove</button>
      </div>
      {draft.auth.type === "api-key" && <label className="pss__ai-surface-field"><span>API key (write only)</span>
        <input ref={keyInput} className="pss__input" type="password" autoComplete="new-password" disabled={busy || dirty} />
        <button className="pss__top-btn" disabled={busy || dirty} onClick={() => { void run(async (report) => {
          const value = keyInput.current?.value ?? ""; if (keyInput.current) keyInput.current.value = "";
          const r = await dispatch("customModels:setKey", { id: draft.id, value }); report(r.ok ? "Key saved securely." : r.error.message);
        }); }}>Save API key</button>
      </label>}
      <div className="pss__role-controls">
        {draft.auth.type === "oauth" && <button className="pss__top-btn" disabled={busy || dirty} onClick={() => { void run(async (report) => { const r = await dispatch("customModels:login", { id: draft.id }); report(r.ok ? "Signed in." : r.error.message); }); }}>Sign in with browser</button>}
        {draft.auth.type !== "none" && <button className="pss__top-btn" disabled={dirty} onClick={() => { void run(async (report) => { const r = await dispatch("customModels:logout", { id: draft.id }); report(r.ok ? "Credentials removed locally. Server revocation attempted when configured; revoke access at your provider if needed." : r.error.message); }); }}>Sign out / clear credential</button>}
        <button className="pss__top-btn" disabled={busy || dirty} onClick={() => { void run(async (report) => { const r = await dispatch("customModels:test", { id: draft.id }); report(r.ok ? r.value.message : r.error.message); }); }}>Test connection (text only)</button>
        <button className="pss__top-btn" disabled={busy || dirty} onClick={() => { void run(async (report) => {
          const r = await dispatch("customModels:discover", { id: draft.id });
          if (!r.ok) { report(r.error.message); return; }
          report(`Models: ${r.value.modelIds.join(", ") || "none advertised"}. Image support: ${r.value.vision === null ? "unknown; configure explicitly" : r.value.vision ? "yes" : "no"}. Save to keep discovered capabilities.`);
          if (r.value.vision !== null) change({ capabilities: { ...draft.capabilities, vision: r.value.vision } });
        }); }}>Discover models / capabilities</button>
      </div>
      <div className="pss__role-controls">{(["libraryChat", "sizzleChat", "enrichment"] as const).map((surface) => <button className="pss__top-btn" key={surface} disabled={busy || dirty || (surface === "enrichment" && !draft.capabilities.vision)} onClick={() => { void run(async (report) => {
        await patch({ ai: { defaults: { [surface]: { provider: customProviderId(draft.id), model: draft.modelId, reasoning: "" } } } }); report(`Selected for ${surface}.`);
      }); }}>{surface === "libraryChat" ? "Use for Library chat" : surface === "sizzleChat" ? "Use for Sizzle chat" : "Use for enrichment"}</button>)}</div>
      <p className="pss__opt-sub">Save model changes before testing, signing in, or selecting. No pricing, reasoning or Fast-mode support is assumed.</p>
    </div>}
    {message && <p className="pss__opt-sub" role="status">{message}</p>}
  </Card>;
}
