// AI Providers → ChatGPT: Sign in with ChatGPT, as a Direct API connection.
//
// PwrSnap calls api.openai.com/v1/responses itself with the plan's token;
// no agent is installed or started for it. The page is the saved-connection
// screen's skeleton (Default-for strip, then cards) with the Account card in
// place of Endpoint + Credential, because the address is fixed and the
// sign-in is OpenAI's.
//
// OpenAI's UI guidelines fix the wording used here: "Continue with ChatGPT",
// "Using ChatGPT plan", "Manage usage", "You're using your ChatGPT plan",
// "Got it", and the two disclosure lines. Claude Design: "PwrSnap Sign in
// with ChatGPT", boards 2a–2f.

import { useState, type ReactElement } from "react";
import {
  CHATGPT_PLAN_HELP_URL,
  CHATGPT_USAGE_URL,
  connectionSettingsSub,
  customProviderId,
  type ChatgptPlanSettings
} from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import { useModal } from "../../../lib/useModal";
import { statusBadgeClass } from "../ai-provider-status";
import { Card, ProviderDefaultsStrip, Row, Switch } from "../components";
import { plural, type ConnectionStatus } from "../direct-api-status";
import { useSettingsContext } from "../SettingsContext";
import { setActivePage } from "../useActivePage";
import {
  ListAgainButton,
  ModelsStep,
  PageHeader,
  RemoveConnection,
  SavedModels,
  ToggleButton,
  useDiscovery
} from "./ConnectionPage";

const NO_PLAN: ChatgptPlanSettings = { accountLabel: "", planGranted: false, backgroundConsent: false, welcomeSeen: false };

function openExternal(url: string): void {
  void dispatch("app:openExternal", { url });
}

/** Signs in, then lands on the ChatGPT connection page. */
async function continueWithChatgpt(): Promise<string | null> {
  const r = await dispatch("chatgptPlan:login", {});
  if (!r.ok) return r.error.message;
  if (r.value.connectionId !== null) setActivePage("ai", connectionSettingsSub(r.value.connectionId));
  return null;
}

/** OpenAI's sign-in button. Neutral, never the tangerine primary: it is a
 *  third party's sign-in, not a PwrSnap action. */
export function ContinueWithChatgptButton({ busy, onClick }: { busy: boolean; onClick: () => void }): ReactElement {
  return (
    <button type="button" className="pss__chatgpt-btn" disabled={busy} onClick={onClick}>
      {busy ? "Waiting for the browser…" : "Continue with ChatGPT"}
    </button>
  );
}

/** The two lines OpenAI requires wherever plan usage is offered. */
function Disclosure(): ReactElement {
  return (
    <p className="pss__chatgpt-disc">
      <span>Eligible usage in this app uses your ChatGPT plan.</span>
      <span>Manage usage in your ChatGPT settings.</span>
    </p>
  );
}

/** Offered on the hub's Connections card until a ChatGPT connection exists. */
export function ChatgptOffer(): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { setError(await continueWithChatgpt()); } finally { setBusy(false); }
  };
  return (
    <div className="pss__chatgpt-offer">
      <span className="pss__chatgpt-offer-text">
        <span className="pss__chatgpt-offer-title">Use your ChatGPT plan</span>
        <span className="pss__chatgpt-offer-sub">
          Plus and Pro plans can run PwrSnap's AI with no API key and nothing else to install. PwrSnap is free; no upgrade needed.
        </span>
        {error !== null ? <span className="pss__chatgpt-offer-sub pss__opt-sub--error" role="alert">{error}</span> : null}
      </span>
      <ContinueWithChatgptButton busy={busy} onClick={() => { void login(); }} />
    </div>
  );
}

function Welcome({ onClose }: { onClose: () => void }): ReactElement {
  const ref = useModal({ onClose });
  return (
    <div className="pss__modal-backdrop">
      <div ref={ref} className="pss__modal" role="dialog" aria-modal="true" aria-labelledby="pss-chatgpt-welcome-title">
        <div className="pss__modal-hdr">
          <h2 id="pss-chatgpt-welcome-title" className="pss__modal-title">You’re using your ChatGPT plan</h2>
        </div>
        <div className="pss__modal-body">
          <Disclosure />
          <p className="pss__chatgpt-disc">New captures aren’t sent until you allow automatic use on this page.</p>
        </div>
        {/* Got it comes first in the DOM so it takes the initial focus: Return
            dismisses rather than opening a browser. Row order is reversed in CSS. */}
        <div className="pss__modal-footer pss__chatgpt-welcome-footer">
          <button type="button" className="pss__key-btn is-primary" onClick={onClose}>Got it</button>
          <button type="button" className="pss__key-btn" onClick={() => openExternal(CHATGPT_USAGE_URL)}>Manage usage ↗</button>
        </div>
      </div>
    </div>
  );
}

