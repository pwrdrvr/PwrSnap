import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type {
  LocalAgentAuditEntry,
  LocalAgentCapability,
  LocalAgentClientGrant
} from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import { Card, Row } from "../components";
import { useSettingsContext } from "../SettingsContext";

const CAPABILITY_LABELS: Record<LocalAgentCapability, string> = {
  "library.read": "Library search",
  "capture.composite.read": "Edited previews",
  "capture.original.read": "Original images",
  "capture.export": "Exports",
  "capture.edit": "Image edits",
  "trash.write": "Move to Trash",
  "sizzle.compose": "Sizzle compose",
  "sizzle.preview.read": "Sizzle previews",
  "sizzle.full.read": "Full Sizzle renders"
};

const SENSITIVE_CAPABILITIES = new Set<LocalAgentCapability>([
  "capture.original.read",
  "sizzle.full.read",
  "trash.write"
]);

export function LocalAgentsPage(): ReactElement {
  const { settings } = useSettingsContext();
  const [grants, setGrants] = useState<LocalAgentClientGrant[]>([]);
  const [audit, setAudit] = useState<LocalAgentAuditEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const [result, auditResult] = await Promise.all([
      dispatch("localAgents:list", {}),
      dispatch("localAgents:audit", { limit: 50 })
    ]);
    if (result.ok) {
      setGrants(result.value.grants);
      setError(null);
    } else {
      setError(result.error.message);
    }
    if (auditResult.ok) {
      setAudit(auditResult.value.entries);
    } else {
      setError(auditResult.error.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load, settings?.localAgents.grants, settings?.localAgents.audit]);

  const activeCount = useMemo(
    () => grants.filter((grant) => grant.revokedAt === null).length,
    [grants]
  );

  const revoke = async (id: string): Promise<void> => {
    setRevokingId(id);
    const result = await dispatch("localAgents:revoke", { id });
    if (result.ok) {
      setGrants((current) => current.map((grant) => grant.id === id ? result.value : grant));
      setError(null);
    } else {
      setError(result.error.message);
    }
    setRevokingId(null);
  };

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">Local agents</h1>
          <p className="pss__main-sub">
            Paired agents can search PwrSnap and request media through scoped
            local grants. Original images and full renders stay separate from
            edited previews.
          </p>
        </div>
        <div className="pss__main-actions">
          <span className="pss__main-count" aria-live="polite">
            {activeCount} active
          </span>
        </div>
      </div>

      <Card eyebrow="ACCESS" title="Paired clients">
        {loading ? (
          <Row label="Loading" sub="Reading local-agent grants.">
            <span className="pss__badge">loading</span>
          </Row>
        ) : grants.length === 0 ? (
          <Row
            label="No paired agents"
            sub="A native PwrSnap approval prompt opens when a local agent requests access."
          >
            <span className="pss__badge">none</span>
          </Row>
        ) : (
          grants.map((grant) => (
            <LocalAgentGrantRow
              key={grant.id}
              grant={grant}
              revoking={revokingId === grant.id}
              onRevoke={() => {
                void revoke(grant.id);
              }}
            />
          ))
        )}
        {error !== null ? (
          <Row label="Last error" sub={error}>
            <span className="pss__badge is-bad">error</span>
          </Row>
        ) : null}
      </Card>

      <Card eyebrow="BOUNDARY" title="Media access classes">
        <Row
          label="Edited previews"
          sub="Composite reads match what PwrSnap shows after arrows, crops, and redactions."
        >
          <span className="pss__badge">default</span>
        </Row>
        <Row
          label="Original images"
          sub="Original reads can reveal content hidden by edits, so they require a separate grant."
        >
          <span className="pss__badge is-warn">sensitive</span>
        </Row>
        <Row
          label="Trash"
          sub="External agents may only move captures to PwrSnap Trash. Permanent purge is not exposed."
        >
          <span className="pss__badge">soft delete</span>
        </Row>
      </Card>

      <Card eyebrow="ACTIVITY" title="Recent sensitive access">
        {audit.length === 0 ? (
          <Row
            label="No sensitive activity"
            sub="Original reads, exports, edits, Trash moves, and Sizzle renders appear here."
          >
            <span className="pss__badge">none</span>
          </Row>
        ) : (
          audit.map((entry) => (
            <Row
              key={entry.id}
              label={auditActionLabel(entry)}
              sub={`${grantName(entry.clientId, grants)} · ${entry.subjectId} · ${formatDate(entry.occurredAt)}`}
            >
              <span className={"pss__badge" + (entry.outcome === "failure" ? " is-bad" : "")}>
                {entry.outcome}
              </span>
            </Row>
          ))
        )}
      </Card>
    </>
  );
}

function grantName(
  clientId: string,
  grants: readonly LocalAgentClientGrant[]
): string {
  return grants.find((grant) => grant.id === clientId)?.name ?? clientId;
}

function auditActionLabel(entry: LocalAgentAuditEntry): string {
  switch (entry.action) {
    case "capture.original.read":
      return "Original image read";
    case "capture.export":
      return "Capture exported";
    case "capture.edit":
      return "Image edit requested";
    case "trash.write":
      return "Capture moved to Trash";
    case "sizzle.preview.read":
      return "Sizzle preview rendered";
    case "sizzle.full.read":
      return "Full Sizzle rendered";
  }
}

function LocalAgentGrantRow({
  grant,
  revoking,
  onRevoke
}: {
  grant: LocalAgentClientGrant;
  revoking: boolean;
  onRevoke: () => void;
}): ReactElement {
  const revoked = grant.revokedAt !== null;
  const hasSensitive = grant.capabilities.some((capability) =>
    SENSITIVE_CAPABILITIES.has(capability)
  );
  const sub = [
    `Created ${formatDate(grant.createdAt)}`,
    grant.lastUsedAt !== null ? `last used ${formatDate(grant.lastUsedAt)}` : "never used",
    grant.revokedAt !== null ? `revoked ${formatDate(grant.revokedAt)}` : null
  ].filter((value): value is string => value !== null).join(" · ");

  return (
    <Row label={grant.name} sub={sub} tag={revoked ? "revoked" : "paired"}>
      <div className="pss__agent-row">
        <div className="pss__agent-caps">
          {grant.capabilities.map((capability) => (
            <span
              key={capability}
              className={
                "pss__badge" + (SENSITIVE_CAPABILITIES.has(capability) ? " is-warn" : "")
              }
            >
              {CAPABILITY_LABELS[capability]}
            </span>
          ))}
          {hasSensitive ? <span className="pss__badge is-bad">sensitive</span> : null}
        </div>
        <button
          type="button"
          className="pss__key-btn is-danger"
          disabled={revoked || revoking}
          onClick={onRevoke}
        >
          {revoking ? "Revoking" : revoked ? "Revoked" : "Revoke"}
        </button>
      </div>
    </Row>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
