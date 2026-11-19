import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";

import { customClaudeApiEndpointHost } from "../../provider/Drivers/ClaudeSkills.ts";

/** Where the `ANTHROPIC_BASE_URL` that redirects Claude was set. */
export type ClaudeApiEndpointSource = "claude-settings" | "environment";

export interface ClaudeApiEndpoint {
  /** Scheme, host and port only: credentials, path and query never leave this module. */
  readonly origin: string;
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port?: number;
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
    scheme: url.protocol === "http:" ? "http" : "https",
    host: url.hostname,
    ...(url.port === "" ? {} : { port: Number(url.port) }),
    source: fromSettings === undefined ? "environment" : "claude-settings",
  };
}

/** Account kinds that redirect or replace Claude sign-in; seeing one proves no sign-in finished. */
export const EXTERNAL_PROVIDER_AUTH_TYPES: ReadonlySet<string> = new Set([
  "apiKey",
  "customEndpoint",
  "bedrock",
]);

/** Marks a failed turn whose request went to a custom endpoint; the app names it beside the error. */
export function withClaudeApiEndpoint(
  failure: OrchestrationV2ProviderFailure | null,
  endpoint: ClaudeApiEndpoint | undefined,
): OrchestrationV2ProviderFailure | null {
  if (failure === null || endpoint === undefined) return failure;
  return { ...failure, customEndpoint: { origin: endpoint.origin, source: endpoint.source } };
}
