// Codex model listing for Settings + chat model pickers.
//
// This is intentionally separate from CaptureEnrichmentClient. Model listing
// is a general Codex App Server capability, not a capture-enrichment turn, and
// it must not share/close the one-shot enrichment worker while enrichment is
// running.

import { CodexOneShotClient } from "@pwrdrvr/agent-client";
import type { CodexModelOption } from "@pwrsnap/shared";
import {
  PWRSNAP_CLIENT_NAME,
  PWRSNAP_CLIENT_TITLE,
  PWRSNAP_SERVICE_NAME,
  toAgentKitLogger
} from "./agent-kit-bindings";

export type CodexModelLister = (input: {
  command: string;
  env: NodeJS.ProcessEnv;
  includeHidden: boolean;
}) => Promise<CodexModelOption[]>;

export const listCodexModels: CodexModelLister = async ({
  command,
  env,
  includeHidden
}) => {
  const client = new CodexOneShotClient({
    command,
    env,
    clientName: PWRSNAP_CLIENT_NAME,
    clientTitle: PWRSNAP_CLIENT_TITLE,
    serviceName: PWRSNAP_SERVICE_NAME,
    logger: toAgentKitLogger("pwrsnap:codex-models")
  });
  try {
    const models = await client.listModels({ includeHidden });
    return models.map((model) => ({
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      hidden: model.hidden,
      inputModalities: model.inputModalities as Array<"text" | "image">,
      defaultServiceTier: model.defaultServiceTier,
      isDefault: model.isDefault
    }));
  } finally {
    await client.close();
  }
};
