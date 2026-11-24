// AI Providers hub → Jobs: what each job runs on, read from the same
// settings AI Features writes, with the way there. The providers hub used
// to say only "pick which one does each job in AI Features", so whether an
// installed provider did anything at all was a question for another page.

import type { ReactElement } from "react";
import type { AcpAgentModelOption, AiSurfaceId, Settings } from "@pwrsnap/shared";
import { APPLE_FM_SETTINGS_SUB, connectionIdOfSettingsSub } from "@pwrsnap/shared";
import { Card } from "../components";
import {
  acpAgentIdOfProvider,
  AI_SURFACE_LABELS,
  type AiProviderStatus,
  type JobRunner
} from "../ai-provider-status";
import type { ConnectionStatus } from "../direct-api-status";
import { setActivePage } from "../useActivePage";

export function JobsSummaryCard({
  settings,
  runners,
  statuses,
  connections,
  acpModels
}: {
  settings: Settings | null;
  runners: readonly JobRunner[];
  statuses: readonly AiProviderStatus[];
  connections: readonly ConnectionStatus[];
  acpModels: Readonly<Record<string, readonly AcpAgentModelOption[]>>;
}): ReactElement {
  const nameOf = (sub: string): string =>
    statuses.find((s) => s.sub === sub)?.label ??
    connections.find((c) => c.sub === sub)?.label ??
    (sub === "codex" ? "Codex" : sub);

  /** What a primary runs, beside the provider's name. */
  const detailOf = (surface: AiSurfaceId, sub: string): string => {
    if (sub === APPLE_FM_SETTINGS_SUB) return "on this Mac";
    const value = settings?.ai.defaults[surface] ?? {};
    const model = value.model ?? "";
    if (connectionIdOfSettingsSub(sub) !== null) {
      const id = value.provider?.slice("custom:".length);
      return settings?.ai.customModels?.find((m) => m.id === id)?.displayName ?? "";
    }
    const agentId = acpAgentIdOfProvider(value.provider);
    if (agentId !== null && agentId === sub) {
      const models = acpModels[agentId] ?? [];
      const picked = model !== "" ? models.find((m) => m.id === model) : models.find((m) => m.isDefault === true);
      if (picked !== undefined) return model !== "" ? picked.label : `default · ${picked.label}`;
      return model !== "" ? model : "default model";
    }
    return model !== "" ? model : "default model";
  };

  /** The fallback by its model when it is a Direct API model — a
   *  connection can serve several — else by its provider. */
  const fallbackName = (sub: string): string => {
    const provider = settings?.ai.enrichmentFallback?.provider;
    const model = provider?.startsWith("custom:") === true
      ? settings?.ai.customModels?.find((m) => m.id === provider.slice("custom:".length))
      : undefined;
    return model !== undefined ? `${model.displayName} · ${nameOf(sub)}` : nameOf(sub);
  };

  // Every job, even one whose saved Direct API model is gone (no runner):
  // that row says so rather than vanishing.
  const surfaces = Object.keys(AI_SURFACE_LABELS) as AiSurfaceId[];
  return (
    <Card
      eyebrow="IN USE"
      title="Jobs"
      headerAction={
        <button
          className="pss__top-btn"
          type="button"
          onClick={() => {
            setActivePage("ai-features", "default-agents");
          }}
        >
          Change in AI Features
        </button>
      }
    >
      <div className="pss__card-pad">
        <ul className="pss__jobs-summary">
          {surfaces.map((surface) => {
            const primary = runners.find((r) => r.surface === surface && r.role === "primary");
            const fallback = runners.find((r) => r.surface === surface && r.role === "fallback");
            return (
              <li key={surface} className="pss__jobs-summary-row">
                <span className="pss__jobs-summary-job">{AI_SURFACE_LABELS[surface]}</span>
                <span className="pss__jobs-summary-arrow" aria-hidden="true">
                  →
                </span>
                <span className="pss__jobs-summary-who">
                  {primary !== undefined ? (
                    <>
                      <button
                        type="button"
                        className="pss__text-link pss__jobs-summary-name"
                        onClick={() => {
                          setActivePage("ai", primary.sub);
                        }}
                      >
                        {nameOf(primary.sub)}
                      </button>
                      <span className="pss__jobs-summary-model">{detailOf(surface, primary.sub)}</span>
                    </>
                  ) : (
                    <span className="pss__jobs-summary-model">No provider</span>
                  )}
                  {fallback !== undefined ? (
                    <span className="pss__jobs-summary-fallback">
                      falls back to {fallbackName(fallback.sub)}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
