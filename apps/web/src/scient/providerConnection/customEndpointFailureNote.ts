import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

/** Says where a failed request went when a custom API endpoint replaced the vendor's. */
export function customEndpointFailureNote(
  failure: Pick<OrchestrationV2ProviderFailure, "customEndpoint">,
  resolve: MessageResolver = m,
): string | null {
  const endpoint = failure.customEndpoint;
  if (endpoint === undefined) return null;
  return endpoint.source === "claude-settings"
    ? resolve(
        msg(
          "This request went to {endpoint}, not to Anthropic. It is set by ANTHROPIC_BASE_URL in Claude's settings.",
          { endpoint: endpoint.origin },
        ),
      )
    : resolve(
        msg(
          "This request went to {endpoint}, not to Anthropic. It is set by the ANTHROPIC_BASE_URL environment variable, in this provider's settings or on this computer.",
          { endpoint: endpoint.origin },
        ),
      );
}