export function ChatgptConnectionPage({ status }: { status: ConnectionStatus }): ReactElement {
  const { settings } = useSettingsContext();
  const { connection, models } = status;
  const plan = settings?.ai.chatgptPlan ?? NO_PLAN;
  const signedIn = plan.accountLabel !== "";
  const ready = signedIn && plan.planGranted;
  const [busy, setBusy] = useState<"login" | "logout" | null>(null);
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);
  const [editingModels, setEditingModels] = useState(false);
  const { current, runDiscover } = useDiscovery(connection);
  const modelsOpen = ready && (editingModels || models.length === 0);

  const routed = settings === null ? [] : (["enrichment", "libraryChat", "sizzleChat"] as const).filter((surface) =>
    models.some((m) => settings.ai.defaults[surface].provider === customProviderId(m.id)));
  const configure = async (patch: { backgroundConsent?: boolean; welcomeSeen?: boolean }): Promise<void> => {
    const r = await dispatch("chatgptPlan:configure", patch);
    if (!r.ok) setNote({ bad: true, text: r.error.message });
  };
  const login = async (): Promise<void> => {
    setBusy("login"); setNote(null);
    try {
      const error = await continueWithChatgpt();
      if (error !== null) setNote({ bad: true, text: error });
    } finally { setBusy(null); }
  };
  const logout = async (): Promise<void> => {
    setBusy("logout"); setNote(null);
    try {
      const r = await dispatch("chatgptPlan:logout", {});
      setNote(!r.ok ? { bad: true, text: r.error.message }
        : r.value.revocationConfirmed ? { bad: false, text: "Signed out." }
        : { bad: false, text: "Signed out on this computer. OpenAI didn't confirm the revocation; disconnect PwrSnap in your ChatGPT settings to be sure." });
    } finally { setBusy(null); }
  };

  return (
    <>
      <PageHeader
        title={connection.name}
        sub="PwrSnap sends each request to OpenAI itself, billed to your ChatGPT plan. Text and images only; chat through it has no editing tools."
        right={<span className={"pss__badge" + statusBadgeClass(status.tone)}>{status.badge}</span>}
      />
      <ProviderDefaultsStrip routed={routed} onEdit={() => setActivePage("ai-features", "default-agents")} />

      <Card eyebrow="ACCOUNT" title={!signedIn ? "Sign in" : plan.planGranted ? "Using ChatGPT plan" : "Plan usage not granted"}>
        {!signedIn ? (
          <Row label="Use your ChatGPT plan"
            sub="Eligible Plus and Pro plans. Business and Enterprise plans may not offer plan usage in other apps.">
            <ContinueWithChatgptButton busy={busy === "login"} onClick={() => { void login(); }} />
            <Disclosure />
            <button type="button" className="pss__text-link pss__chatgpt-link" onClick={() => openExternal(CHATGPT_PLAN_HELP_URL)}>
              Learn more ↗
            </button>
          </Row>
        ) : (
          <Row label="Signed in" tag="keychain" sub={plan.planGranted
            ? "Tokens stay encrypted on this computer. Signing out also asks OpenAI to revoke them."
            : "You signed in but didn’t allow PwrSnap to use your ChatGPT plan. Nothing runs on this connection until you do."}>
            <div className="pss__chatgpt-acct">
              <span className="pss__chatgpt-acct-text">
                <span className="pss__chatgpt-acct-name">{plan.accountLabel}</span>
                <span className="pss__chatgpt-acct-sub">{plan.planGranted ? "Plan usage granted" : "Plan usage not granted"}</span>
              </span>
              <button type="button" className="pss__key-btn" disabled={busy !== null} onClick={() => { void logout(); }}>
                {busy === "logout" ? "Signing out…" : "Sign out"}
              </button>
            </div>
            {plan.planGranted ? (
              <span className="pss__chatgpt-inline">
                <span className="pss__chatgpt-disc">Eligible usage in this app uses your ChatGPT plan.</span>
                <button type="button" className="pss__text-link pss__chatgpt-link" onClick={() => openExternal(CHATGPT_USAGE_URL)}>
                  Manage usage ↗
                </button>
              </span>
            ) : (
              <ContinueWithChatgptButton busy={busy === "login"} onClick={() => { void login(); }} />
            )}
          </Row>
        )}
        {ready ? (
          <Row label="Automatic use for new captures"
            sub="Captions run in the background on every new capture. They use your plan only after you allow it here. Actions you click always run.">
            <span className="pss__switch-row">
              <Switch on={plan.backgroundConsent} label="Allow automatic use for new captures"
                onChange={(backgroundConsent) => { void configure({ backgroundConsent }); }} />
            </span>
          </Row>
        ) : null}
        {note !== null ? (
          <p className={"pss__dapi-hint pss__chatgpt-note" + (note.bad ? " pss__opt-sub--error" : "")} role={note.bad ? "alert" : "status"}>{note.text}</p>
        ) : null}
      </Card>

      <Card eyebrow="MODELS" title={`${plural(models.length, "model")} in pickers`}
        headerAction={ready ? (
          <>
            {modelsOpen ? <ListAgainButton discovery={current} onDiscover={runDiscover} /> : null}
            {models.length > 0 ? <ToggleButton open={modelsOpen} label="Edit" onToggle={setEditingModels} /> : null}
          </>
        ) : null}>
        <div className="pss__dapi-edit">
          {!ready ? (
            <p className="pss__dapi-hint">Your account’s models are listed once plan usage is granted.</p>
          ) : modelsOpen ? (
            <ModelsStep connection={connection} models={models} discovery={current} onDiscover={runDiscover}
              onSaved={() => setEditingModels(false)} />
          ) : settings !== null ? (
            <SavedModels models={models} settings={settings} />
          ) : null}
        </div>
      </Card>

      <div className="pss__dapi-actions">
        <RemoveConnection connection={connection} models={models} label="Remove connection" />
      </div>
      {ready && !plan.welcomeSeen ? <Welcome onClose={() => { void configure({ welcomeSeen: true }); }} /> : null}
    </>
  );
}
