import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from "react";
import {
  LOCAL_AGENT_CAPABILITIES,
  LOCAL_AGENT_CAPABILITY_DANGER,
  type LocalAgentAuditEntry,
  type LocalAgentCapability,
  type LocalAgentClientGrant,
  type LocalAgentMcpListenerStatus,
  type LocalAgentRoleBudgets,
  type LocalAgentRoleProfile,
  type LocalAgentUsageAction,
  type LocalAgentUsageSnapshot
} from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import { Card, Row, Switch } from "../components";
import { useSettingsContext } from "../SettingsContext";

const CAPABILITY_LABELS: Record<LocalAgentCapability, string> = {
  "library.read": "Search library",
  "capture.composite.read": "Read edited previews",
  "capture.original.read": "Read original images",
  "capture.export": "Export captures",
  "capture.edit": "Edit images",
  "trash.write": "Move to Trash",
  "sizzle.compose": "Compose Sizzles",
  "sizzle.preview.read": "Read Sizzle previews",
  "sizzle.full.read": "Read full Sizzles"
};

const CAPABILITY_DETAILS: Record<LocalAgentCapability, string> = {
  "library.read": "Search capture metadata inside the role's history limit.",
  "capture.composite.read": "Fetch pixels after PwrSnap edits and redactions.",
  "capture.original.read": "Fetch original pixels that may bypass visible redactions.",
  "capture.export": "Create a shareable capture export.",
  "capture.edit": "Change a capture through PwrSnap-owned edit commands.",
  "trash.write": "Move a capture to recoverable PwrSnap Trash.",
  "sizzle.compose": "Create and update Sizzle compositions.",
  "sizzle.preview.read": "Render preview-quality Sizzle media.",
  "sizzle.full.read": "Render full-resolution Sizzle media."
};

const USAGE_ACTIONS = [
  "search",
  "preview.read",
  "original.read",
  "edit",
  "delete"
] as const satisfies readonly LocalAgentUsageAction[];

const USAGE_LABELS: Record<LocalAgentUsageAction, string> = {
  search: "Searches",
  "preview.read": "Preview images",
  "original.read": "Full-res images",
  edit: "Edits",
  delete: "Trash moves"
};

const LOCAL_AGENT_MCP_URL = "http://127.0.0.1:51729/mcp";

type GraphPath = {
  id: string;
  d: string;
  kind: "allow" | "reject";
  highlighted: boolean;
};

type RoleDraft = {
  id: string | null;
  name: string;
  description: string;
  permissions: LocalAgentCapability[];
  maxCaptureAgeDays: string;
  budgets: Record<LocalAgentUsageAction, { limit: string; windowHours: string }>;
};

