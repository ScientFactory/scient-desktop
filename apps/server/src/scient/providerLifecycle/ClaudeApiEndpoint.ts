import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";

import { customClaudeApiEndpointHost } from "../../provider/Drivers/ClaudeSkills.ts";

/** Where the `ANTHROPIC_BASE_URL` that redirects Claude was set. */
export type ClaudeApiEndpointSource = "claude-settings" | "environment";

export interface ClaudeApiEndpoint {
  /** Scheme, host and port only: what Scient records and shows. */
  readonly origin: string;
  /** Origin and path, without credentials or query; used only to scrub echoed text. */
  readonly base: string;
  readonly source: ClaudeApiEndpointSource;
}

/**
 * The non-Anthropic server Claude sends its requests to, if any. Claude's own
 * settings file wins over the process environment, as it does for the CLI.
 */
export function resolveClaudeApiEndpoint(
  settingsEnv: { readonly ANTHROPIC_BASE_URL?: string | undefined },
  environment: NodeJS.ProcessEnv,
): ClaudeApiEndpoint | undefined {
  const fromSettings = settingsEnv.ANTHROPIC_BASE_URL;
  const baseUrl = fromSettings ?? environment.ANTHROPIC_BASE_URL;
  if (customClaudeApiEndpointHost(baseUrl) === undefined) return undefined;
  const url = URL.parse(baseUrl?.trim() ?? "");
  if (url === null) return undefined;
  return {
    origin: url.origin,
    base: `${url.origin}${url.pathname.replace(/\/+$/u, "")}`,
    source: fromSettings === undefined ? "environment" : "claude-settings",
  };
}

/** Account kinds that redirect or replace Claude sign-in; seeing one proves no sign-in finished. */
export const EXTERNAL_PROVIDER_AUTH_TYPES: ReadonlySet<string> = new Set([
  "apiKey",
  "customEndpoint",
  "bedrock",
]);

/**
 * Marks a failed turn whose request went to a custom endpoint, for the app to name beside the
 * error. An endpoint path can hold a tenant or key, so an echo of it in the text keeps its origin.
 */
export function withClaudeApiEndpoint(
  failure: OrchestrationV2ProviderFailure | null,
  endpoint: ClaudeApiEndpoint | undefined,
): OrchestrationV2ProviderFailure | null {
  if (failure === null || endpoint === undefined) return failure;
  return {
    ...failure,
    message:
      endpoint.base === endpoint.origin
        ? failure.message
        : failure.message.replaceAll(endpoint.base, endpoint.origin),
    customEndpoint: { origin: endpoint.origin, source: endpoint.source },
  };
}
