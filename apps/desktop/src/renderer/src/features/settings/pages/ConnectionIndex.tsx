// AI Providers hub → Direct API card: one row per connection, same order
// and same status as the sidebar children (both render the
// `AiProvidersContext` connection statuses).

import type { ReactElement } from "react";
import { monogram, whereLabel, type ConnectionStatus } from "../direct-api-status";
import { statusBadgeClass } from "../ai-provider-status";

export function ConnectionIndex({
  connections,
  onOpen
}: {
  connections: readonly ConnectionStatus[];
  onOpen: (sub: string) => void;
}): ReactElement {
  return (
    <div className="pss__prov-index">
      {connections.map((status) => {
        const where = whereLabel(status.connection.baseUrl);
        return (
          <button
            key={status.sub}
            type="button"
            className="pss__prov-row"
            onClick={() => onOpen(status.sub)}
          >
            <span aria-hidden="true" className="pss__dapi-mono">
              {monogram(status.label)}
            </span>
            <span className="pss__prov-text">
              <span className="pss__prov-name pss__dapi-name">
                <span>{status.label}</span>
                <span className={"pss__dapi-cap" + (where.local ? " is-local" : "")}>{where.text}</span>
              </span>
              <span className="pss__prov-meta" title={status.meta}>
                {status.meta}
              </span>
              {status.models.length > 0 ? (
                <span className="pss__dapi-chips">
                  {status.models.map((m) => (
                    <span key={m.id} className="pss__dapi-mchip" title={m.modelId}>
                      {m.displayName}
                      {m.capabilities.vision === true ? (
                        <span className="pss__dapi-img" title="Accepts images">
                          IMG
                        </span>
                      ) : null}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
            <span className={"pss__badge" + statusBadgeClass(status.tone)}>{status.badge}</span>
            <span className="pss__prov-chev" aria-hidden="true">
              ›
            </span>
          </button>
        );
      })}
    </div>
  );
}
