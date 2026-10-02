import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { ChatgptPlanStatus } from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import { useModal } from "../../../lib/useModal";
import { Card, Row, Switch } from "../components";
import { useSettingsContext } from "../SettingsContext";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const HELP_URL = "https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites";
function open(url: string): void { void dispatch("app:openExternal", { url }); }
function Welcome({ onClose }: { onClose: () => void }): ReactElement {
  const ref = useModal({ onClose });
  return <div className="pss__modal-backdrop"><div ref={ref} className="pss__modal" role="dialog" aria-modal="true" aria-label="You're using your ChatGPT plan" tabIndex={-1}>
    <div className="pss__modal-hdr"><h2 className="pss__modal-title">You’re using your ChatGPT plan</h2></div><div className="pss__modal-body">
    <p>PwrSnap’s Codex jobs now use your ChatGPT plan. Manage this app’s usage and access in ChatGPT settings. Automatic post-capture jobs require your separate consent.</p>
    </div><div className="pss__modal-footer"><button type="button" className="pss__key-btn" onClick={() => open(CHATGPT_USAGE_URL)}>Manage usage</button>
    <button type="button" className="pss__key-btn is-primary" onClick={onClose}>Got it</button></div>
  </div></div>;
}
export function ChatgptPlanCard(): ReactElement {
  const { settings } = useSettingsContext();
  const [status, setStatus] = useState<ChatgptPlanStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    const result = await dispatch("chatgptPlan:status", {});
    if (result.ok) setStatus(result.value);
  }, []);
  useEffect(() => { void refresh(); }, [refresh, settings?.codex]);
  async function configure(patch: { enabled?: boolean; backgroundConsent?: boolean; welcomeSeen?: boolean }): Promise<void> {
    const result = await dispatch("chatgptPlan:configure", patch);
    if (result.ok) setStatus(result.value); else setMessage(result.error.message);
  }
  async function login(): Promise<void> {
    setBusy(true); setMessage("");
    try { const result = await dispatch("chatgptPlan:login", {});
      if (result.ok) setStatus(result.value); else setMessage(result.error.message);
    } finally { setBusy(false); }
  }
  async function logout(): Promise<void> {
    setBusy(true);
    try { const result = await dispatch("chatgptPlan:logout", {});
      if (result.ok) { setMessage(result.value.revocationConfirmed ? "Signed out." : "Local tokens cleared. Remote revocation was not confirmed; disconnect PwrSnap in ChatGPT settings."); await refresh(); }
      else setMessage(result.error.message);
    } finally { setBusy(false); }
  }
  return <Card eyebrow="CHATGPT PLAN" title="Sign in with ChatGPT">
    <Row label="Use your ChatGPT plan" sub="PwrSnap is free. Eligible Plus and Pro users can use their ChatGPT plan for PwrSnap’s AI jobs through the locally installed Codex app-server. No paid PwrSnap upgrade is required.">
      <button type="button" className="pss__text-link" onClick={() => open(HELP_URL)}>Learn more</button>
      <button type="button" className="pss__key-btn is-primary" disabled={busy} onClick={() => { void login(); }}>{busy ? "Connecting…" : "Continue with ChatGPT"}</button>
    </Row>
    {status?.connected ? <Row label={status.label} sub={status.planGranted ? "ChatGPT plan permission granted" : "Signed in; ChatGPT plan permission was not granted. Continue with ChatGPT to grant it."}>
      <button type="button" className="pss__key-btn" disabled={busy} onClick={() => { void logout(); }}>Sign out</button>
    </Row> : null}
    <Row label={status?.enabled && status.planGranted ? "Using ChatGPT plan" : "Use ChatGPT plan for Codex jobs"} sub="Applies to annotation, descriptions, filenames, sensitive-data scan, Library chat and other existing Codex text/image jobs. ACP and custom API jobs keep their chosen connection.">
      <Switch label="Use ChatGPT plan" on={status?.enabled ?? false} disabled={!status?.planGranted || busy} onChange={enabled => { void configure({ enabled }); }} />
      {status?.enabled ? <button type="button" className="pss__key-btn is-primary" onClick={() => open(CHATGPT_USAGE_URL)}>Manage usage</button> : null}
    </Row>
    <Row label="Allow automatic post-capture use" sub="I authorize PwrSnap to use my connected ChatGPT plan in the background to annotate, describe, name and scan new captures. Off by default. Clicked AI actions do not require this consent.">
      <Switch label="Allow automatic post-capture use" on={status?.backgroundConsent ?? false} disabled={busy} onChange={backgroundConsent => { void configure({ backgroundConsent }); }} />
    </Row>
    {message ? <p role="status">{message}</p> : null}
    {status?.enabled && status.planGranted && !status.welcomeSeen ? <Welcome onClose={() => { void configure({ welcomeSeen: true }); }} /> : null}
  </Card>;
}