export function LocalAgentsPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const [grants, setGrants] = useState<LocalAgentClientGrant[]>([]);
  const [roles, setRoles] = useState<LocalAgentRoleProfile[]>([]);
  const [audit, setAudit] = useState<LocalAgentAuditEntry[]>([]);
  const [usage, setUsage] = useState<LocalAgentUsageSnapshot[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<RoleDraft | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [togglingAccess, setTogglingAccess] = useState<boolean>(false);
  const [listenerStatus, setListenerStatus] = useState<LocalAgentMcpListenerStatus>({
    state: "off"
  });
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmDeleteRoleId, setConfirmDeleteRoleId] = useState<string | null>(null);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<GraphPath[]>([]);
  const mcpEnabled = settings?.localAgents.enabled ?? false;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const [result, auditResult] = await Promise.all([
      dispatch("localAgents:list", {}),
      dispatch("localAgents:audit", { limit: 50 })
    ]);
    if (result.ok) {
      setGrants(result.value.grants);
      setRoles(result.value.roles);
      setListenerStatus(result.value.listenerStatus);
      setSelectedSessionId((current) =>
        current !== null && result.value.grants.some((grant) => grant.id === current)
          ? current
          : result.value.grants.find((grant) => grant.revokedAt === null)?.id ??
            result.value.grants[0]?.id ??
            null
      );
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

  const setMcpEnabled = async (enabled: boolean): Promise<void> => {
    setTogglingAccess(true);
    try {
      await patch({ localAgents: { enabled } });
      await load();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTogglingAccess(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load, settings?.localAgents.grants, settings?.localAgents.roles, settings?.localAgents.audit]);

  const selectedSession = useMemo(
    () => grants.find((grant) => grant.id === selectedSessionId) ?? null,
    [grants, selectedSessionId]
  );

  useEffect(() => {
    if (selectedSession?.roleId !== undefined) {
      setSelectedRoleId(selectedSession.roleId);
    }
  }, [selectedSession]);

  const selectedRole = useMemo(
    () => roles.find((role) => role.id === selectedRoleId) ?? null,
    [roles, selectedRoleId]
  );

  useEffect(() => {
    if (selectedSessionId === null) {
      setUsage([]);
      return;
    }
    let current = true;
    void dispatch("localAgents:usage", { sessionId: selectedSessionId }).then((result) => {
      if (!current) return;
      if (result.ok) setUsage(result.value.entries);
      else setUsage([]);
    });
    return () => {
      current = false;
    };
  }, [selectedSessionId, selectedRoleId]);

  const registerNode = useCallback((id: string, node: HTMLElement | null): void => {
    if (node === null) nodeRefs.current.delete(id);
    else nodeRefs.current.set(id, node);
  }, []);

  const recalculatePaths = useCallback((): void => {
    const graph = graphRef.current;
    if (graph === null) return;
    const graphRect = graph.getBoundingClientRect();
    const next: GraphPath[] = [];
    const connect = (
      id: string,
      fromId: string,
      toId: string,
      kind: GraphPath["kind"],
      highlighted: boolean
    ): void => {
      const from = nodeRefs.current.get(fromId)?.getBoundingClientRect();
      const to = nodeRefs.current.get(toId)?.getBoundingClientRect();
      if (from === undefined || to === undefined) return;
      const x1 = from.right - graphRect.left;
      const y1 = from.top + from.height / 2 - graphRect.top;
      const x2 = to.left - graphRect.left;
      const y2 = to.top + to.height / 2 - graphRect.top;
      const bend = Math.max(28, (x2 - x1) * 0.48);
      next.push({
        id,
        d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        kind,
        highlighted
      });
    };

    for (const grant of grants) {
      const roleExists = grant.roleId !== undefined && roles.some((role) => role.id === grant.roleId);
      if (grant.revokedAt !== null || !roleExists) {
        connect(
          `session-reject:${grant.id}`,
          `session:${grant.id}`,
          "reject",
          "reject",
          grant.id === selectedSessionId
        );
      } else {
        connect(
          `session-role:${grant.id}:${grant.roleId}`,
          `session:${grant.id}`,
          `role:${grant.roleId}`,
          "allow",
          grant.id === selectedSessionId
        );
      }
    }
    for (const role of roles) {
      for (const permission of role.permissions) {
        connect(
          `role-permission:${role.id}:${permission}`,
          `role:${role.id}`,
          `permission:${permission}`,
          "allow",
          role.id === selectedRoleId
        );
      }
    }
    setPaths(next);
  }, [grants, roles, selectedRoleId, selectedSessionId]);

  useLayoutEffect(() => {
    recalculatePaths();
    const graph = graphRef.current;
    if (graph === null) return;
    const observer = new ResizeObserver(recalculatePaths);
    observer.observe(graph);
    for (const node of nodeRefs.current.values()) observer.observe(node);
    window.addEventListener("resize", recalculatePaths);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", recalculatePaths);
    };
  }, [recalculatePaths, roleDraft]);

  const activeCount = useMemo(
    () => grants.filter((grant) => grant.revokedAt === null).length,
    [grants]
  );

  const listenerCopy = !mcpEnabled
    ? { badge: "MCP off", tag: "off" }
    : listenerStatus.state === "listening"
      ? { badge: LOCAL_AGENT_MCP_URL, tag: "listening on loopback" }
      : listenerStatus.state === "starting"
        ? { badge: "MCP starting", tag: "starting" }
        : listenerStatus.state === "stopping"
          ? { badge: "MCP stopping", tag: "stopping" }
          : listenerStatus.state === "failed"
            ? { badge: "MCP unavailable", tag: "failed to start" }
            : { badge: "MCP unavailable", tag: "not listening" };

  const assignRole = async (sessionId: string, roleId: string): Promise<void> => {
    setSaving(true);
    const result = await dispatch("localAgents:assignRole", { sessionId, roleId });
    if (result.ok) {
      setGrants((current) => current.map((grant) => grant.id === sessionId ? result.value : grant));
      setSelectedSessionId(sessionId);
      setSelectedRoleId(roleId);
      setError(null);
    } else {
      setError(result.error.message);
    }
    setSaving(false);
  };

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

  const saveRole = async (): Promise<void> => {
    if (roleDraft === null) return;
    const parsed = parseRoleDraft(roleDraft);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSaving(true);
    const result = roleDraft.id === null
      ? await dispatch("localAgents:roleCreate", parsed.value)
      : await dispatch("localAgents:roleUpdate", {
          id: roleDraft.id,
          patch: parsed.value
        });
    if (result.ok) {
      setRoles((current) => roleDraft.id === null
        ? [...current, result.value]
        : current.map((role) => role.id === result.value.id ? result.value : role));
      setSelectedRoleId(result.value.id);
      setRoleDraft(null);
      setError(null);
    } else {
      setError(result.error.message);
    }
    setSaving(false);
  };

  const deleteRole = async (roleId: string): Promise<void> => {
    if (confirmDeleteRoleId !== roleId) {
      setConfirmDeleteRoleId(roleId);
      return;
    }
    setSaving(true);
    const result = await dispatch("localAgents:roleDelete", { id: roleId });
    if (result.ok) {
      setRoles((current) => current.filter((role) => role.id !== roleId));
      setSelectedRoleId(null);
      setRoleDraft(null);
      setConfirmDeleteRoleId(null);
      setError(null);
    } else {
      setError(result.error.message);
    }
    setSaving(false);
  };

  return (
    <>
      <div className="pss__main-hdr pss__main-hdr--agents">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Access control</div>
          <h1 className="pss__main-title">Authorization graph</h1>
          <p className="pss__main-sub">
            Bind each named MCP Session to one role. Permissions are additive inside a
            role; history and sliding-window limits narrow how much an agent can see or do.
            Click a Session or role to trace its path.
          </p>
        </div>
        <div className="pss__main-actions">
          <span className="pss__main-count" aria-live="polite">{activeCount} approved</span>
          <span className={`pss__badge${listenerStatus.state === "listening" ? " is-accent" : ""}`}>
            {listenerCopy.badge}
          </span>
        </div>
      </div>

      <Card eyebrow="LOCAL AGENT ACCESS" title="MCP server">
        <Row
          label="Enable local-agent access"
          sub="When off, PwrSnap does not listen for MCP connections. Saved Sessions and roles remain available. When on, every connection still requires native approval and an assigned RBAC role."
          tag={listenerCopy.tag}
        >
          <Switch
            on={mcpEnabled}
            onChange={
              settings === null || togglingAccess
                ? undefined
                : (enabled) => void setMcpEnabled(enabled)
            }
          />
        </Row>
      </Card>

      <div className="pss__auth-legend" aria-label="Authorization graph legend">
        <span><i className="is-allow" /> allowed path</span>
        <span><i className="is-reject" /> rejected Session</span>
        <button type="button" className="pss__key-btn" onClick={() => setRoleDraft(newRoleDraft(selectedRole))}>
          + New custom role
        </button>
      </div>

      <section className="pss__auth-shell">
        {loading ? <div className="pss__auth-empty">Loading authorization policy…</div> : (
          <div className="pss__auth-scroll">
            <div className="pss__auth-graph" ref={graphRef}>
              <svg className="pss__auth-lines" aria-hidden="true">
                {paths.map((path) => (
                  <path
                    key={path.id}
                    d={path.d}
                    className={`is-${path.kind}${path.highlighted ? " is-highlighted" : ""}`}
                  />
                ))}
              </svg>

              <GraphColumn title="Sessions" count={grants.length}>
                {grants.length === 0 ? (
                  <div className="pss__auth-empty">No approved MCP Sessions yet.</div>
                ) : grants.map((grant) => {
                  const role = roles.find((item) => item.id === grant.roleId);
                  const revoked = grant.revokedAt !== null;
                  const rejected = revoked || role === undefined;
                  return (
                    <article
                      key={grant.id}
                      ref={(node) => registerNode(`session:${grant.id}`, node)}
                      className={`pss__auth-node is-session${grant.id === selectedSessionId ? " is-selected" : ""}${rejected ? " is-rejected" : ""}`}
                      onClick={() => setSelectedSessionId(grant.id)}
                    >
                      <div className="pss__auth-node-top">
                        <span className="pss__auth-node-icon">{rejected ? "×" : "S"}</span>
                        <div>
                          <h3>{grant.name}</h3>
                          <p>{grant.oauthClient?.clientName ?? "MCP client"} · self-reported</p>
                        </div>
                        <span className={`pss__badge${revoked ? " is-danger" : " is-accent"}`}>
                          {revoked ? "revoked" : "active"}
                        </span>
                      </div>
                      <select
                        className="pss__auth-select"
                        aria-label={`Role for ${grant.name}`}
                        value={role?.id ?? ""}
                        disabled={revoked || saving}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          void assignRole(grant.id, event.target.value);
                        }}
                      >
                        <option value="" disabled>No valid role</option>
                        {roles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                      <div className="pss__auth-node-meta">
                        <span>{grant.lastUsedAt === null ? "Never used" : `Used ${formatDate(grant.lastUsedAt)}`}</span>
                        <button
                          type="button"
                          disabled={revoked || revokingId === grant.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            void revoke(grant.id);
                          }}
                        >
                          {revokingId === grant.id ? "Revoking…" : "Revoke"}
                        </button>
                      </div>
                    </article>
                  );
                })}
                <div ref={(node) => registerNode("reject", node)} className="pss__auth-end-state">
                  <span>×</span>
                  <div><b>Rejected</b><small>Revoked or invalid role</small></div>
                </div>
              </GraphColumn>

              <GraphColumn title="PwrSnap roles" count={roles.length}>
                {roles.map((role) => (
                  <article
                    key={role.id}
                    ref={(node) => registerNode(`role:${role.id}`, node)}
                    className={`pss__auth-node is-role${role.id === selectedRoleId ? " is-selected" : ""}`}
                    onClick={() => setSelectedRoleId(role.id)}
                  >
                    <div className="pss__auth-node-top">
                      <span className="pss__auth-node-icon">{role.permissions.some((permission) => LOCAL_AGENT_CAPABILITY_DANGER[permission] === "destructive") ? "!" : "R"}</span>
                      <div>
                        <h3>{role.name}</h3>
                        <p>{role.description}</p>
                      </div>
                      <span className="pss__badge">{role.builtIn ? "built-in" : "custom"}</span>
                    </div>
                    <div className="pss__auth-node-meta">
                      <span>{historyLabel(role.maxCaptureAgeDays)} · {role.permissions.length} permissions</span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setRoleDraft(newRoleDraft(role, role.builtIn));
                        }}
                      >
                        {role.builtIn ? "Duplicate" : "Edit"}
                      </button>
                    </div>
                  </article>
                ))}
              </GraphColumn>

              <GraphColumn title="Permissions & limits" count={LOCAL_AGENT_CAPABILITIES.length}>
                <div className="pss__auth-constraint">
                  <span>History</span>
                  <b>{selectedRole === null ? "Select a role" : historyLabel(selectedRole.maxCaptureAgeDays)}</b>
                </div>
                {LOCAL_AGENT_CAPABILITIES.map((permission) => {
                  const allowed = selectedRole?.permissions.includes(permission) === true;
                  const danger = LOCAL_AGENT_CAPABILITY_DANGER[permission];
                  return (
                    <article
                      key={permission}
                      ref={(node) => registerNode(`permission:${permission}`, node)}
                      className={`pss__auth-node is-permission${allowed ? " is-allowed" : " is-denied"}`}
                    >
                      <span className={`pss__auth-check is-${danger}`}>{allowed ? "✓" : "—"}</span>
                      <div>
                        <h3>{CAPABILITY_LABELS[permission]}</h3>
                        <p>{CAPABILITY_DETAILS[permission]}</p>
                      </div>
                    </article>
                  );
                })}
              </GraphColumn>
            </div>
          </div>
        )}
      </section>

      {selectedSession !== null && selectedRole !== null ? (
        <Card eyebrow="LIVE SCOPE" title={`${selectedSession.name} · ${selectedRole.name}`}>
          <Row
            label="Capture history"
            sub="Searches and direct resource reads are checked against this moving horizon."
          >
            <span className="pss__badge is-accent">{historyLabel(selectedRole.maxCaptureAgeDays)}</span>
          </Row>
          <div className="pss__usage-grid">
            {USAGE_ACTIONS.map((action) => {
              const snapshot = usage.find((entry) => entry.action === action);
              const budget = selectedRole.budgets[action];
              const used = snapshot?.used ?? 0;
              const limit = snapshot?.limit ?? budget.limit;
              return (
                <div key={action} className="pss__usage-item">
                  <div><span>{USAGE_LABELS[action]}</span><b>{used} / {limit}</b></div>
                  <div className="pss__usage-track"><i style={{ width: `${Math.min(100, used / limit * 100)}%` }} /></div>
                  <small>rolling {formatWindow(snapshot?.windowSeconds ?? budget.windowSeconds)}</small>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {roleDraft !== null ? (
        <RoleEditor
          draft={roleDraft}
          saving={saving}
          confirmDelete={roleDraft.id !== null && confirmDeleteRoleId === roleDraft.id}
          onChange={setRoleDraft}
          onCancel={() => {
            setRoleDraft(null);
            setConfirmDeleteRoleId(null);
          }}
          onSave={() => void saveRole()}
          {...(roleDraft.id === null
            ? {}
            : { onDelete: () => void deleteRole(roleDraft.id as string) })}
        />
      ) : null}

      {error !== null ? (
        <div className="pss__auth-error" role="alert"><b>Local agent update failed</b><span>{error}</span></div>
      ) : null}

      <Card eyebrow="ACTIVITY" title="Recent agent actions" defaultCollapsed>
        {audit.length === 0 ? (
          <Row label="No agent activity" sub="Protected media and mutation actions appear here.">
            <span className="pss__badge">none</span>
          </Row>
        ) : audit.map((entry) => (
          <Row
            key={entry.id}
            label={auditActionLabel(entry)}
            sub={`${grantName(entry.clientId, grants)} · ${entry.subjectId} · ${formatDate(entry.occurredAt)}`}
          >
            <span className={`pss__badge${entry.outcome === "failure" ? " is-danger" : ""}`}>{entry.outcome}</span>
          </Row>
        ))}
      </Card>
    </>
  );
}

function GraphColumn({
  title,
  count,
  children
}: {
  title: string;
  count: number;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="pss__auth-column">
      <div className="pss__auth-column-hdr"><span>{title}</span><b>{count}</b></div>
      <div className="pss__auth-column-body">{children}</div>
    </div>
  );
}

function RoleEditor({
  draft,
  saving,
  confirmDelete,
  onChange,
  onCancel,
  onSave,
  onDelete
}: {
  draft: RoleDraft;
  saving: boolean;
  confirmDelete: boolean;
  onChange: (draft: RoleDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
}): ReactElement {
  const updateBudget = (
    action: LocalAgentUsageAction,
    field: "limit" | "windowHours",
    value: string
  ): void => {
    onChange({
      ...draft,
      budgets: {
        ...draft.budgets,
        [action]: { ...draft.budgets[action], [field]: value }
      }
    });
  };

  return (
    <section className="pss__role-editor">
      <div className="pss__role-editor-hdr">
        <div><span>Custom role</span><h2>{draft.id === null ? "Create role" : "Edit role"}</h2></div>
        <button type="button" onClick={onCancel} aria-label="Close role editor">×</button>
      </div>
      <div className="pss__role-editor-fields">
        <label>Name<input className="pss__input" value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
        <label>Description<input className="pss__input" value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} /></label>
        <label>
          Capture history
          <select className="pss__input" value={draft.maxCaptureAgeDays} onChange={(event) => onChange({ ...draft, maxCaptureAgeDays: event.target.value })}>
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="all">All time</option>
          </select>
        </label>
      </div>
      <div className="pss__role-editor-section">
        <h3>Permissions</h3>
        <div className="pss__role-permissions">
          {LOCAL_AGENT_CAPABILITIES.map((permission) => (
            <label key={permission} className={`is-${LOCAL_AGENT_CAPABILITY_DANGER[permission]}`}>
              <input
                type="checkbox"
                checked={draft.permissions.includes(permission)}
                onChange={(event) => onChange({
                  ...draft,
                  permissions: event.target.checked
                    ? [...draft.permissions, permission]
                    : draft.permissions.filter((item) => item !== permission)
                })}
              />
              <span>{CAPABILITY_LABELS[permission]}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="pss__role-editor-section">
        <h3>Sliding-window budgets</h3>
        <div className="pss__role-budgets">
          {USAGE_ACTIONS.map((action) => (
            <div key={action}>
              <b>{USAGE_LABELS[action]}</b>
              <label>Limit<input className="pss__input" inputMode="numeric" value={draft.budgets[action].limit} onChange={(event) => updateBudget(action, "limit", event.target.value)} /></label>
              <label>Hours<input className="pss__input" inputMode="numeric" value={draft.budgets[action].windowHours} onChange={(event) => updateBudget(action, "windowHours", event.target.value)} /></label>
            </div>
          ))}
        </div>
      </div>
      <div className="pss__role-editor-actions">
        {onDelete !== undefined ? <button type="button" className="pss__key-btn is-danger" disabled={saving} onClick={onDelete}>{confirmDelete ? "Confirm delete" : "Delete role"}</button> : <span />}
        <div><button type="button" className="pss__key-btn" onClick={onCancel}>Cancel</button><button type="button" className="pss__key-btn is-primary" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save role"}</button></div>
      </div>
    </section>
  );
}

function newRoleDraft(role: LocalAgentRoleProfile | null, duplicate = true): RoleDraft {
  const source = role ?? {
    id: "",
    name: "",
    description: "",
    builtIn: false,
    permissions: ["library.read"] as LocalAgentCapability[],
    maxCaptureAgeDays: 7,
    budgets: defaultBudgets()
  };
  return {
    id: duplicate ? null : source.id,
    name: duplicate && source.name.length > 0 ? `${source.name} copy` : source.name,
    description: source.description,
    permissions: [...source.permissions],
    maxCaptureAgeDays: source.maxCaptureAgeDays === null ? "all" : String(source.maxCaptureAgeDays),
    budgets: Object.fromEntries(USAGE_ACTIONS.map((action) => [action, {
      limit: String(source.budgets[action].limit),
      windowHours: String(source.budgets[action].windowSeconds / 3600)
    }])) as RoleDraft["budgets"]
  };
}

function parseRoleDraft(draft: RoleDraft):
  | { ok: true; value: Omit<LocalAgentRoleProfile, "id" | "builtIn"> }
  | { ok: false; message: string } {
  const name = draft.name.trim();
  if (name.length === 0) return { ok: false, message: "Role name is required." };
  if (draft.permissions.length === 0) return { ok: false, message: "Select at least one permission." };
  const budgets = {} as LocalAgentRoleBudgets;
  for (const action of USAGE_ACTIONS) {
    const limit = Number(draft.budgets[action].limit);
    const windowHours = Number(draft.budgets[action].windowHours);
    if (!Number.isInteger(limit) || limit < 1) return { ok: false, message: `${USAGE_LABELS[action]} limit must be a positive whole number.` };
    if (!Number.isFinite(windowHours) || windowHours < 1 / 60) return { ok: false, message: `${USAGE_LABELS[action]} window must be at least one minute.` };
    budgets[action] = { limit, windowSeconds: Math.round(windowHours * 3600) };
  }
  return {
    ok: true,
    value: {
      name,
      description: draft.description.trim(),
      permissions: [...draft.permissions],
      maxCaptureAgeDays: draft.maxCaptureAgeDays === "all" ? null : Number(draft.maxCaptureAgeDays),
      budgets
    }
  };
}

function defaultBudgets(): LocalAgentRoleBudgets {
  const windowSeconds = 24 * 60 * 60;
  return {
    search: { limit: 50, windowSeconds },
    "preview.read": { limit: 200, windowSeconds },
    "original.read": { limit: 25, windowSeconds },
    edit: { limit: 25, windowSeconds },
    delete: { limit: 10, windowSeconds }
  };
}

function historyLabel(days: number | null): string {
  return days === null ? "All capture history" : `Last ${days} days`;
}

function formatWindow(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "24 hours" : `${days} days`;
  }
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

function grantName(clientId: string, grants: readonly LocalAgentClientGrant[]): string {
  return grants.find((grant) => grant.id === clientId)?.name ?? clientId;
}

function auditActionLabel(entry: LocalAgentAuditEntry): string {
  switch (entry.action) {
    case "capture.original.read": return "Original image read";
    case "capture.export": return "Capture exported";
    case "capture.edit": return "Image edit requested";
    case "trash.write": return "Capture moved to Trash";
    case "sizzle.preview.read": return "Sizzle preview rendered";
    case "sizzle.full.read": return "Full Sizzle rendered";
  }
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
