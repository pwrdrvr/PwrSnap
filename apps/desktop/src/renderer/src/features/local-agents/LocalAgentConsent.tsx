import { useEffect, useState } from "react";
import type {
  LocalAgentCapability,
  LocalAgentConsentPrompt
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export function LocalAgentConsent(): React.JSX.Element {
  const [prompt, setPrompt] = useState<LocalAgentConsentPrompt | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<LocalAgentCapability>>(new Set());
  const [maxCaptureAgeDays, setMaxCaptureAgeDays] = useState<number | null>(30);
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
      setSelected(new Set());
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
      roleId: decision === "allow" ? selectedRoleId : null,
      capabilities: decision === "allow" && selectedRoleId === null ? [...selected] : [],
      ...(decision === "allow" && selectedRoleId === null ? { maxCaptureAgeDays } : {})
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
        <legend>Choose an access role</legend>
        <div className="local-agent-consent__roles">
          {prompt.roles.map((role) => (
            <label
              className={`local-agent-consent__role${selectedRoleId === role.id ? " local-agent-consent__role--selected" : ""}`}
              key={role.id}
            >
              <input
                type="radio"
                name="access-role"
                checked={selectedRoleId === role.id}
                onChange={() => setSelectedRoleId(role.id)}
              />
              <span className="local-agent-consent__role-copy">
                <span className="local-agent-consent__role-heading">
                  <strong>{role.name}</strong>
                  <span>{historyLabel(role.maxCaptureAgeDays)}</span>
                </span>
                <span>{role.description}</span>
                <small>{role.permissions.length} permission{role.permissions.length === 1 ? "" : "s"}</small>
              </span>
            </label>
          ))}
          <label
            className={`local-agent-consent__role${selectedRoleId === null && selected.size > 0 ? " local-agent-consent__role--selected" : ""}`}
          >
            <input
              type="radio"
              name="access-role"
              checked={selectedRoleId === null && selected.size > 0}
              onChange={() => {
                setSelectedRoleId(null);
                setSelected((current) => current.size > 0
                  ? current
                  : new Set(prompt.permissions
                    .filter((permission) => permission.requested)
                    .slice(0, 1)
                    .map((permission) => permission.capability)));
              }}
            />
            <span className="local-agent-consent__role-copy">
              <span className="local-agent-consent__role-heading">
                <strong>Custom role</strong>
                <span>Choose below</span>
              </span>
              <span>Pick individual permissions and a limit on how far back the agent can see.</span>
            </span>
          </label>
        </div>
      </fieldset>

      {selectedRoleId === null && selected.size > 0 ? (
        <section className="local-agent-consent__custom" aria-label="Custom role settings">
          <label className="local-agent-consent__history">
            <span>Capture history</span>
            <select
              value={maxCaptureAgeDays === null ? "all" : String(maxCaptureAgeDays)}
              disabled={submitting}
              onChange={(event) => setMaxCaptureAgeDays(
                event.target.value === "all" ? null : Number(event.target.value)
              )}
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last year</option>
              <option value="all">All time</option>
            </select>
          </label>
          <div className="local-agent-consent__permissions">
            {prompt.permissions.filter((permission) => permission.requested).map((permission) => (
              <label className="local-agent-consent__permission" key={permission.capability}>
                <input
                  type="checkbox"
                  checked={selected.has(permission.capability)}
                  disabled={submitting}
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
        </section>
      ) : null}

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
            disabled={
              submitting
              || (selectedRoleId === null && selected.size === 0)
              || sessionName.trim().length === 0
            }
            onClick={() => void decide("allow")}
          >
            Allow access
          </button>
        </div>
      </footer>
    </main>
  );
}

function historyLabel(maxCaptureAgeDays: number | null): string {
  if (maxCaptureAgeDays === null) return "All time";
  if (maxCaptureAgeDays === 365) return "Last year";
  return `Last ${maxCaptureAgeDays} days`;
}
