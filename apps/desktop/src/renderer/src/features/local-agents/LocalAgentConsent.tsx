import { useEffect, useState } from "react";
import type {
  LocalAgentCapability,
  LocalAgentConsentPrompt
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export function LocalAgentConsent(): React.JSX.Element {
  const [prompt, setPrompt] = useState<LocalAgentConsentPrompt | null>(null);
  const [selected, setSelected] = useState<Set<LocalAgentCapability>>(new Set());
  const [sessionName, setSessionName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void dispatch("localAgents:consentRead", {}).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setPrompt(result.value);
      setSessionName(result.value.suggestedSessionName);
      setSelected(new Set(
        result.value.permissions
          .filter((permission) => permission.requested)
          .map((permission) => permission.capability)
      ));
    });
    return () => {
      active = false;
    };
  }, []);

  const decide = async (decision: "allow" | "deny"): Promise<void> => {
    if (prompt === null || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await dispatch("localAgents:consentDecide", {
      requestId: prompt.requestId,
      decision,
      sessionName: decision === "allow" ? sessionName : "",
      capabilities: decision === "allow" ? [...selected] : []
    });
    if (!result.ok) {
      setError(result.error.message);
      setSubmitting(false);
    }
  };

  if (prompt === null) {
    return (
      <main className="local-agent-consent local-agent-consent--loading">
        <p>{error ?? "Loading authorization request..."}</p>
      </main>
    );
  }

  return (
    <main className="local-agent-consent">
      <header className="local-agent-consent__header">
        <div className="local-agent-consent__brand pwrsnap-wordmark">
          Pwr<span className="pwrsnap-wordmark__a">Snap</span>
        </div>
        <h1>A local MCP client wants to access PwrSnap</h1>
        <p>
          Your library can contain private screen content. Choose exactly what
          this local agent may search, read, create, or change.
        </p>
        <p className="local-agent-consent__client-label">
          Client-reported label: <strong>{prompt.clientName}</strong>
        </p>
      </header>

      <label className="local-agent-consent__session-name">
        <span>Session Name</span>
        <input
          type="text"
          maxLength={200}
          value={sessionName}
          disabled={submitting}
          onChange={(event) => setSessionName(event.target.value)}
        />
        <small>Use a unique name you will recognize later in Access Control.</small>
      </label>

      <fieldset className="local-agent-consent__fieldset" disabled={submitting}>
        <legend>Permissions</legend>
        <div className="local-agent-consent__permissions">
          {prompt.permissions.map((permission) => (
            <label className="local-agent-consent__permission" key={permission.capability}>
              <input
                type="checkbox"
                checked={selected.has(permission.capability)}
                onChange={(event) => {
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(permission.capability);
                    else next.delete(permission.capability);
                    return next;
                  });
                }}
              />
              <span className="local-agent-consent__permission-copy">
                <strong>{permission.label}</strong>
                <span>{permission.detail}</span>
                <code>{permission.capability}</code>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {error !== null ? <p className="local-agent-consent__error">{error}</p> : null}
      <footer className="local-agent-consent__footer">
        <p>Access can be changed or revoked later in PwrSnap Settings.</p>
        <div className="local-agent-consent__actions">
          <button type="button" disabled={submitting} onClick={() => void decide("deny")}>
            Deny
          </button>
          <button
            type="button"
            className="local-agent-consent__allow"
            disabled={submitting || selected.size === 0 || sessionName.trim().length === 0}
            onClick={() => void decide("allow")}
          >
            Allow selected
          </button>
        </div>
      </footer>
    </main>
  );
}
